import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    MAX_AUTO_SETS, PLAYWRIGHT_AUTO_INSTALL_ENV, PLAYWRIGHT_NOTICE_DECK_PREFIX, PLAYWRIGHT_STABLE, PLAYWRIGHT_VERSIONS_ENV, PLAYWRIGHT_VERSION_ENV,
    autoInstallEnabled, decideInstallAsk, launchInstall, parseInstallLocations, readyVersions,
} from '../src/core/playwright-managed.js';
import { resolveDeckAnswer } from '../src/core/deck-resolve.js';
import { sharedProtocol } from '../src/core/genie-protocol.js';
import { answerDeck, type DeckAnswerPorts } from '../src/main/deck-answer.js';
import { PlaywrightInstaller, type PlaywrightInstallerPorts } from '../src/main/playwright-auto.js';
import { installPlaywrightBrowsers, listPlaywrightBrowsers, type PlaywrightBrowsersFs, type PlaywrightInstallOutcome } from '../src/main/playwright-browsers.js';
import { PLAYWRIGHT_NOTE_ENV, PlaywrightHost } from '../src/main/playwright-host.js';
import type { PlaywrightServerPorts } from '../src/main/playwright-server.js';
import { playwrightTools, type PlaywrightToolPort } from '../src/main/mcp-tools-playwright.js';
import { genieCatalog } from '../src/main/genie-catalog.js';
import { HOST_NATIVE_TOOLS } from '../src/main/mcp-host-tools.js';
import type { Caller } from '../src/main/mcp-tools.js';
import type { DeckItem } from '../src/core/deck.js';

/**
 * GENIE INSTALLS THE PLAYWRIGHT BROWSERS AGENTS NEED BY ITSELF (Tynn #846). The owner, 2026-11-17: "agents need to use what
 * is installed. genie should have been able to install it. I had to click the install button." The stable version at
 * launch when Genie has none; each version a project's lockfile pins; a version an agent asks for. Several sets side by
 * side, keyed by Playwright version, each known installed only when its browsers are really in the folder. A failure is
 * a Deck item; only what is unusually large waits for the person.
 */

const TC = join('/data', 'genie2-toolchain');
const BROWSERS = join(TC, 'playwright', 'browsers');
const MANIFEST = join(TC, 'playwright', 'sets.json');
const n = (p: string): string => p.replace(/^[A-Za-z]:/, '').replace(/[\\]/g, '/');
const lock = (version: string) => JSON.stringify({ packages: { 'node_modules/@playwright/test': { version } } });

function memoryFs(initial: Record<string, string> = {}): PlaywrightBrowsersFs & { files: Record<string, string> } {
    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(initial)) files[n(k)] = v;
    const dirs = new Set<string>();
    return {
        files,
        exists: (p: string) => n(p) in files || dirs.has(n(p)) || Object.keys(files).some((f) => f.startsWith(n(p) + '/')),
        list: (d: string) => [...new Set(Object.keys(files).filter((f) => f.startsWith(n(d) + '/')).map((f) => f.slice(n(d).length + 1).split('/')[0]!))],
        mkdirp: (d: string) => { dirs.add(n(d)); },
        writeText: (p: string, c: string) => { files[n(p)] = c; },
        writeBytes: () => {},
        rename: () => {},
        removeTree: () => {},
        readText: (p: string) => files[n(p)] ?? null,
        size: () => 0,
    };
}

/** A manifest with folders recorded, and (unless `missing`) those folders on disk. */
function onDisk(sets: Record<string, string[]>, folders: Record<string, string[]>, missing: readonly string[] = []): Record<string, string> {
    const out: Record<string, string> = { [MANIFEST]: JSON.stringify({ sets, folders }) };
    for (const f of new Set(Object.values(folders).flat())) if (!missing.includes(f)) out[join(BROWSERS, f, 'INSTALLATION_COMPLETE')] = '';
    return out;
}

