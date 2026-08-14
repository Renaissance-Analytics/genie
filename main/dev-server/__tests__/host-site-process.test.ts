import { describe, expect, it, vi } from 'vitest';
import {
    composeHostSiteEnv,
    startHostSite,
    stopHostSite,
    hostSiteAlive,
    killTreeWinArgv,
    hostSpawnInvocation,
    describeHostSpawnFailure,
    describeEmptyHostServiceEnv,
    type HostSpawnPrimitives,
} from '../host-site-process';
import type { DevSiteConfig } from '../sites-config';

/**
 * Env composition for a host-native site process (story #238, task #672). Same
 * precedence as the sandbox path (weakest first, the workspace service env WINS),
 * but the service env is HOST-form (127.0.0.1:<published port>) and, because the
 * process runs on the host, `localhost` already IS the host — so the gateway is
 * plain loopback, not the sandbox's host-gateway address.
 */
function cfg(over: Partial<DevSiteConfig> = {}): DevSiteConfig {
    return { name: 'app', genName: 'app.gen', kind: 'http', port: 8080, ...over } as DevSiteConfig;
}

describe('composeHostSiteEnv', () => {
    it('sets GENIE_HOST_GATEWAY to plain loopback (localhost IS the host now)', () => {
        const env = composeHostSiteEnv(cfg(), ['php', 'artisan', 'serve'], {});
        expect(env.GENIE_HOST_GATEWAY).toBe('127.0.0.1');
    });

    it('lets the workspace host-form service env WIN over the site\'s own env', () => {
        const env = composeHostSiteEnv(
            cfg({ env: { DB_HOST: 'user-set', APP_ENV: 'local' } }),
            ['node', 'server.js'],
            { DB_HOST: '127.0.0.1', DB_PORT: '54329' },
        );
        expect(env.DB_HOST).toBe('127.0.0.1'); // service env wins
        expect(env.DB_PORT).toBe('54329');
        expect(env.APP_ENV).toBe('local'); // site env preserved where not overridden
    });

    it('keeps the site\'s own env above the (weakest) gateway default', () => {
        const env = composeHostSiteEnv(cfg({ env: { GENIE_HOST_GATEWAY: 'overridden' } }), ['x'], {});
        expect(env.GENIE_HOST_GATEWAY).toBe('overridden');
    });
});

function prims(over: Partial<HostSpawnPrimitives> = {}): HostSpawnPrimitives {
    return {
        platform: 'linux',
        spawnDetached: vi.fn().mockReturnValue(4242),
        signal: vi.fn().mockReturnValue(true),
        killTreeWin: vi.fn().mockResolvedValue(undefined),
        ...over,
    };
}

describe('host site spawn lifecycle', () => {
    it('starts a detached process and returns its pid', () => {
        const p = prims();
        const pid = startHostSite({ command: ['node', 's.js'], cwd: '/r', env: {}, logPath: '/l' }, p);
        expect(pid).toBe(4242);
        expect(p.spawnDetached).toHaveBeenCalledOnce();
    });

    it('refuses an empty command rather than spawn nothing', () => {
        expect(() => startHostSite({ command: [], cwd: '/r', env: {}, logPath: '/l' }, prims())).toThrow();
    });

    it('stops the whole process GROUP on posix (negative pid)', async () => {
        const p = prims({ platform: 'linux' });
        await stopHostSite(4242, p);
        expect(p.signal).toHaveBeenCalledWith(-4242, 'SIGTERM');
        expect(p.killTreeWin).not.toHaveBeenCalled();
    });

    it('stops via taskkill /t on windows (no process groups)', async () => {
        const p = prims({ platform: 'win32' });
        await stopHostSite(4242, p);
        expect(p.killTreeWin).toHaveBeenCalledWith(4242);
        expect(p.signal).not.toHaveBeenCalled();
    });

    it('reports liveness via signal 0', () => {
        expect(hostSiteAlive(4242, prims({ signal: () => true }))).toBe(true);
        expect(hostSiteAlive(4242, prims({ signal: () => false }))).toBe(false);
    });

    it('killTreeWinArgv targets the whole tree, forcefully', () => {
        expect(killTreeWinArgv(4242)).toEqual(['taskkill', '/pid', '4242', '/t', '/f']);
    });
});

/**
 * How a host-native dev server is actually launched on each platform (genie#…,
 * the moic "no pid" report). On Windows the dev-server entrypoints are shims —
 * `npm`/`pnpm`/`yarn` are `.cmd`, `php` may be a `.bat` — which `spawn` CANNOT
 * launch without a shell, so the "no pid" the reporter saw is a spawn that never
 * happened. The invocation therefore differs by platform, and the failure has to
 * NAME the binary rather than say only "no pid".
 */
