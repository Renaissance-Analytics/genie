import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    PLAYWRIGHT_BROWSERS_ENV, PLAYWRIGHT_ENDPOINT_ENV, countEstablished, decideIdle, endpointUrl, parseLockedPlaywright, planBrowserInstall,
    playwrightChildEnv, playwrightDirs, playwrightEnv, resolveBrowserSet, serverCommand, serverVersionMatch, worktreeLinkDecision,
} from '../src/core/playwright-managed.js';
import { PlaywrightServer, type PlaywrightServerPorts } from '../src/main/playwright-server.js';
import { restoreToolchainEnv, type EnvPort, type ToolchainFs } from '../src/main/toolchain-ops.js';
import { providerLaunchOptions } from '../src/main/session-host.js';
import { sharedProtocol } from '../src/core/genie-protocol.js';

/**
 * ONE PLAYWRIGHT, MANAGED BY GENIE (Tynn #604). Browsers installed once into a Genie folder and handed to every terminal,
 * process, site and agent (PLAYWRIGHT_BROWSERS_PATH); a version-matched local browser server for agents that opt in
 * (PW_TEST_CONNECT_WS_ENDPOINT); a worktree's node_modules linked to the main checkout only when the lockfiles agree.
 */

const TC = join('/data', 'genie2-toolchain');