const DRY_RUN = [
    'browser: chromium version 139.0.7258.5',
    '  Install location:    /data/genie2-toolchain/playwright/browsers/chromium-1194',
    '  Download url:        https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1194/chromium-linux.zip',
    '',
    'browser: chromium-headless-shell version 139.0.7258.5',
    '  Install location:    C:\\Users\\someone\\.genie\\genie2-toolchain\\playwright\\browsers\\chromium_headless_shell-1194',
    '',
    'browser: ffmpeg',
    '  Install location:    /data/genie2-toolchain/playwright/browsers/ffmpeg-1011',
    '',
].join('\n');

describe('the stable channel and the switch', () => {
    it('stable is a pinned x.y.z, never "latest"', () => {
        expect(PLAYWRIGHT_STABLE).toMatch(/^\d+\.\d+\.\d+$/);
    });
    it('installing by itself is ON unless switched off', () => {
        expect(autoInstallEnabled(undefined)).toBe(true);
        expect(autoInstallEnabled('1')).toBe(true);
    });
    it('is OFF for 0, off, false, no', () => {
        for (const v of ['0', 'off', 'false', 'NO']) expect(autoInstallEnabled(v), v).toBe(false);
    });
    it('the variable that switches it is GENIE_PLAYWRIGHT_AUTO_INSTALL', () => {
        expect(PLAYWRIGHT_AUTO_INSTALL_ENV).toBe('GENIE_PLAYWRIGHT_AUTO_INSTALL');
    });
});

describe('which sets are really installed', () => {
    it('names the revision folders `--dry-run` reports, by their own names, on either OS', () => {
        expect(parseInstallLocations(DRY_RUN)).toEqual(['chromium-1194', 'chromium_headless_shell-1194', 'ffmpeg-1011']);
    });
    it('a version is installed when every folder recorded for it is there; two versions sit side by side', () => {
        const m = { sets: { '1.65.1': ['chromium'], '1.62.1': ['chromium'] }, folders: { '1.65.1': ['chromium-1194', 'chromium_headless_shell-1194'], '1.62.1': ['chromium-1234', 'chromium_headless_shell-1234'] } };
        expect(readyVersions(m, ['chromium-1194', 'chromium_headless_shell-1194', 'chromium-1234', 'chromium_headless_shell-1234']).sort()).toEqual(['1.62.1', '1.65.1']);
    });
    it('is NOT installed when one of its folders is gone (its headless shell deleted), while the other version still is', () => {
        const m = { sets: { '1.65.1': ['chromium'], '1.62.1': ['chromium'] }, folders: { '1.65.1': ['chromium-1194', 'chromium_headless_shell-1194'], '1.62.1': ['chromium-1234', 'chromium_headless_shell-1234'] } };
        expect(readyVersions(m, ['chromium-1194', 'chromium_headless_shell-1194', 'chromium-1234'])).toEqual(['1.65.1']);
    });
    it('a set recorded before folders were (beta.64) counts when a folder of its browser is there', () => {
        expect(readyVersions({ sets: { '1.65.1': ['chromium'] } }, ['chromium-1194'])).toEqual(['1.65.1']);
    });
    it('nothing is installed in an empty folder', () => {
        expect(readyVersions({ sets: { '1.65.1': ['chromium'] } }, [])).toEqual([]);
    });
});

describe('what Genie installs at launch', () => {
    it('the stable version, when it has no set at all', () => {
        expect(launchInstall({ enabled: true, ready: [] })).toBe(PLAYWRIGHT_STABLE);
    });
    it('nothing, when it already has a set', () => {
        expect(launchInstall({ enabled: true, ready: ['1.62.1'] })).toBeNull();
    });
    it('nothing, when it is switched off (a positive control for the first)', () => {
        expect(launchInstall({ enabled: false, ready: [] })).toBeNull();
    });
});

