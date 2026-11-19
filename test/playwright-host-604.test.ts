import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLAYWRIGHT_BROWSERS_ENV, PLAYWRIGHT_ENDPOINT_ENV, PLAYWRIGHT_STABLE } from '../src/core/playwright-managed.js';
import { PLAYWRIGHT_NOTE_ENV, PlaywrightHost, mainCheckoutOf, osConnections } from '../src/main/playwright-host.js';
import { installPlaywrightBrowsers, linkWorktreeModules, listPlaywrightBrowsers, type PlaywrightBrowsersFs } from '../src/main/playwright-browsers.js';
import type { PlaywrightServerPorts } from '../src/main/playwright-server.js';

/** The host half of Tynn #604, over an in-memory disk: nothing is spawned, downloaded or written for real. */

const TC = join('/data', 'genie2-toolchain');
const lock = (version: string) => JSON.stringify({ packages: { 'node_modules/@playwright/test': { version } } });

/** Paths in one spelling: no drive, forward slashes (this suite also runs on Windows, where join() and resolve() say otherwise). */
const n = (p: string): string => p.replace(/^[A-Za-z]:/, '').replace(/[\\]/g, '/');

function memoryFs(initial: Record<string, string> = {}): PlaywrightBrowsersFs & { files: Record<string, string>; dirs: Set<string> } {
    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(initial)) files[n(k)] = v;
    const dirs = new Set<string>();
    const fs = {
        files, dirs,
        exists: (p: string) => n(p) in files || dirs.has(n(p)) || Object.keys(files).some((f) => f.startsWith(n(p) + '/')),
        list: (d: string) => Object.keys(files).filter((f) => f.startsWith(n(d))).map((f) => f.slice(n(d).length + 1)),
        mkdirp: (d: string) => { dirs.add(n(d)); },
        writeText: (p: string, c: string) => { files[n(p)] = c; },
        writeBytes: () => {},
        rename: () => {},
        removeTree: () => {},
        readText: (p: string) => files[n(p)] ?? null,
        size: () => 0,
    };
    return fs;
}

function serverPorts(started: string[]): PlaywrightServerPorts {
    let state: 'running' | 'stopped' = 'stopped';
    let port = 3000;
    return {
        supervisor: {
            start: (spec) => { started.push(spec.command); state = 'running'; return { id: spec.id, workspaceId: spec.workspaceId, name: spec.name, state: 'running', pid: 1, exitCode: null, restarts: 0, since: 0 }; },
            stop: () => { state = 'stopped'; return true; },
            status: (id) => ({ id, workspaceId: 'w', name: 'n', state, pid: 1, exitCode: null, restarts: 0, since: 0 }),
        },
        workspaceId: 'genie', cwd: TC, cliDir: (v) => join(TC, 'playwright', 'cli', v),
        allocatePort: () => ++port, mintToken: () => 'z'.repeat(40), now: () => 1, connections: async () => 0, idleMs: 600_000,
    };
}

function hostOver(files: Record<string, string>, opts: { optIn?: boolean; started?: string[] } = {}) {
    const fs = memoryFs(files);
    const started = opts.started ?? [];
    const links: Array<[string, string, string]> = [];
    const host = new PlaywrightHost({
        toolchainDir: TC, server: serverPorts(started), workspacePath: (id) => (id === 'ws' ? '/work/app' : id === 'wt' ? '/work/app-wt' : null),
        optIn: () => opts.optIn !== false, fs, platform: 'linux', link: (t, p, k) => { links.push([t, p, k]); },
    });
    return { host, started, links, fs };
}

/** A recorded set AND its browsers' revision folders in Genie's folder: a set is installed only when both are there (Tynn #846). */
const manifest = (sets: Record<string, string[]>) => ({
    [join(TC, 'playwright', 'sets.json')]: JSON.stringify({ sets }),
    ...Object.fromEntries([...new Set(Object.values(sets).flat())].map((b) => [join(TC, 'playwright', 'browsers', `${b}-1000`, 'INSTALLATION_COMPLETE'), ''])),
});