describe('the managed browsers path', () => {
    it('lives under the toolchain data folder, one folder for every version', () => {
        const dirs = playwrightDirs(TC);
        expect(dirs.root).toBe(join(TC, 'playwright'));
        expect(dirs.browsers).toBe(join(TC, 'playwright', 'browsers'));
        expect(dirs.cli('1.57.0')).toBe(join(TC, 'playwright', 'cli', '1.57.0'));
    });

    it('is the PLAYWRIGHT_BROWSERS_PATH every child gets', () => {
        expect(playwrightEnv(TC)).toEqual({ [PLAYWRIGHT_BROWSERS_ENV]: join(TC, 'playwright', 'browsers') });
    });

    it('is applied to Genie’s own environment before anything is spawned, so terminals, processes and sites inherit it', () => {
        const env = new Map<string, string>();
        const port: EnvPort = { get: (n) => env.get(n), set: (n, v) => void env.set(n, v) };
        const fs: ToolchainFs = { exists: () => false, readText: () => null, writeText: () => {}, mkdirp: () => {}, remove: () => {} };
        restoreToolchainEnv({ platform: 'linux', env: port, fs, dataDir: TC });
        expect(env.get('PLAYWRIGHT_BROWSERS_PATH')).toBe(join(TC, 'playwright', 'browsers'));
    });

    describe('reaching an agent, whose environment is an allow-list', () => {
        const saved = process.env.PLAYWRIGHT_BROWSERS_PATH;
        afterEach(() => {
            if (saved === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
            else process.env.PLAYWRIGHT_BROWSERS_PATH = saved;
        });
        it('lets the managed path through to the provider, with its value', () => {
            process.env.PLAYWRIGHT_BROWSERS_PATH = join(TC, 'playwright', 'browsers');
            const launch = providerLaunchOptions(undefined, {}, { execPath: 'node', electron: false });
            expect(launch.allowEnv).toContain('PLAYWRIGHT_BROWSERS_PATH');
            expect(launch.parentEnv?.PLAYWRIGHT_BROWSERS_PATH).toBe(join(TC, 'playwright', 'browsers'));
        });
        it('says nothing when Genie has set none (a positive control for the test above)', () => {
            delete process.env.PLAYWRIGHT_BROWSERS_PATH;
            const launch = providerLaunchOptions(undefined, {}, { execPath: 'node', electron: false });
            expect(launch.allowEnv ?? []).not.toContain('PLAYWRIGHT_BROWSERS_PATH');
        });
    });
});

describe('the Playwright version a project uses, from its lockfile', () => {
    it('reads package-lock.json', () => {
        const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/@playwright/test': { version: '1.57.0' }, 'node_modules/playwright': { version: '1.57.0' } } });
        expect(parseLockedPlaywright(lock, 'package-lock')).toBe('1.57.0');
    });
    it('reads pnpm-lock.yaml', () => {
        const lock = ["importers:", "  .:", "    devDependencies:", "      '@playwright/test':", "        specifier: ^1.56.1", "        version: 1.56.1", ""].join('\n');
        expect(parseLockedPlaywright(lock, 'pnpm')).toBe('1.56.1');
    });
    it('reads yarn.lock', () => {
        const lock = ['"@playwright/test@^1.55.0":', '  version "1.55.1"', '  resolved "https://registry.example/x"', ''].join('\n');
        expect(parseLockedPlaywright(lock, 'yarn')).toBe('1.55.1');
    });
    it('says null when the project does not use Playwright', () => {
        expect(parseLockedPlaywright(JSON.stringify({ packages: { '': {} } }), 'package-lock')).toBeNull();
        expect(parseLockedPlaywright('not json', 'package-lock')).toBeNull();
    });
});

describe('one browser set per Playwright version, never downloaded twice', () => {
    it('is ready when that version’s set is installed', () => {
        expect(resolveBrowserSet('1.57.0', ['1.56.1', '1.57.0'])).toEqual({ kind: 'ready', version: '1.57.0' });
    });
    it('refuses a version it has no set for, naming that version and the ones it has', () => {
        const r = resolveBrowserSet('1.57.0', ['1.56.1', '1.58.0']);
        expect(r.kind).toBe('missing');
        if (r.kind === 'missing') {
            expect(r.version).toBe('1.57.0');
            expect(r.note).toContain('1.57.0');
            expect(r.note).toContain('1.56.1');
            expect(r.note).toContain('1.58.0');
        }
    });
    it('says so plainly when none is installed', () => {
        const r = resolveBrowserSet('1.57.0', []);
        expect(r.kind).toBe('missing');
        if (r.kind === 'missing') expect(r.note).toContain('1.57.0');
    });
    it('downloads only the browsers a version does not have yet', () => {
        expect(planBrowserInstall('1.57.0', ['chromium', 'firefox'], { '1.57.0': ['chromium'] })).toEqual({ download: ['firefox'], have: ['chromium'] });
        expect(planBrowserInstall('1.57.0', ['chromium'], { '1.57.0': ['chromium'] })).toEqual({ download: [], have: ['chromium'] });
        expect(planBrowserInstall('1.58.0', ['chromium'], { '1.57.0': ['chromium'] })).toEqual({ download: ['chromium'], have: [] });
    });
});

describe('the server’s version rule', () => {
    it('accepts a client on the same major.minor', () => {
        expect(serverVersionMatch('1.57.0', '1.57.2')).toEqual({ ok: true });
    });
    it('refuses another minor, naming both versions', () => {
        const r = serverVersionMatch('1.56.1', '1.57.0');
        expect(r.ok).toBe(false);
        expect(r.note).toContain('1.56.1');
        expect(r.note).toContain('1.57.0');
    });
    it('hands a matching client the endpoint', () => {
        const server = { port: 4444, token: 'T'.repeat(32), version: '1.57.0' };
        const r = playwrightChildEnv({ toolchainDir: TC, optIn: true, clientVersion: '1.57.0', server });
        expect(r.env[PLAYWRIGHT_ENDPOINT_ENV]).toBe(`ws://127.0.0.1:4444/${'T'.repeat(32)}`);
        expect(r.env[PLAYWRIGHT_BROWSERS_ENV]).toBe(join(TC, 'playwright', 'browsers'));
        expect(r.note).toBeUndefined();
    });
    it('omits the endpoint for a client on another version, with a note naming both', () => {
        const server = { port: 4444, token: 'T'.repeat(32), version: '1.57.0' };
        const r = playwrightChildEnv({ toolchainDir: TC, optIn: true, clientVersion: '1.55.1', server });
        expect(r.env[PLAYWRIGHT_ENDPOINT_ENV]).toBeUndefined();
        expect(r.env[PLAYWRIGHT_BROWSERS_ENV]).toBeDefined();
        expect(r.note).toContain('1.55.1');
        expect(r.note).toContain('1.57.0');
    });
    it('omits the endpoint when the workspace has the setting off, but keeps the browsers path', () => {
        const server = { port: 4444, token: 'T'.repeat(32), version: '1.57.0' };
        const r = playwrightChildEnv({ toolchainDir: TC, optIn: false, clientVersion: '1.57.0', server });
        expect(r.env[PLAYWRIGHT_ENDPOINT_ENV]).toBeUndefined();
        expect(r.env[PLAYWRIGHT_BROWSERS_ENV]).toBeDefined();
    });
    it('omits the endpoint for a project that does not use Playwright', () => {
        const server = { port: 4444, token: 'T'.repeat(32), version: '1.57.0' };
        expect(playwrightChildEnv({ toolchainDir: TC, optIn: true, clientVersion: null, server }).env[PLAYWRIGHT_ENDPOINT_ENV]).toBeUndefined();
    });
    it('writes the endpoint with the token in the path', () => {
        expect(endpointUrl({ port: 9, token: 'abc' })).toBe('ws://127.0.0.1:9/abc');
    });
});

describe('how the server is started', () => {
    const token = 'k'.repeat(32);
    it('binds 127.0.0.1 only, with the token as its path', () => {
        const { command, path } = serverCommand({ cliDir: join(TC, 'playwright', 'cli', '1.57.0'), host: '127.0.0.1', port: 4444, token });
        expect(path).toBe(`/${token}`);
        expect(command).toContain('run-server');
        expect(command).toContain('--host 127.0.0.1');
        expect(command).toContain('--port 4444');
        expect(command).toContain(`--path /${token}`);
    });
    it.each(['0.0.0.0', 'localhost', '::', '192.168.1.5', ''])('refuses to bind %j', (host) => {
        expect(() => serverCommand({ cliDir: TC, host, port: 4444, token })).toThrow(/127\.0\.0\.1/);
    });
    it('refuses a missing or short token, because an open server runs a browser for anyone', () => {
        expect(() => serverCommand({ cliDir: TC, host: '127.0.0.1', port: 4444, token: '' })).toThrow(/token/);
        expect(() => serverCommand({ cliDir: TC, host: '127.0.0.1', port: 4444, token: 'short' })).toThrow(/token/);
    });
});

describe('the server as a supervised process', () => {
    function rig(connections: number | null = 0) {
        const started: Array<{ id: string; command: string; name: string; restart: string; workspaceId: string }> = [];
        const stopped: string[] = [];
        let state: 'running' | 'stopped' = 'stopped';
        let nextPort = 4000;
        let nextToken = 0;
        let clock = 1_000_000;
        let conns = connections;
        const ports: PlaywrightServerPorts = {
            supervisor: {
                start: (spec) => { started.push({ id: spec.id, command: spec.command, name: spec.name, restart: spec.restart, workspaceId: spec.workspaceId }); state = 'running'; return { id: spec.id, workspaceId: spec.workspaceId, name: spec.name, state: 'running', pid: 1, exitCode: null, restarts: 0, since: 0 }; },
                stop: (id) => { stopped.push(id); state = 'stopped'; return true; },
                status: (id) => (started.some((s) => s.id === id) ? { id, workspaceId: 'w', name: 'n', state, pid: 1, exitCode: null, restarts: 0, since: 0 } : null),
            },
            workspaceId: 'genie',
            cwd: TC,
            cliDir: (v) => join(TC, 'playwright', 'cli', v),
            allocatePort: () => ++nextPort,
            mintToken: () => `${String(++nextToken).padStart(2, '0')}${'x'.repeat(30)}`,
            now: () => clock,
            connections: async () => conns,
            idleMs: 600_000,
        };
        return { server: new PlaywrightServer(ports), started, stopped, advance: (ms: number) => { clock += ms; }, setConnections: (n: number | null) => { conns = n; } };
    }

    it('starts on demand: nothing runs until an agent asks', async () => {
        const r = rig();
        expect(r.started).toHaveLength(0);
        expect(r.server.running()).toBeNull();
        const got = await r.server.acquire('1.57.0');
        expect(r.started).toHaveLength(1);
        expect(got.version).toBe('1.57.0');
        expect(r.started[0]!.command).toContain('--host 127.0.0.1');
        expect(r.started[0]!.command).toContain(`--port ${got.port}`);
        expect(r.started[0]!.command).toContain(`--path /${got.token}`);
        expect(r.started[0]!.restart).toBe('never');
    });

    it('is one server for everyone: a second ask starts nothing and gets the same endpoint', async () => {
        const r = rig();
        const a = await r.server.acquire('1.57.0');
        const b = await r.server.acquire('1.57.0');
        expect(r.started).toHaveLength(1);
        expect(b).toEqual(a);
    });

    it('stops when idle: no connection past the idle window', async () => {
        const r = rig(0);
        await r.server.acquire('1.57.0');
        r.advance(599_000);
        expect(await r.server.sweep()).toBe('kept');
        r.advance(2_000);
        expect(await r.server.sweep()).toBe('stopped');
        expect(r.stopped).toHaveLength(1);
        expect(r.server.running()).toBeNull();
    });

    it('does not stop while a test is connected, however long it has run', async () => {
        const r = rig(1);
        await r.server.acquire('1.57.0');
        r.advance(3_600_000);
        expect(await r.server.sweep()).toBe('kept');
        expect(r.stopped).toHaveLength(0);
    });

    it('a connection resets the idle clock', async () => {
        const r = rig(1);
        await r.server.acquire('1.57.0');
        r.advance(3_600_000);
        await r.server.sweep();
        r.setConnections(0);
        r.advance(300_000);
        expect(await r.server.sweep()).toBe('kept');
        r.advance(400_000);
        expect(await r.server.sweep()).toBe('stopped');
    });

    it('starts again after an idle stop, on a new port and token', async () => {
        const r = rig(0);
        const first = await r.server.acquire('1.57.0');
        r.advance(700_000);
        await r.server.sweep();
        const second = await r.server.acquire('1.57.0');
        expect(r.started).toHaveLength(2);
        expect(second.token).not.toBe(first.token);
        expect(second.port).not.toBe(first.port);
    });

    it('serves one version at a time: a different version replaces the idle server', async () => {
        const r = rig(0);
        await r.server.acquire('1.57.0');
        const other = await r.server.acquire('1.58.0');
        expect(other.version).toBe('1.58.0');
        expect(r.stopped).toHaveLength(1);
        expect(r.started).toHaveLength(2);
    });

    it('says off when nothing runs', async () => {
        expect(await rig().server.sweep()).toBe('off');
    });
});

describe('what an idle server is', () => {
    it('stops past the window with no connection', () => {
        expect(decideIdle({ lastActiveAt: 0, now: 700_000, idleMs: 600_000, connections: 0 })).toBe('stop');
    });
    it('keeps inside the window, and while anything is connected', () => {
        expect(decideIdle({ lastActiveAt: 0, now: 500_000, idleMs: 600_000, connections: 0 })).toBe('keep');
        expect(decideIdle({ lastActiveAt: 0, now: 9_000_000, idleMs: 600_000, connections: 2 })).toBe('keep');
    });
    it('keeps when the connection count cannot be read: an unreadable gauge is not an idle server', () => {
        expect(decideIdle({ lastActiveAt: 0, now: 9_000_000, idleMs: 600_000, connections: null })).toBe('keep');
    });
});

describe('counting a server’s connections from the OS', () => {
    const win = [
        '  Proto  Local Address          Foreign Address        State',
        '  TCP    127.0.0.1:4444         0.0.0.0:0              LISTENING',
        '  TCP    127.0.0.1:4444         127.0.0.1:50001        ESTABLISHED',
        '  TCP    127.0.0.1:50001        127.0.0.1:4444         ESTABLISHED',
        '  TCP    127.0.0.1:4445         127.0.0.1:50002        ESTABLISHED',
    ].join('\n');
    const ss = [
        'State  Recv-Q Send-Q Local Address:Port Peer Address:Port',
        'ESTAB  0      0      127.0.0.1:4444     127.0.0.1:50001',
        'ESTAB  0      0      127.0.0.1:50001    127.0.0.1:4444',
        'LISTEN 0      511    127.0.0.1:4444     0.0.0.0:*',
    ].join('\n');
    it('counts the connections TO the port from netstat, not the listener or the client’s own end', () => {
        expect(countEstablished(win, 4444)).toBe(1);
        expect(countEstablished(win, 4445)).toBe(1);
        expect(countEstablished(win, 9999)).toBe(0);
    });
    it('counts them from ss', () => {
        expect(countEstablished(ss, 4444)).toBe(1);
    });
    it('does not read an empty or unrecognisable answer as zero', () => {
        expect(countEstablished('', 4444)).toBe(-1);
        expect(countEstablished('command not found', 4444)).toBe(-1);
    });
});

describe('linking a worktree’s node_modules to the main checkout', () => {
    const lock = '{"lockfileVersion":3}';
    it('links when the lockfiles are identical and the worktree has none', () => {
        expect(worktreeLinkDecision({ mainLock: lock, worktreeLock: lock, mainHasNodeModules: true, worktreeHasNodeModules: false })).toEqual({ link: true });
    });
    it('refuses when the lockfiles differ', () => {
        const r = worktreeLinkDecision({ mainLock: lock, worktreeLock: '{"lockfileVersion":3,"x":1}', mainHasNodeModules: true, worktreeHasNodeModules: false });
        expect(r.link).toBe(false);
        expect(r.reason).toMatch(/lockfile/i);
    });
    it('refuses when either side has no lockfile: nothing proves they match', () => {
        expect(worktreeLinkDecision({ mainLock: null, worktreeLock: null, mainHasNodeModules: true, worktreeHasNodeModules: false }).link).toBe(false);
        expect(worktreeLinkDecision({ mainLock: lock, worktreeLock: null, mainHasNodeModules: true, worktreeHasNodeModules: false }).link).toBe(false);
    });
    it('refuses when the main checkout has nothing installed to link to', () => {
        expect(worktreeLinkDecision({ mainLock: lock, worktreeLock: lock, mainHasNodeModules: false, worktreeHasNodeModules: false }).link).toBe(false);
    });
    it('never replaces a node_modules the worktree already has', () => {
        const r = worktreeLinkDecision({ mainLock: lock, worktreeLock: lock, mainHasNodeModules: true, worktreeHasNodeModules: true });
        expect(r.link).toBe(false);
        expect(r.reason).toMatch(/already/i);
    });
});

describe('what agents are told', () => {
    it('says browsers and the Playwright server are provided, and not to install them per worktree', () => {
        const text = sharedProtocol([], 'files');
        expect(text).toMatch(/Playwright/);
        expect(text).toMatch(/PLAYWRIGHT_BROWSERS_PATH/);
        expect(text).toMatch(/not .*install/i);
    });
});

describe('stopping the server ends it, and a stop that does not exit is forced', () => {
    const PID = 4242;
    function rig(alive: () => boolean, forceEnd: (pid: number) => Promise<void>) {
        const forced: number[] = [];
        const slept: number[] = [];
        let state: 'running' | 'stopped' = 'stopped';
        const ports: PlaywrightServerPorts = {
            supervisor: {
                start: (spec) => { state = 'running'; return { id: spec.id, workspaceId: spec.workspaceId, name: spec.name, state: 'running', pid: PID, exitCode: null, restarts: 0, since: 0 }; },
                stop: () => { state = 'stopped'; return true; },
                status: (id) => ({ id, workspaceId: 'w', name: 'n', state, pid: state === 'running' ? PID : null, exitCode: null, restarts: 0, since: 0 }),
            },
            workspaceId: 'genie', cwd: TC, cliDir: (v) => join(TC, 'playwright', 'cli', v),
            allocatePort: () => 4001, mintToken: () => 'q'.repeat(32), now: () => 1, connections: async () => 0, idleMs: 600_000,
            pidAlive: () => alive(),
            forceEnd: async (pid) => { forced.push(pid); await forceEnd(pid); },
            sleep: async (ms) => { slept.push(ms); },
            forceAfterMs: 5_000,
        };
        return { server: new PlaywrightServer(ports), forced, slept };
    }

    it('says ended, and forces nothing, when the process is gone', async () => {
        const r = rig(() => false, async () => {});
        r.server.acquire('1.57.0');
        expect(await r.server.stop()).toBe('ended');
        expect(r.forced).toEqual([]);
    });

    it('waits for a process that exits shortly after, and still forces nothing', async () => {
        let polls = 0;
        const r = rig(() => ++polls < 3, async () => {});
        r.server.acquire('1.57.0');
        expect(await r.server.stop()).toBe('ended');
        expect(r.forced).toEqual([]);
        expect(r.slept.length).toBeGreaterThan(0);
    });

    it('forces the process, with its whole tree, when it is still there after the grace', async () => {
        const r = rig(() => true, async () => {});
        r.server.acquire('1.57.0');
        expect(await r.server.stop()).toBe('forced');
        expect(r.forced).toEqual([PID]);
    });

    it('never hangs on a forced end that itself does not return', async () => {
        const r = rig(() => true, () => new Promise<void>(() => {}));
        r.server.acquire('1.57.0');
        expect(await r.server.stop()).toBe('forced');
    });

    it('never hangs on a forced end that fails', async () => {
        const r = rig(() => true, async () => { throw new Error('access denied'); });
        r.server.acquire('1.57.0');
        expect(await r.server.stop()).toBe('forced');
    });

    it('is not blocked by a stop in flight: the next ask starts a fresh server', async () => {
        const r = rig(() => true, () => new Promise<void>(() => {}));
        const first = r.server.acquire('1.57.0');
        void r.server.stop();
        const second = r.server.acquire('1.57.0');
        expect(second.port).toBe(first.port);
        expect(r.server.running()).not.toBeNull();
    });
});