describe('an ask for a version: there, installed now, or asked of the person first', () => {
    it('is there already', () => {
        expect(decideInstallAsk({ version: '1.62.1', browsers: ['chromium'], ready: ['1.62.1'], held: ['chromium'] })).toEqual({ kind: 'ready' });
    });
    it('a version’s Chromium is installed now, with nobody asked', () => {
        expect(decideInstallAsk({ version: '1.62.1', browsers: ['chromium'], ready: ['1.65.1'], held: [] })).toEqual({ kind: 'install' });
    });
    it('another browser is unusually large: the person is asked', () => {
        expect(decideInstallAsk({ version: '1.65.1', browsers: ['firefox'], ready: ['1.65.1'], held: ['chromium'] }).kind).toBe('ask');
    });
    it('one set more than Genie keeps by itself is unusually large: the person is asked', () => {
        const ready = Array.from({ length: MAX_AUTO_SETS }, (_, i) => `1.${50 + i}.0`);
        expect(decideInstallAsk({ version: '1.62.1', browsers: ['chromium'], ready, held: [] }).kind).toBe('ask');
    });
    it('refuses what is not a version, and a browser Playwright does not have', () => {
        expect(decideInstallAsk({ version: 'latest', browsers: ['chromium'], ready: [], held: [] }).kind).toBe('refused');
        expect(decideInstallAsk({ version: '1.62.1', browsers: ['msedge'], ready: [], held: [] }).kind).toBe('refused');
    });
});

// ---------------------------------------------------------------- the installer (genie-host)

function installerRig(opts: { ready?: string[]; enabled?: boolean; fail?: string[] } = {}) {
    const ready = [...(opts.ready ?? [])];
    const installs: string[] = [];
    const applied: string[] = [];
    let running = 0;
    let most = 0;
    const gates: Array<() => void> = [];
    const fail = new Set(opts.fail ?? []);
    const ports: PlaywrightInstallerPorts = {
        install: async (version, browsers): Promise<PlaywrightInstallOutcome> => {
            installs.push(version);
            running++;
            most = Math.max(most, running);
            await new Promise<void>((resolve) => gates.push(resolve));
            running--;
            if (fail.has(version)) return { kind: 'not-installed', reason: `playwright install chromium failed (exit 1)` };
            ready.push(version);
            return { kind: 'installed', version, browsers };
        },
        ready: () => ready,
        enabled: () => opts.enabled !== false,
        onInstalled: (version) => { applied.push(version); },
        now: () => 1000,
    };
    // Lets every install that is (or comes to be) waiting finish, a turn at a time: a queued one starts only after the one before it.
    const release = async () => { for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 0)); gates.shift()?.(); } };
    return { installer: new PlaywrightInstaller(ports), installs, applied, ready, fail, release, most: () => most };
}

describe('the installer at launch', () => {
    it('installs the stable version once when Genie has no set, and points what it starts at it', async () => {
        const r = installerRig();
        const done = r.installer.ensureAtLaunch();
        expect(r.installer.installing()).toEqual([PLAYWRIGHT_STABLE]);
        await r.release();
        expect(await done).toMatchObject({ kind: 'installed', version: PLAYWRIGHT_STABLE });
        expect(r.installs).toEqual([PLAYWRIGHT_STABLE]);
        expect(r.applied).toEqual([PLAYWRIGHT_STABLE]);
        expect(r.installer.items()).toEqual([]);
    });
    it('installs nothing when switched off', async () => {
        const r = installerRig({ enabled: false });
        expect(await r.installer.ensureAtLaunch()).toBeNull();
        expect(r.installs).toEqual([]);
    });
});

