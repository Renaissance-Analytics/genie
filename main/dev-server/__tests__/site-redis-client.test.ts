import { describe, expect, it, vi } from 'vitest';
import { createDevSiteManager, type DevSiteManagerDeps } from '../site-manager';
import { devSiteIdFor, type DevSiteConfig, type HostServeConfig } from '../sites-config';

const CGI = '/managed/php/8.4.24/php-cgi.exe';
const CLI = '/managed/php/8.4.24/php.exe';
const FRANKEN = '/managed/frankenphp/frankenphp.exe';
const FRANKEN_PROBE = [FRANKEN, 'php-cli', '-r', 'echo "[PHP Modules]\\n", implode("\\n", get_loaded_extensions()), "\\n[Zend Modules]\\n";'];
const id = devSiteIdFor('workspace', 'app');

function harness(mode: HostServeConfig | undefined, loaded = false, redis = true, ownEnv = {}) {
    const site: DevSiteConfig = {
        name: 'app', repo: 'app', genName: 'app.gen', kind: 'http', enabled: true,
        runMode: 'host', ...(mode ? { hostServe: mode } : { command: [CLI, 'artisan', 'serve'] }), env: ownEnv,
    };
    const start = vi.fn(async () => ({ ok: true as const, pid: 1 }));
    const probePhpRedis = vi.fn(async () => loaded);
    let port = 5200;
    const deps: DevSiteManagerDeps & { probePhpRedis: typeof probePhpRedis } = {
        listWorkspaces: () => [{ id: 'workspace', path: '/workspace' }],
        devSitesFor: () => ({ [id]: site }),
        resolveRuntime: async () => ({ runtime: null, detection: { kind: 'none', probes: [] } }),
        hostSpawn: { start, stop: async () => {}, alive: async () => true, readLog: async () => '' },
        probeReady: async () => true, allocateFreePort: async () => ++port,
        caddyBin: '/managed/caddy', writeServeConfig: () => '/config/Caddyfile',
        prepareUploadTmpDir: () => '/uploads', readComposerJson: () => null,
        resolveEngine: async ({ bin }) => ({ ok: true, exe: bin === 'php-cgi' ? CGI : CLI, version: '8.4.24',
            install: { tool: 'php', version: '8.4.24', dir: '/managed/php/8.4.24', exe: CLI, source: 'genie', removable: true } }),
        resolveFrankenphp: async () => ({ ok: true, exe: FRANKEN, phpVersion: '8.5.10' }),
        resolveRoadrunner: async () => ({ ok: true, exe: '/managed/rr' }),
        octaneCanWatch: () => false, platform: 'linux', baseEnv: { PATH: '/bin' },
        serviceHostEnvFor: async (): Promise<Record<string, string>> => redis ? { REDIS_HOST: '127.0.0.1', REDIS_PORT: '6380' } : {},
        probePhpRedis,
    };
    return { manager: createDevSiteManager(deps), start, probePhpRedis };
}

describe('a PHP site receives a Redis client its serving runtime supports', () => {
    it.each([
        [{ mode: 'php', root: 'public' }, [CGI, '-m']],
        [{ mode: 'frankenphp', root: 'public' }, FRANKEN_PROBE],
        [{ mode: 'octane', server: 'frankenphp' }, FRANKEN_PROBE],
        [{ mode: 'octane', server: 'roadrunner' }, [CLI, '-m']],
        [{ mode: 'octane', server: 'swoole' }, [CLI, '-m']],
        [undefined, [CLI, '-m']],
    ] as Array<[HostServeConfig | undefined, string[]]>)('checks the serving binary for %j', async (mode, command) => {
        const h = harness(mode);
        expect((await h.manager.start('workspace', id)).state).toBe('running');
        expect(h.start).toHaveBeenCalled();
        for (const [run] of h.start.mock.calls as unknown as Array<[{ env: Record<string, string> }]>) {
            expect(run.env.REDIS_HOST).toBe('127.0.0.1');
            expect(run.env.REDIS_CLIENT).toBe('predis');
        }
        expect(h.probePhpRedis).toHaveBeenCalledWith(expect.objectContaining({ command, cwd: expect.stringContaining('app') }));
    });

    it('positively selects phpredis when the actual binary loads redis', async () => {
        const h = harness({ mode: 'php', root: 'public' }, true);
        await h.manager.start('workspace', id);
        expect(h.start).toHaveBeenCalledWith(expect.objectContaining({ env: expect.objectContaining({ REDIS_CLIENT: 'phpredis' }) }));
    });

    it('replaces an incompatible pinned client but preserves an explicit predis choice', async () => {
        for (const loaded of [false, true]) {
            const h = harness({ mode: 'php', root: 'public' }, loaded, true, { REDIS_CLIENT: loaded ? 'predis' : 'phpredis' });
            await h.manager.start('workspace', id);
            expect(h.start).toHaveBeenCalledWith(expect.objectContaining({ env: expect.objectContaining({ REDIS_CLIENT: 'predis' }) }));
        }
    });

    it.each([false, true])('does not probe or add a PHP client to a static site (Redis=%s)', async (redis) => {
        const h = harness({ mode: 'static', root: 'public' }, false, redis);
        expect((await h.manager.start('workspace', id)).state).toBe('running');
        expect(h.start).toHaveBeenCalledWith(expect.objectContaining({ env: expect.not.objectContaining({ REDIS_CLIENT: expect.anything() }) }));
        expect(h.probePhpRedis).not.toHaveBeenCalled();
    });

    it('leaves PHP sites without managed Redis alone', async () => {
        const h = harness({ mode: 'php', root: 'public' }, false, false);
        expect((await h.manager.start('workspace', id)).state).toBe('running');
        expect(h.start).toHaveBeenCalled();
        expect(h.probePhpRedis).not.toHaveBeenCalled();
    });
});
