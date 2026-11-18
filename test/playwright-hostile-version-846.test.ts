import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLockedPlaywright } from '../src/core/playwright-managed.js';
import { PlaywrightInstaller } from '../src/main/playwright-auto.js';
import { installPlaywrightBrowsers, type PlaywrightBrowsersFs } from '../src/main/playwright-browsers.js';
import { PLAYWRIGHT_NOTE_ENV, PlaywrightHost } from '../src/main/playwright-host.js';
import type { PlaywrightServerPorts } from '../src/main/playwright-server.js';
import { playwrightTools } from '../src/main/mcp-tools-playwright.js';
import type { Caller } from '../src/main/mcp-tools.js';

/**
 * A WORKSPACE'S LOCKFILE IS NOT TRUSTED INPUT (Tynn #846 review). Genie installs the Playwright a project pins just because
 * an agent or terminal starts there, so the version string comes from whatever repository was cloned. On Windows npm runs
 * through `cmd.exe /d /s /c call npm.cmd … playwright@<version>`: a version like `1.2.3 && calc` would be a command line,
 * run by opening a folder (the beta.6x RCE-on-open class). Only `x.y.z` is a version; anything else never reaches an
 * install, on any path. And a workspace not yet trusted triggers no install at all.
 */

const TC = join('/data', 'genie2-toolchain');
const HOSTILE = ['1.2.3 && calc', '1.2.3&calc', '$(calc)', '1.2.3$(touch /tmp/x)', '`calc`', '1.2.3;calc', '1.2.3|calc', '1.2.3\ncalc', '../../1.2.3'];

const packageLock = (v: string) => JSON.stringify({ packages: { 'node_modules/@playwright/test': { version: v } } });
const pnpmLock = (v: string) => `importers:\n  .:\n    devDependencies:\n      '@playwright/test':\n        specifier: ^1.0.0\n        version: ${v}\n`;
const yarnLock = (v: string) => `"@playwright/test@^1.0.0":\n  version "${v}"\n`;

describe('the version a lockfile pins is a version, or nothing', () => {
    it('CONTROL: a plain x.y.z is read from every kind of lockfile', () => {
        expect(parseLockedPlaywright(packageLock('1.62.1'), 'package-lock')).toBe('1.62.1');
        expect(parseLockedPlaywright(pnpmLock('1.62.1'), 'pnpm')).toBe('1.62.1');
        expect(parseLockedPlaywright(yarnLock('1.62.1'), 'yarn')).toBe('1.62.1');
    });
    for (const v of HOSTILE) {
        it(`package-lock: ${JSON.stringify(v)} is not a version`, () => {
            expect(parseLockedPlaywright(packageLock(v), 'package-lock')).toBeNull();
        });
    }
    for (const v of HOSTILE.filter((h) => !h.includes('\n'))) {
        it(`pnpm and yarn: ${JSON.stringify(v)} is not a version`, () => {
            expect(parseLockedPlaywright(pnpmLock(v), 'pnpm')).toBeNull();
            expect(parseLockedPlaywright(yarnLock(v), 'yarn')).toBeNull();
        });
    }
});

describe('the installer itself installs nothing that is not x.y.z, however it is asked', () => {
    it('ensure() refuses a hostile version and never calls install()', async () => {
        const installs: string[] = [];
        const installer = new PlaywrightInstaller({
            install: async (version, browsers) => { installs.push(version); return { kind: 'installed', version, browsers }; },
            ready: () => [], enabled: () => true, onInstalled: () => {}, now: () => 1,
        });
        for (const v of HOSTILE) expect((await installer.ensure(v)).kind, v).toBe('refused');
        expect(installs).toEqual([]);
        expect(installer.installing()).toEqual([]);
    });
});

// ---------------------------------------------------------------- the host: opening a workspace

const memoryFs = (files: Record<string, string>): PlaywrightBrowsersFs => ({
    exists: (p) => p in files, list: () => [], mkdirp: () => {}, writeText: () => {}, writeBytes: () => {}, rename: () => {}, removeTree: () => {},
    readText: (p) => files[p.replace(/[\\]/g, '/').replace(/^[A-Za-z]:/, '')] ?? null, size: () => 0,
});
const serverPorts = (): PlaywrightServerPorts => ({
    supervisor: { start: (spec) => ({ id: spec.id, workspaceId: spec.workspaceId, name: spec.name, state: 'running', pid: 1, exitCode: null, restarts: 0, since: 0 }), stop: () => true, status: (id) => ({ id, workspaceId: 'w', name: 'n', state: 'stopped', pid: 1, exitCode: null, restarts: 0, since: 0 }) },
    workspaceId: 'genie', cwd: TC, cliDir: (v) => join(TC, 'playwright', 'cli', v), allocatePort: () => 3001, mintToken: () => 'z'.repeat(40), now: () => 1, connections: async () => 0, idleMs: 600_000,
});
function hostOver(lock: string, trusted: boolean) {
    const asked: string[] = [];
    const host = new PlaywrightHost({
        toolchainDir: TC, server: serverPorts(), workspacePath: () => '/work/app', optIn: () => false, fs: memoryFs({ '/work/app/package-lock.json': lock }), platform: 'linux', link: () => {},
        installer: { ensure: (v) => { asked.push(v); return true; }, installing: () => asked },
        trusted: () => trusted,
    });
    return { host, asked };
}