describe('the installer, asked for versions', () => {
    it('two asks for one version while it installs are ONE install', async () => {
        const r = installerRig({ ready: [PLAYWRIGHT_STABLE] });
        const a = r.installer.ensure('1.62.1');
        const b = r.installer.ensure('1.62.1');
        await r.release();
        await Promise.all([a, b]);
        expect(r.installs).toEqual(['1.62.1']);
    });
    it('installs one at a time', async () => {
        const r = installerRig({ ready: [PLAYWRIGHT_STABLE] });
        const a = r.installer.ensure('1.62.1');
        const b = r.installer.ensure('1.63.0');
        await r.release();
        await Promise.all([a, b]);
        expect(r.installs).toEqual(['1.62.1', '1.63.0']);
        expect(r.most()).toBe(1);
    });
    it('a failure is ONE Deck item, with Retry and Dismiss; a retry that works takes it away', async () => {
        const r = installerRig({ fail: ['1.62.1'] });
        const first = r.installer.ensure('1.62.1');
        await r.release();
        expect((await first).kind).toBe('not-installed');
        const items = r.installer.items();
        expect(items).toHaveLength(1);
        expect(items[0]!.id).toBe(`${PLAYWRIGHT_NOTICE_DECK_PREFIX}1.62.1`);
        expect(items[0]!.source).toBe('genie');
        expect(items[0]!.answer).toMatchObject({ kind: 'inline', options: [{ id: 'retry' }, { id: 'dismiss' }] });
        expect(items[0]!.detail).toMatch(/exit 1/);
        r.fail.clear();
        const retried = r.installer.retry(items[0]!.id);
        await r.release();
        expect(await retried).toBe(true);
        expect(r.installer.items()).toEqual([]);
        expect(r.applied).toEqual(['1.62.1']);
    });
    it('Dismiss puts the item away', async () => {
        const r = installerRig({ fail: ['1.62.1'] });
        const first = r.installer.ensure('1.62.1');
        await r.release();
        await first;
        expect(r.installer.dismiss(`${PLAYWRIGHT_NOTICE_DECK_PREFIX}1.62.1`)).toBe(true);
        expect(r.installer.items()).toEqual([]);
    });
});

describe('the Deck answers a failed install', () => {
    const item = (_option: string): DeckItem => ({
        id: `${PLAYWRIGHT_NOTICE_DECK_PREFIX}1.62.1`, source: 'genie', agentId: null, agentName: null, workspaceId: null, title: 'x', blocking: false, priority: 'normal', at: 1,
        answer: { kind: 'inline', options: [{ id: 'retry', label: 'Retry', tone: 'neutral' }, { id: 'dismiss', label: 'Dismiss', tone: 'neutral' }] }, forwardedFrom: null,
    });
    it('Retry and Dismiss are commands of their own', () => {
        expect(resolveDeckAnswer(item('retry'), 'retry')).toEqual({ kind: 'playwright-install', id: `${PLAYWRIGHT_NOTICE_DECK_PREFIX}1.62.1`, retry: true });
        expect(resolveDeckAnswer(item('dismiss'), 'dismiss')).toEqual({ kind: 'playwright-install', id: `${PLAYWRIGHT_NOTICE_DECK_PREFIX}1.62.1`, retry: false });
    });
    it('reach the installer', async () => {
        const did: string[] = [];
        const ports = {
            attention: { answer: async () => true, pending: () => [], lists: { done: () => true } }, approvals: { resolve: () => true }, inbox: { unread: () => [], receive: () => {} },
            playwrightNotices: { retry: async (id: string) => { did.push(`retry ${id}`); return true; }, dismiss: (id: string) => { did.push(`dismiss ${id}`); return true; } },
        } as unknown as DeckAnswerPorts;
        await answerDeck({ kind: 'deck.answer', item: item('retry'), optionId: 'retry' } as never, ports);
        await answerDeck({ kind: 'deck.answer', item: item('dismiss'), optionId: 'dismiss' } as never, ports);
        expect(did).toEqual([`retry ${PLAYWRIGHT_NOTICE_DECK_PREFIX}1.62.1`, `dismiss ${PLAYWRIGHT_NOTICE_DECK_PREFIX}1.62.1`]);
    });
});

