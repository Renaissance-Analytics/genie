import { describe, expect, it, vi } from 'vitest';
import { createServiceManager } from '../manager';
import { serviceIdFor } from '../config';
import { MANAGED_BEGIN } from '../env';
import type { ServiceManagerDeps, ServicesWorkspace } from '../manager';
import type { WorkspaceServices } from '../config';
import type { ServiceFs, ServiceInstance, ServiceRuntime, ServiceStatus } from '../types';

/**
 * The service manager's POLICY, with nothing downloaded and no port bound.
 *
 * What is being defended here is mostly about restraint: a workspace that wants
 * no database downloads nothing; two that want one at the same moment share ONE
 * download; a workspace with a broken cluster does not take the others (or the
 * app) down with it; and the credentials only ever reach a `.env` that already
 * exists, in a block that leaves the rest of the file alone.
 */

// --- fakes -----------------------------------------------------------------

function fakeRuntime(engine: 'postgres' | 'garnet'): ServiceRuntime & {
    started: ServiceInstance[];
    stopped: string[];
    fail?: string;
} {
    const statuses = new Map<string, ServiceStatus>();
    const rt = {
        engine,
        started: [] as ServiceInstance[],
        stopped: [] as string[],
        fail: undefined as string | undefined,
        async start(instance: ServiceInstance) {
            rt.started.push(instance);
            const status: ServiceStatus = rt.fail
                ? {
                      serviceId: instance.id,
                      kind: instance.kind,
                      engine,
                      state: 'failed',
                      endpoint: null,
                      error: rt.fail,
                  }
                : {
                      serviceId: instance.id,
                      kind: instance.kind,
                      engine,
                      state: 'running',
                      endpoint: { host: '127.0.0.1', port: instance.port },
                  };
            statuses.set(instance.id, status);
            return status;
        },
        async stop(serviceId: string) {
            rt.stopped.push(serviceId);
            statuses.delete(serviceId);
        },
        status: (serviceId: string) =>
            statuses.get(serviceId) ?? {
                serviceId,
                kind: engine === 'postgres' ? ('postgres' as const) : ('redis' as const),
                engine,
                state: 'stopped' as const,
                endpoint: null,
            },
        logs: () => 'log tail',
        async stopAll() {
            statuses.clear();
        },
    };
    return rt;
}

function fakeFs(files: Record<string, string> = {}): ServiceFs & { files: Map<string, string> } {
    const map = new Map(Object.entries(files).map(([k, v]) => [k.replace(/\\/g, '/'), v]));
    return {
        files: map,
        async exists(p) {
            return map.has(p.replace(/\\/g, '/'));
        },
        async mkdir() {},
        async write(p, contents) {
            map.set(p.replace(/\\/g, '/'), contents);
        },
        async read(p) {
            return map.get(p.replace(/\\/g, '/')) ?? null;
        },
        async remove(p) {
            map.delete(p.replace(/\\/g, '/'));
        },
    };
}

const PG_ID = serviceIdFor('w1', 'postgres');
const REDIS_ID = serviceIdFor('w1', 'redis');