describe('opening a workspace', () => {
    it('a hostile lockfile version triggers no install', () => {
        for (const v of HOSTILE) {
            const { host, asked } = hostOver(packageLock(v), true);
            host.envFor('ws');
            expect(asked, v).toEqual([]);
        }
    });
    it('a workspace not yet trusted triggers no install, and the note says why', () => {
        const { host, asked } = hostOver(packageLock('1.62.1'), false);
        const env = host.envFor('ws');
        expect(asked).toEqual([]);
        expect(env[PLAYWRIGHT_NOTE_ENV]).toMatch(/trust/i);
    });
    it('CONTROL: the same lockfile in a trusted workspace is installed', () => {
        const { host, asked } = hostOver(packageLock('1.62.1'), true);
        host.envFor('ws');
        expect(asked).toEqual(['1.62.1']);
    });
});

describe('an agent asking in a workspace not yet trusted', () => {
    it('is refused, and nothing is installed', async () => {
        const installs: string[] = [];
        const caller = { agentId: 'a1', agentName: 'atlas', workspaceId: 'ws', workspacePath: '/work/app' } as unknown as Caller;
        const [tool] = playwrightTools({
            resolveCaller: () => caller,
            port: { status: () => ({ stable: '1.65.1', installed: [], browsersPath: null, project: null, installing: [], autoInstall: true }), ready: () => [], held: () => [], install: async (version, browsers) => { installs.push(version); return { kind: 'installed', version, browsers }; } },
            approve: async () => 'allowed',
            trusted: () => false,
        });
        const out = JSON.parse((await tool!.handler({ action: 'install', version: '1.62.1' } as never, { headers: { 'genie-session': 's' } } as never)).text) as { ok: boolean; error?: string };
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/trust/i);
        expect(installs).toEqual([]);
    });
});

// ---------------------------------------------------------------- the command line (pinned; proven by a break probe)

function runRig(platform: 'linux' | 'win32') {
    const calls: Array<{ binary: string; args: readonly string[] }> = [];
    const files: Record<string, string> = {};
    const fs: PlaywrightBrowsersFs = { exists: (p) => p in files, list: () => [], mkdirp: () => {}, writeText: (p, c) => { files[p] = c; }, writeBytes: () => {}, rename: () => {}, removeTree: () => {}, readText: (p) => files[p] ?? null, size: () => 0 };
    const ports = {
        platform, toolchainDir: TC, fs,
        run: async (binary: string, args: readonly string[]) => {
            calls.push({ binary, args });
            const pkg = args.find((a) => a.startsWith('playwright@'));
            if (pkg) fs.writeText(join(TC, 'playwright', 'cli', pkg.slice('playwright@'.length), 'node_modules', 'playwright', 'cli.js'), '');
            return { stdout: '', exitCode: 0 };
        },
    };
    return { calls, ports };
}

describe('the version goes to npm as ONE argument, and a hostile one builds no command at all', () => {
    it('npm gets `playwright@1.62.1` as a single argv element; the browsers are installed by `node cli.js`, no shell', async () => {
        const r = runRig('linux');
        await installPlaywrightBrowsers('1.62.1', ['chromium'], true, r.ports);
        const npm = r.calls.find((c) => c.args.includes('--prefix'))!;
        expect(npm.binary).toBe('npm');
        expect(npm.args.filter((a) => a.includes('1.62.1') && !a.includes('/') && !a.includes('\\'))).toEqual(['playwright@1.62.1']);
        const browsers = r.calls.find((c) => c.args[1] === 'install' && c.args.includes('chromium') && !c.args.includes('--dry-run'))!;
        expect(browsers.binary).toBe('node');
    });
    it('on Windows (where npm runs through cmd.exe) a hostile version is refused before ANY command is built', async () => {
        for (const v of HOSTILE) {
            const r = runRig('win32');
            expect((await installPlaywrightBrowsers(v, ['chromium'], true, r.ports)).kind, v).toBe('refused');
            expect(r.calls, v).toEqual([]);
        }
    });
});