// ---------------------------------------------------------------- a workspace's variables (PlaywrightHost)

function serverPorts(): PlaywrightServerPorts {
    let state: 'running' | 'stopped' = 'stopped';
    return {
        supervisor: {
            start: (spec) => { state = 'running'; return { id: spec.id, workspaceId: spec.workspaceId, name: spec.name, state: 'running', pid: 1, exitCode: null, restarts: 0, since: 0 }; },
            stop: () => { state = 'stopped'; return true; },
            status: (id) => ({ id, workspaceId: 'w', name: 'n', state, pid: 1, exitCode: null, restarts: 0, since: 0 }),
        },
        workspaceId: 'genie', cwd: TC, cliDir: (v) => join(TC, 'playwright', 'cli', v),
        allocatePort: () => 3001, mintToken: () => 'z'.repeat(40), now: () => 1, connections: async () => 0, idleMs: 600_000,
    };
}

function hostOver(files: Record<string, string>, optIn = false) {
    const asked: string[] = [];
    const host = new PlaywrightHost({
        toolchainDir: TC, server: serverPorts(), workspacePath: (id) => (id === 'ws' ? '/work/app' : null), optIn: () => optIn,
        fs: memoryFs(files), platform: 'linux', link: () => {},
        installer: { ensure: async (v) => { asked.push(v); return null; }, installing: () => asked },
    });
    return { host, asked };
}

const STABLE_SET = onDisk({ [PLAYWRIGHT_STABLE]: ['chromium'] }, { [PLAYWRIGHT_STABLE]: ['chromium-1194'] });

describe('a workspace’s variables, and the versions a project pins', () => {
    it('a project pinning a version Genie lacks: Genie installs it NOW, and the note says so (no action asked of anyone)', () => {
        const { host, asked } = hostOver({ '/work/app/package-lock.json': lock('1.62.1'), ...STABLE_SET });
        const env = host.envFor('ws');
        expect(asked).toEqual(['1.62.1']);
        expect(env[PLAYWRIGHT_NOTE_ENV]).toMatch(/Genie is installing Playwright 1\.62\.1/);
        expect(env[PLAYWRIGHT_NOTE_ENV]).not.toMatch(/Toolchain page/);
    });
    it('a project whose version Genie has: GENIE_PLAYWRIGHT_VERSION is it, GENIE_PLAYWRIGHT_VERSIONS lists every set, nothing is installed', () => {
        const { host, asked } = hostOver({ '/work/app/package-lock.json': lock('1.62.1'), ...onDisk({ '1.62.1': ['chromium'], [PLAYWRIGHT_STABLE]: ['chromium'] }, { '1.62.1': ['chromium-1234'], [PLAYWRIGHT_STABLE]: ['chromium-1194'] }) });
        const env = host.envFor('ws');
        expect(env[PLAYWRIGHT_VERSION_ENV]).toBe('1.62.1');
        expect(env[PLAYWRIGHT_VERSIONS_ENV]!.split(',').sort()).toEqual(['1.62.1', PLAYWRIGHT_STABLE].sort());
        expect(asked).toEqual([]);
    });
    it('a project with no Playwright yet is told the stable version to use', () => {
        const { host } = hostOver({ '/work/app/package-lock.json': JSON.stringify({ packages: {} }), ...STABLE_SET });
        expect(host.envFor('ws')[PLAYWRIGHT_VERSION_ENV]).toBe(PLAYWRIGHT_STABLE);
    });
    it('a recorded set whose folder is gone is not installed: Genie installs it again', () => {
        const { host, asked } = hostOver({ '/work/app/package-lock.json': lock('1.62.1'), ...onDisk({ '1.62.1': ['chromium'] }, { '1.62.1': ['chromium-1234'] }, ['chromium-1234']) });
        host.envFor('ws');
        expect(asked).toEqual(['1.62.1']);
    });
});