function harness(
    over: {
        workspaces?: ServicesWorkspace[];
        services?: Record<string, WorkspaceServices>;
        fs?: ServiceFs;
        deps?: Partial<ServiceManagerDeps>;
    } = {},
) {
    const workspaces = over.workspaces ?? [{ id: 'w1', path: '/repo/w1' }];
    const services = over.services ?? {
        w1: { [PG_ID]: { enabled: true, kind: 'postgres', password: 'pw', database: 'genie' } },
    };
    const postgres = fakeRuntime('postgres');
    const redis = fakeRuntime('garnet');
    const ensurePostgres = vi.fn(async () => ({
        binDir: '/pg/bin',
        serverPath: '/pg/bin/postgres',
        initdbPath: '/pg/bin/initdb',
        psqlPath: '/pg/bin/psql',
        createdbPath: '/pg/bin/createdb',
        pgCtlPath: '/pg/bin/pg_ctl',
        version: '17.6',
        installDir: '/pg',
        downloaded: false,
        system: false,
    }));
    const ensureGarnet = vi.fn(async () => ({
        version: 'v2.1.1',
        installDir: '/g',
        serverPath: '/g/GarnetServer',
        downloaded: false,
    }));
    const ensureDotnet = vi.fn(async () => ({
        version: '10.0.10',
        installDir: '/d',
        dotnetRoot: '/d',
        hostPath: '/d/dotnet',
        downloaded: false,
    }));
    const fs = over.fs ?? fakeFs();
    const manager = createServiceManager({
        baseDir: '/base',
        listWorkspaces: () => workspaces,
        servicesFor: (id) => services[id] ?? {},
        ensurePostgres,
        ensureGarnet,
        ensureDotnet,
        createPostgres: () => postgres,
        createRedis: () => redis,
        fs,
        ...over.deps,
    });
    return { manager, postgres, redis, ensurePostgres, ensureGarnet, ensureDotnet, fs, services };
}

// --- fetch on first use ----------------------------------------------------

describe('fetch on first use', () => {
    it('downloads NOTHING for a workspace with no services', async () => {
        const h = harness({ services: { w1: {} } });
        await h.manager.reconcile();
        expect(h.ensurePostgres).not.toHaveBeenCalled();
        expect(h.ensureGarnet).not.toHaveBeenCalled();
        expect(h.ensureDotnet).not.toHaveBeenCalled();
    });

    it('fetches only the engine that was asked for', async () => {
        const h = harness();
        await h.manager.reconcile();
        expect(h.ensurePostgres).toHaveBeenCalledTimes(1);
        // A workspace wanting a database must not pull a 48 MB cache server too.
        expect(h.ensureGarnet).not.toHaveBeenCalled();
    });

    it('fetches the .NET runtime ALONGSIDE garnet, never alone', async () => {
        // Garnet is published framework-dependent; installing one without the
        // other leaves a server that cannot start.
        const h = harness({
            services: { w1: { [REDIS_ID]: { enabled: true, kind: 'redis' } } },
        });
        await h.manager.reconcile();
        expect(h.ensureGarnet).toHaveBeenCalledTimes(1);
        expect(h.ensureDotnet).toHaveBeenCalledTimes(1);
    });

    it('shares ONE download between concurrent starts', async () => {
        // Two windows enabling a database at the same moment must not race into
        // one staging directory.
        const h = harness({
            workspaces: [
                { id: 'w1', path: '/repo/w1' },
                { id: 'w2', path: '/repo/w2' },
            ],
            services: {
                w1: { [PG_ID]: { enabled: true, kind: 'postgres', password: 'a', database: 'x' } },
                w2: {
                    [serviceIdFor('w2', 'postgres')]: {
                        enabled: true,
                        kind: 'postgres',
                        password: 'b',
                        database: 'y',
                    },
                },
            },
        });
        await Promise.all([h.manager.start('w1', 'postgres'), h.manager.start('w2', 'postgres')]);
        expect(h.ensurePostgres).toHaveBeenCalledTimes(1);
    });

    it('does not poison later attempts when a fetch fails', async () => {
        // The network may simply have been down.
        let calls = 0;
        const ensurePostgres = vi.fn(async () => {
            calls += 1;
            if (calls === 1) throw new Error('ENOTFOUND');
            return {
                binDir: '/pg/bin',
                serverPath: '/pg/bin/postgres',
                initdbPath: '/i',
                psqlPath: '/p',
                createdbPath: '/c',
                pgCtlPath: '/ctl',
                version: '17.6',
                installDir: '/pg',
                downloaded: true,
                system: false,
            };
        });
        const h = harness({ deps: { ensurePostgres } });
        const first = await h.manager.start('w1', 'postgres');
        expect(first.state).toBe('failed');
        expect(first.error).toContain('ENOTFOUND');
        expect((await h.manager.start('w1', 'postgres')).state).toBe('running');
    });
});