describe('a workspace’s Playwright variables', () => {
    it('hands a matching project the server endpoint and starts the server for it', () => {
        const { host, started } = hostOver({ '/work/app/package-lock.json': lock('1.57.0'), ...manifest({ '1.57.0': ['chromium'] }) });
        const env = host.envFor('ws');
        expect(env[PLAYWRIGHT_ENDPOINT_ENV]).toBe(`ws://127.0.0.1:3001/${'z'.repeat(40)}`);
        expect(env[PLAYWRIGHT_BROWSERS_ENV]).toBe(join(TC, 'playwright', 'browsers'));
        expect(started).toHaveLength(1);
        expect(started[0]).toContain('--host 127.0.0.1');
    });

    it('says nothing, and starts nothing, for a project that does not use Playwright', () => {
        const { host, started } = hostOver({ '/work/app/package-lock.json': JSON.stringify({ packages: {} }) });
        expect(host.envFor('ws')).toEqual({});
        expect(started).toHaveLength(0);
    });

    it('starts no server when the workspace has the setting off', () => {
        const { host, started } = hostOver({ '/work/app/package-lock.json': lock('1.57.0'), ...manifest({ '1.57.0': ['chromium'] }) }, { optIn: false });
        expect(host.envFor('ws')[PLAYWRIGHT_ENDPOINT_ENV]).toBeUndefined();
        expect(started).toHaveLength(0);
    });

    it('refuses a version Genie has no browsers for, naming that version and what it has, and starts nothing', () => {
        const { host, started } = hostOver({ '/work/app/package-lock.json': lock('1.55.1'), ...manifest({ '1.57.0': ['chromium'] }) });
        const env = host.envFor('ws');
        expect(env[PLAYWRIGHT_ENDPOINT_ENV]).toBeUndefined();
        expect(env[PLAYWRIGHT_NOTE_ENV]).toContain('1.55.1');
        expect(env[PLAYWRIGHT_NOTE_ENV]).toContain('1.57.0');
        expect(started).toHaveLength(0);
    });

    it('does not swap the running server for another project’s version: that project gets a note naming both', () => {
        const { host } = hostOver({ '/work/app/package-lock.json': lock('1.57.0'), '/work/app-wt/package-lock.json': lock('1.56.1'), ...manifest({ '1.57.0': ['chromium'], '1.56.1': ['chromium'] }) });
        expect(host.envFor('ws')[PLAYWRIGHT_ENDPOINT_ENV]).toBeDefined();
        const other = host.envFor('wt');
        expect(other[PLAYWRIGHT_ENDPOINT_ENV]).toBeUndefined();
        expect(other[PLAYWRIGHT_NOTE_ENV]).toContain('1.56.1');
        expect(other[PLAYWRIGHT_NOTE_ENV]).toContain('1.57.0');
    });

    it('knows no workspace it was not told of', () => {
        expect(hostOver({}).host.envFor('nobody')).toEqual({});
    });
});

describe('a worktree’s node_modules', () => {
    const wtGit = { '/work/app-wt/.git': 'gitdir: /work/app/.git/worktrees/wt\n', '/work/app/.git/worktrees/wt/commondir': '../..\n' };
    it('finds the main checkout from a worktree’s .git file, and none for a plain checkout', () => {
        const fs = memoryFs({ ...wtGit });
        expect(n(mainCheckoutOf('/work/app-wt', fs)!)).toBe('/work/app');
        expect(mainCheckoutOf('/work/app', memoryFs({ '/work/app/.git': '' }))).toBeNull();
    });

    it('links it to the main checkout’s when the lockfiles are identical (a junction on Windows, a symlink elsewhere)', () => {
        const fs = memoryFs({ '/work/app/package-lock.json': lock('1.57.0'), '/work/app-wt/package-lock.json': lock('1.57.0'), '/work/app/node_modules/x/index.js': '' });
        const links: Array<[string, string, string]> = [];
        const r = linkWorktreeModules('/work/app', '/work/app-wt', { platform: 'linux', fs, link: (t, p, k) => { links.push([t, p, k]); } });
        expect(r.linked).toBe(true);
        expect(links.map(([t, p, k]) => [n(t), n(p), k])).toEqual([['/work/app/node_modules', '/work/app-wt/node_modules', 'dir']]);
        const win: Array<[string, string, string]> = [];
        linkWorktreeModules('/work/app', '/work/app-wt', { platform: 'win32', fs, link: (t, p, k) => { win.push([t, p, k]); } });
        expect(win[0]![2]).toBe('junction');
    });

    it('does not link when the lockfiles differ', () => {
        const fs = memoryFs({ '/work/app/package-lock.json': lock('1.57.0'), '/work/app-wt/package-lock.json': lock('1.58.0'), '/work/app/node_modules/x/index.js': '' });
        const links: unknown[] = [];
        const r = linkWorktreeModules('/work/app', '/work/app-wt', { platform: 'linux', fs, link: (...a) => { links.push(a); } });
        expect(r.linked).toBe(false);
        expect(r.reason).toMatch(/lockfile/i);
        expect(links).toHaveLength(0);
    });

    it('links one it is handed through envFor, once, and never over an existing node_modules', () => {
        const files = { ...wtGit, '/work/app/package-lock.json': lock('1.57.0'), '/work/app-wt/package-lock.json': lock('1.57.0'), '/work/app/node_modules/x/index.js': '', ...manifest({ '1.57.0': ['chromium'] }) };
        const a = hostOver(files);
        a.host.envFor('wt');
        expect(a.links).toHaveLength(1);
        const b = hostOver({ ...files, '/work/app-wt/node_modules/y/index.js': '' });
        b.host.envFor('wt');
        expect(b.links).toHaveLength(0);
    });
});