// ---------------------------------------------------------------- installing (playwright-browsers.ts)

function installPorts(files: Record<string, string> = {}, dryRun = DRY_RUN) {
    const fs = memoryFs(files);
    const calls: Array<{ binary: string; args: readonly string[] }> = [];
    return {
        fs, calls,
        ports: {
            platform: 'linux' as const, toolchainDir: TC, fs,
            run: async (binary: string, args: readonly string[]) => {
                calls.push({ binary, args });
                const pkg = args.find((a) => a.startsWith('playwright@'));
                if (args[0] === 'install' && args.includes('--prefix') && pkg) fs.writeText(join(TC, 'playwright', 'cli', pkg.slice('playwright@'.length), 'node_modules', 'playwright', 'cli.js'), '');
                if (args.includes('--dry-run')) return { stdout: dryRun, exitCode: 0 };
                if (args[1] === 'install') for (const f of parseFolders(dryRun)) fs.writeText(join(BROWSERS, f, 'INSTALLATION_COMPLETE'), '');
                return { stdout: args[0] === 'view' ? '9.9.9\n' : '', exitCode: 0 };
            },
        },
    };
}
const parseFolders = (text: string) => [...text.matchAll(/Install location:\s*(.+)$/gm)].map((m) => m[1]!.trim().split(/[\\/]/).pop()!);

describe('installing a version records where its browsers went', () => {
    it('records the revision folders `--dry-run` names, beside the browsers', async () => {
        const r = installPorts();
        await installPlaywrightBrowsers('1.65.1', ['chromium'], true, r.ports);
        const saved = JSON.parse(r.fs.files[n(MANIFEST)]!) as { sets: Record<string, string[]>; folders: Record<string, string[]> };
        expect(saved.sets['1.65.1']).toEqual(['chromium']);
        expect(saved.folders['1.65.1']).toEqual(['chromium-1194', 'chromium_headless_shell-1194', 'ffmpeg-1011']);
    });
    it('a recorded set whose folders are gone is downloaded again, not "already installed"', async () => {
        const r = installPorts(onDisk({ '1.65.1': ['chromium'] }, { '1.65.1': ['chromium-1194'] }, ['chromium-1194']));
        r.fs.writeText(join(TC, 'playwright', 'cli', '1.65.1', 'node_modules', 'playwright', 'cli.js'), '');
        const out = await installPlaywrightBrowsers('1.65.1', ['chromium'], true, r.ports);
        expect(out.kind).toBe('installed');
        expect(r.calls.some((c) => c.args[1] === 'install' && c.args.includes('chromium') && !c.args.includes('--dry-run'))).toBe(true);
    });
    it('the list says the stable version and which sets are really there', async () => {
        const r = installPorts({ ...onDisk({ '1.65.1': ['chromium'], '1.62.1': ['chromium'] }, { '1.65.1': ['chromium-1194'], '1.62.1': ['chromium-1234'] }, ['chromium-1234']) });
        const view = await listPlaywrightBrowsers(r.ports);
        expect(view.stable).toBe(PLAYWRIGHT_STABLE);
        expect(view.sets.map((s) => [s.version, s.ready])).toEqual([['1.65.1', true], ['1.62.1', false]]);
    });
});

// ---------------------------------------------------------------- the `playwright` tool

const CALLER = { agentId: 'a1', agentName: 'atlas', workspaceId: 'ws', workspacePath: '/work/app' } as unknown as Caller;