// --- reconcile -------------------------------------------------------------

describe('reconcile', () => {
    it('starts what is enabled and leaves what is not', async () => {
        const h = harness({
            services: {
                w1: {
                    [PG_ID]: { enabled: true, kind: 'postgres', password: 'p', database: 'genie' },
                    [REDIS_ID]: { enabled: false, kind: 'redis' },
                },
            },
        });
        await h.manager.reconcile();
        expect(h.postgres.started).toHaveLength(1);
        expect(h.redis.started).toHaveLength(0);
    });

    it('stops a service that is no longer enabled', async () => {
        const services: Record<string, WorkspaceServices> = {
            w1: { [PG_ID]: { enabled: true, kind: 'postgres', password: 'p', database: 'genie' } },
        };
        const h = harness({ services });
        await h.manager.reconcile();
        expect(h.manager.list('w1')[0]!.state).toBe('running');

        services.w1![PG_ID]!.enabled = false;
        await h.manager.reconcile();
        expect(h.postgres.stopped).toEqual([PG_ID]);
    });

    it('one broken service does not stop the others starting', async () => {
        const h = harness({
            services: {
                w1: {
                    [PG_ID]: { enabled: true, kind: 'postgres', password: 'p', database: 'genie' },
                    [REDIS_ID]: { enabled: true, kind: 'redis' },
                },
            },
        });
        h.postgres.fail = 'data directory is corrupt';
        await h.manager.reconcile();
        const rows = h.manager.list('w1');
        expect(rows.find((r) => r.kind === 'postgres')!.state).toBe('failed');
        expect(rows.find((r) => r.kind === 'redis')!.state).toBe('running');
    });

    it('KEEPS the reason a service failed, rather than showing it as merely off', async () => {
        const h = harness();
        h.postgres.fail = 'initdb failed (1): permission denied';
        await h.manager.reconcile();
        const row = h.manager.list('w1')[0]!;
        expect(row.state).toBe('failed');
        expect(row.error).toContain('permission denied');
    });
});

// --- isolation -------------------------------------------------------------

describe('isolation', () => {
    it('gives two workspaces different ports and data directories', async () => {
        const h = harness({
            workspaces: [
                { id: 'w1', path: '/repo/w1' },
                { id: 'w2', path: '/repo/w2' },
            ],
            services: {
                w1: { [PG_ID]: { enabled: true, kind: 'postgres', password: 'a', database: 'x' } },
                w2: {
                    [serviceIdFor('w2', 'postgres')]: {
                        enabled: true,
                        kind: 'postgres',
                        password: 'b',
                        database: 'y',
                    },
                },
            },
        });
        await h.manager.reconcile();
        const [a, b] = h.postgres.started;
        expect(a!.port).not.toBe(b!.port);
        expect(a!.dataDir).not.toBe(b!.dataDir);
        expect(a!.password).not.toBe(b!.password);
    });

    it('lists a stopped service with the port it WOULD take', async () => {
        // The Site Manager shows the endpoint before anything has started.
        const h = harness({
            services: { w1: { [PG_ID]: { enabled: false, kind: 'postgres', password: 'p' } } },
        });
        const row = h.manager.list('w1')[0]!;
        expect(row.state).toBe('stopped');
        expect(row.port).toBeGreaterThanOrEqual(21_000);
        expect(row.endpoint).toBeNull();
    });

    it('never puts a password in a listed row', async () => {
        const h = harness();
        await h.manager.reconcile();
        expect(JSON.stringify(h.manager.list())).not.toContain('pw');
    });
});

// --- the environment a hosted site is given --------------------------------

