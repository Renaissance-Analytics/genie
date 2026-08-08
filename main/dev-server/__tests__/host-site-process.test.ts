import { describe, expect, it, vi } from 'vitest';
import {
    composeHostSiteEnv,
    startHostSite,
    stopHostSite,
    hostSiteAlive,
    killTreeWinArgv,
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