describe('installing the browsers', () => {
    function ports(files: Record<string, string> = {}, exit = 0) {
        const fs = memoryFs(files);
        const calls: Array<{ binary: string; args: readonly string[]; env?: Readonly<Record<string, string>> }> = [];
        return { fs, calls, ports: { platform: 'linux' as const, toolchainDir: TC, fs, run: async (binary: string, args: readonly string[], options?: { readonly env?: Readonly<Record<string, string>> }) => {
            calls.push({ binary, args, ...(options?.env ? { env: options.env } : {}) });
            const pkg = args.find((a) => a.startsWith('playwright@'));
            if (args[0] === 'install' && args.includes('--prefix') && pkg) fs.writeText(join(TC, 'playwright', 'cli', pkg.slice('playwright@'.length), 'node_modules', 'playwright', 'cli.js'), '');
            return { stdout: args[0] === 'view' ? '1.57.0\n' : '', exitCode: exit };
        } } };
    }

    it('installs the version’s browsers into Genie’s one folder, then records the set', async () => {
        const r = ports();
        const out = await installPlaywrightBrowsers('1.57.0', ['chromium'], true, r.ports);
        expect(out).toEqual({ kind: 'installed', version: '1.57.0', browsers: ['chromium'] });
        const install = r.calls.find((c) => c.args.includes('chromium'))!;
        expect(install.env?.PLAYWRIGHT_BROWSERS_PATH).toBe(join(TC, 'playwright', 'browsers'));
        expect(JSON.parse(r.fs.files[n(join(TC, 'playwright', 'sets.json'))]!)).toEqual({ sets: { '1.57.0': ['chromium'] } });
    });

    it('downloads nothing the second time', async () => {
        const r = ports(manifest({ '1.57.0': ['chromium'] }));
        const out = await installPlaywrightBrowsers('1.57.0', ['chromium'], true, r.ports);
        expect(out.kind).toBe('already-installed');
        expect(r.calls).toHaveLength(0);
    });

    it('adds only the browser that is missing', async () => {
        const r = ports(manifest({ '1.57.0': ['chromium'] }));
        r.fs.writeText(join(TC, 'playwright', 'cli', '1.57.0', 'node_modules', 'playwright', 'cli.js'), '');
        await installPlaywrightBrowsers('1.57.0', ['chromium', 'firefox'], true, r.ports);
        const install = r.calls.find((c) => c.args[0]?.endsWith('cli.js'))!;
        expect(install.args.slice(1)).toEqual(['install', 'firefox']);
    });

    it('does nothing without the person’s consent', async () => {
        const r = ports();
        expect((await installPlaywrightBrowsers('1.57.0', ['chromium'], false, r.ports)).kind).toBe('refused');
        expect(r.calls).toHaveLength(0);
    });

    it('installs the STABLE version when asked for no version, and never asks the registry which is newest (Tynn #846)', async () => {
        const r = ports();
        const out = await installPlaywrightBrowsers(null, ['chromium'], true, r.ports);
        expect(out).toMatchObject({ kind: 'installed', version: PLAYWRIGHT_STABLE });
        expect(r.calls.some((c) => c.args[0] === 'view')).toBe(false);
    });

    it('lists the sets and the newest Playwright', async () => {
        const r = ports(manifest({ '1.56.1': ['chromium'], '1.57.0': ['chromium', 'firefox'] }));
        const view = await listPlaywrightBrowsers(r.ports);
        expect(view.sets.map((s) => s.version)).toEqual(['1.57.0', '1.56.1']);
        expect(view.latest).toBe('1.57.0');
        expect(view.browsersPath).toBe(join(TC, 'playwright', 'browsers'));
    });
});

describe('asking the OS who is connected', () => {
    const win = '  Proto  Local Address  Foreign Address  State\n  TCP    127.0.0.1:4444  127.0.0.1:50001  ESTABLISHED\n';
    it('reads netstat on Windows', async () => {
        expect(await osConnections(4444, 'win32', async () => ({ exitCode: 0, stdout: win }))).toBe(1);
    });
    it('falls back from ss to netstat on Linux', async () => {
        const asked: string[] = [];
        const n = await osConnections(4444, 'linux', async (binary) => { asked.push(binary); return binary === 'ss' ? { exitCode: 127, stdout: '' } : { exitCode: 0, stdout: win }; });
        expect(n).toBe(1);
        expect(asked).toEqual(['ss', 'netstat']);
    });
    it('says null, never 0, when nothing answers', async () => {
        expect(await osConnections(4444, 'linux', async () => { throw new Error('ENOENT'); })).toBeNull();
    });
});