describe('envFor', () => {
    it('describes only the RUNNING services', async () => {
        const h = harness();
        expect(h.manager.envFor('w1')).toEqual({});
        await h.manager.reconcile();
        expect(h.manager.envFor('w1')).toMatchObject({
            DB_CONNECTION: 'pgsql',
            DB_HOST: '127.0.0.1',
            DB_DATABASE: 'genie',
            DB_PASSWORD: 'pw',
        });
    });

    it('does not leak one workspace credentials into another', async () => {
        const h = harness({
            workspaces: [
                { id: 'w1', path: '/repo/w1' },
                { id: 'w2', path: '/repo/w2' },
            ],
            services: {
                w1: { [PG_ID]: { enabled: true, kind: 'postgres', password: 'a', database: 'x' } },
            },
        });
        await h.manager.reconcile();
        expect(h.manager.envFor('w2')).toEqual({});
    });
});

// --- writing the app's .env ------------------------------------------------

describe('writeEnvFile', () => {
    it('NEVER creates a .env that was not already there', async () => {
        // A directory with no configuration to extend is not a Laravel app that
        // wants credentials dropped into it.
        const fs = fakeFs();
        const h = harness({ fs });
        const result = await h.manager.writeEnvFile('w1');
        expect(result.path).toBeNull();
        expect(result.changed).toBe(false);
        expect(fs.files.size).toBe(0);
    });

    it('adds the managed block to an existing .env, keeping the rest', async () => {
        const fs = fakeFs({ '/repo/w1/.env': 'APP_NAME=Laravel\nMAIL_HOST=smtp\n' });
        const h = harness({ fs });
        const result = await h.manager.writeEnvFile('w1');
        expect(result.changed).toBe(true);
        const written = fs.files.get('/repo/w1/.env')!;
        expect(written).toContain(MANAGED_BEGIN);
        expect(written).toContain('DB_DATABASE=genie');
        expect(written).toContain('APP_NAME=Laravel');
        expect(written).toContain('MAIL_HOST=smtp');
    });

    it('writes from the CONFIG, not from what is running', async () => {
        // `artisan migrate` has to work before anything has been started.
        const fs = fakeFs({ '/repo/w1/.env': 'APP_NAME=Laravel\n' });
        const h = harness({ fs });
        await h.manager.writeEnvFile('w1');
        expect(fs.files.get('/repo/w1/.env')).toContain('DB_CONNECTION=pgsql');
        expect(h.postgres.started).toHaveLength(0);
    });

    it('removes the block when the workspace services are disabled', async () => {
        const fs = fakeFs({ '/repo/w1/.env': 'APP_NAME=Laravel\n' });
        const services: Record<string, WorkspaceServices> = {
            w1: { [PG_ID]: { enabled: true, kind: 'postgres', password: 'p', database: 'genie' } },
        };
        const h = harness({ fs, services });
        await h.manager.writeEnvFile('w1');
        services.w1![PG_ID]!.enabled = false;
        await h.manager.writeEnvFile('w1');
        const written = fs.files.get('/repo/w1/.env')!;
        expect(written).not.toContain(MANAGED_BEGIN);
        expect(written).toContain('APP_NAME=Laravel');
    });

    it('reports a key the user also sets, instead of fighting for it', async () => {
        const fs = fakeFs({ '/repo/w1/.env': 'DB_PASSWORD=production-secret\n' });
        const h = harness({ fs });
        const result = await h.manager.writeEnvFile('w1');
        expect(result.conflicts).toContain('DB_PASSWORD');
        expect(fs.files.get('/repo/w1/.env')).toContain('DB_PASSWORD=production-secret');
    });
});

// --- logs ------------------------------------------------------------------

describe('logs', () => {
    it('returns the running service log tail', async () => {
        const h = harness();
        await h.manager.reconcile();
        expect(h.manager.logs('w1', 'postgres')).toBe('log tail');
    });

    it('is empty for a service that was never started', () => {
        const h = harness();
        expect(h.manager.logs('w1', 'postgres')).toBe('');
    });
});