describe('hostSpawnInvocation', () => {
    it('runs the command THROUGH the shell on Windows so a .cmd/.bat shim resolves', () => {
        // `npm` is `npm.cmd` on Windows — spawn without a shell fails with ENOENT,
        // which is exactly the "no pid" the reporter hit.
        expect(hostSpawnInvocation(['npm', 'run', 'dev'], 'win32')).toEqual({
            file: 'npm run dev',
            args: [],
            shell: true,
            detached: false,
        });
    });

    it('does NOT detach on Windows — a detached console pops a stray terminal window', () => {
        // detached:true on Windows makes the child allocate a NEW CONSOLE, which
        // appears as a terminal window OUTSIDE Genie (the `php artisan serve` window
        // the user saw). `windowsHide` does not suppress a detached console. Windows
        // has no process groups anyway — the tree is killed with `taskkill /t`.
        expect(hostSpawnInvocation(['php', 'artisan', 'serve'], 'win32').detached).toBe(false);
    });

    it('quotes a Windows token that carries a space so it stays ONE argument', () => {
        const inv = hostSpawnInvocation(
            ['php', 'artisan', 'serve', '--path=C:/My Repos/app'],
            'win32',
        );
        expect(inv.shell).toBe(true);
        expect(inv.file).toBe('php artisan serve "--path=C:/My Repos/app"');
    });

    it('quotes the BINARY itself — a resolved php-cgi lives under a user profile', () => {
        // Since genie#207 command[0] is an absolute path into Genie's toolchain, not
        // a bare `php-cgi`. That path runs through `<userData>`, so on any machine
        // whose account name has a space an unquoted command[0] would be split and
        // cmd.exe would report "not recognized" — genie#206's symptom exactly, from a
        // brand new cause.
        const exe = 'C:\\Users\\Wish Born\\AppData\\Roaming\\Genie\\toolchain\\php\\8.3.33\\php-cgi.exe';
        expect(hostSpawnInvocation([exe, '-b', '127.0.0.1:5322'], 'win32').file).toBe(
            `"${exe}" -b 127.0.0.1:5322`,
        );
    });

    it('runs the binary DIRECTLY on posix, detached as its own group leader', () => {
        // No shell (so the dev server itself is the process-GROUP leader the `-pid`
        // SIGTERM in stopHostSite reaches); detached to make that group. There is no
        // console on posix, so no window.
        expect(hostSpawnInvocation(['php', 'artisan', 'serve'], 'linux')).toEqual({
            file: 'php',
            args: ['artisan', 'serve'],
            shell: false,
            detached: true,
        });
    });
});

describe('describeHostSpawnFailure', () => {
    it('names the binary and the host-toolchain requirement — not just "no pid"', () => {
        const msg = describeHostSpawnFailure(['php', 'artisan', 'serve']);
        expect(msg).toContain('php');
        expect(msg).toMatch(/PATH/);
    });

    it('folds in the underlying errno when the async error carried one', () => {
        expect(describeHostSpawnFailure(['php'], 'ENOENT')).toContain('ENOENT');
    });
});

/**
 * The "up but DB-less" trap (moic's beta.245 report): a host-native site whose
 * workspace has services enabled, but whose resolved host-form env is EMPTY, gets
 * started with no DB/cache connection and silently falls back to its repo `.env` —
 * a real request 500s while a cookieless one looks healthy. Instead of that
 * silence, the start writes an actionable `[genie]` diagnostic that names WHY the
 * env is empty. This is that message; it must stay silent (null) when there is
 * nothing wrong.
 */
describe('describeEmptyHostServiceEnv', () => {
    it('is silent when the workspace has NO services enabled — nothing to inject', () => {
        expect(
            describeEmptyHostServiceEnv({ enabled: 0, live: 0, withHostPort: 0, missingHostPort: [] }),
        ).toBeNull();
    });

    it('is silent when at least one service contributed env (host env is NOT empty)', () => {
        expect(
            describeEmptyHostServiceEnv({ enabled: 2, live: 2, withHostPort: 2, missingHostPort: [] }),
        ).toBeNull();
    });

    it('warns, and points at a workspace/config mismatch, when enabled services are NONE live here', () => {
        const msg = describeEmptyHostServiceEnv({
            enabled: 4,
            live: 0,
            withHostPort: 0,
            missingHostPort: [],
        });
        expect(msg).toContain('4');
        expect(msg).toMatch(/live/i);
        // It must explain the visible symptom so the reader connects it to a 500.
        expect(msg).toMatch(/\.env/);
        expect(msg).toMatch(/500/);
    });

    it('warns, naming the engines, when live services publish no reachable loopback port', () => {
        const msg = describeEmptyHostServiceEnv({
            enabled: 3,
            live: 3,
            withHostPort: 0,
            missingHostPort: ['postgres', 'redis'],
        });
        expect(msg).toContain('postgres');
        expect(msg).toContain('redis');
        expect(msg).toMatch(/loopback|port/i);
        expect(msg).toMatch(/\.env/);
    });
});