function toolRig(opts: { verdict?: 'allowed' | 'denied'; ready?: string[] } = {}) {
    const installs: Array<[string, readonly string[]]> = [];
    const asked: string[] = [];
    const port: PlaywrightToolPort = {
        status: () => ({ stable: PLAYWRIGHT_STABLE, installed: (opts.ready ?? [PLAYWRIGHT_STABLE]).map((version) => ({ version, browsers: ['chromium'] })), browsersPath: BROWSERS, project: '1.62.1', installing: [], autoInstall: true }),
        ready: () => opts.ready ?? [PLAYWRIGHT_STABLE],
        held: (v) => ((opts.ready ?? [PLAYWRIGHT_STABLE]).includes(v) ? ['chromium'] : []),
        install: async (version, browsers) => { installs.push([version, browsers]); return { kind: 'installed', version, browsers }; },
    };
    const [tool] = playwrightTools({ resolveCaller: (key) => (key === 's1' ? CALLER : null), port, approve: async (_c, _a, detail) => { asked.push(detail); return opts.verdict ?? 'allowed'; } });
    const call = async (args: Record<string, unknown>, key = 's1') => JSON.parse((await tool!.handler(args as never, { headers: { 'genie-session': key } } as never)).text) as Record<string, any>;
    return { call, installs, asked };
}

describe('the playwright tool', () => {
    it('status: the stable version, what is installed, the browsers folder and the version this workspace pins', async () => {
        const r = toolRig();
        const out = await r.call({ action: 'status' });
        expect(out).toMatchObject({ ok: true, stable: PLAYWRIGHT_STABLE, installed: [{ version: PLAYWRIGHT_STABLE, browsers: ['chromium'] }], browsersPath: BROWSERS, project: '1.62.1' });
        expect(r.installs).toEqual([]);
    });
    it('install of a version’s Chromium: installed at once, nobody asked', async () => {
        const r = toolRig();
        const out = await r.call({ action: 'install', version: '1.62.1' });
        expect(out).toMatchObject({ ok: true, version: '1.62.1' });
        expect(r.installs).toEqual([['1.62.1', ['chromium']]]);
        expect(r.asked).toEqual([]);
    });
    it('install of firefox waits for the person; denied, nothing is installed', async () => {
        const r = toolRig({ verdict: 'denied' });
        const out = await r.call({ action: 'install', version: PLAYWRIGHT_STABLE, browsers: ['firefox'] });
        expect(out.ok).toBe(false);
        expect(r.asked).toHaveLength(1);
        expect(r.asked[0]).toMatch(/firefox/);
        expect(r.installs).toEqual([]);
    });
    it('install of what Genie has answers at once, with nothing installed', async () => {
        const r = toolRig();
        const out = await r.call({ action: 'install', version: PLAYWRIGHT_STABLE });
        expect(out).toMatchObject({ ok: true, version: PLAYWRIGHT_STABLE });
        expect(r.installs).toEqual([]);
    });
    it('a caller Genie does not know is refused', async () => {
        const r = toolRig();
        expect((await r.call({ action: 'status' }, 'nobody')).ok).toBe(false);
    });
    it('is one of Genie’s builtin tools, and runs on the host where the installer is', () => {
        expect(genieCatalog().list('tool').map((d) => d.id)).toContain('playwright');
        expect(HOST_NATIVE_TOOLS.has('playwright')).toBe(true);
    });
});

// ---------------------------------------------------------------- what agents are told, and the test machines

describe('what agents are told', () => {
    it('Genie installs the browsers itself; the playwright tool reads what it has and asks for a version; GENIE_PLAYWRIGHT_VERSION is the one to use', () => {
        const text = sharedProtocol([], 'files');
        expect(text).toMatch(/Genie installs them itself/);
        expect(text).toMatch(/`playwright` tool/);
        expect(text).toMatch(/GENIE_PLAYWRIGHT_VERSION/);
    });
});

describe('the gate’s rows do not download browsers into every test machine', () => {
    it('both row scripts switch installing by itself off', () => {
        expect(readFileSync('scripts/ci/linux.sh', 'utf8')).toMatch(/export GENIE_PLAYWRIGHT_AUTO_INSTALL=0/);
        expect(readFileSync('scripts/ci/windows.ps1', 'utf8')).toMatch(/\$env:GENIE_PLAYWRIGHT_AUTO_INSTALL = '0'/);
    });
});
