import { describe, expect, it } from 'vitest';
import { SERVICE_CATALOG, containerPlan, serviceEnvFor, switchActiveWarning, type ServiceInstance } from '../src/core/services.js';

/**
 * SERVICE ENGINES (§6.6) — the pure half. Shared and dedicated services (Postgres, Redis, …) in
 * containers with port isolation only (the owner's host-native decision); a shared engine is ONE
 * workstation-level service, never one per workspace ("reverb is a whole app"). The env a workspace
 * gets is HOST-FORM — `127.0.0.1:<published port>` — because host processes cannot resolve
 * container names. And the bug v1 shipped: a workspace holding pg16 AND pg17 gave `DATABASE_URL`
 * to the first and `PGHOST` to the last, so an app and a tool reached DIFFERENT databases. Exactly
 * ONE version per engine emits env: the active one, else a deterministic choice.
 */

const pg = (version: string, port: number, over: Partial<ServiceInstance> = {}): ServiceInstance => ({
    id: `svc_pg${version}`,
    engine: 'postgres',
    version,
    scope: { kind: 'dedicated', workspaceId: 'tynn' },
    publishedPort: port,
    credentials: { user: 'genie', password: 'pw', database: 'tynn' },
    active: false,
    ...over,
});

describe('the catalog', () => {
    it('names the engines Genie manages with their image, internal port and env template; each has at least one major', () => {
        const names = SERVICE_CATALOG.map((e) => e.engine);
        for (const e of ['postgres', 'redis', 'mysql', 'mariadb', 'mongo', 'reverb', 'mailpit', 'meilisearch', 'seaweedfs', 'custom']) expect(names).toContain(e);
        // Every engine but `custom`, whose image, port and env are the person's (the instance carries them).
        const typed = SERVICE_CATALOG.filter((e) => !e.custom);
        expect(typed).toHaveLength(SERVICE_CATALOG.length - 1);
        for (const e of typed) {
            expect(e.image).toMatch(/^[a-z0-9./-]+$/);
            expect(e.internalPort).toBeGreaterThan(0);
            expect(e.majors.length).toBeGreaterThan(0);
        }
        expect(SERVICE_CATALOG.find((e) => e.engine === 'custom')).toMatchObject({ image: '', majors: [], sharing: 'dedicated-only' });
    });

    it('reverb is SHARED by nature — the catalog says so, and a dedicated reverb is refused', () => {
        expect(SERVICE_CATALOG.find((e) => e.engine === 'reverb')!.sharing).toBe('shared-only');
        expect(() => containerPlan({ engine: 'reverb', major: '1', scope: { kind: 'dedicated', workspaceId: 'tynn' }, publishedPort: 8080 })).toThrow(/shared/);
    });
});

describe('env wiring — host form, one version per engine', () => {
    it('a single postgres emits the generic DATABASE_URL/DB_* AND the native PG* keys, all pointing at 127.0.0.1:<published port>', () => {
        const env = serviceEnvFor([pg('17', 54321)]);
        expect(env).toEqual({
            DATABASE_URL: 'postgresql://genie:pw@127.0.0.1:54321/tynn',
            DB_CONNECTION: 'pgsql',
            DB_HOST: '127.0.0.1',
            DB_PORT: '54321',
            DB_DATABASE: 'tynn',
            DB_USERNAME: 'genie',
            DB_PASSWORD: 'pw',
            PGHOST: '127.0.0.1',
            PGPORT: '54321',
            PGDATABASE: 'tynn',
            PGUSER: 'genie',
            PGPASSWORD: 'pw',
        });
    });

    it('with pg16 AND pg17 held, the ACTIVE one emits everything and the other emits NOTHING — the generic and native keys agree', () => {
        const env = serviceEnvFor([pg('16', 54316), pg('17', 54317, { active: true })]);
        expect(env.DB_PORT).toBe('54317');
        expect(env.PGPORT).toBe('54317');
        expect(env.DATABASE_URL).toContain(':54317/');
        // COUNTED: no key anywhere points at the inactive port.
        expect(Object.values(env).filter((v) => v.includes('54316'))).toHaveLength(0);
    });

    it('with none active, the choice is deterministic — the highest version — and the same on every call', () => {
        const a = serviceEnvFor([pg('16', 54316), pg('17', 54317)]);
        const b = serviceEnvFor([pg('17', 54317), pg('16', 54316)]);
        expect(a).toEqual(b);
        expect(a.PGPORT).toBe('54317');
    });

    it('redis emits REDIS_URL/REDIS_HOST/REDIS_PORT; a `custom` engine is exempt from one-per-engine and emits what it declares plus Genie 1’s GENIE_SERVICE_CUSTOM_<NAME>_HOST/PORT', () => {
        const redis: ServiceInstance = { id: 'svc_r', engine: 'redis', version: '7', scope: { kind: 'shared' }, publishedPort: 63790, credentials: {}, active: false };
        expect(serviceEnvFor([redis])).toEqual({ REDIS_URL: 'redis://127.0.0.1:63790', REDIS_HOST: '127.0.0.1', REDIS_PORT: '63790' });
        const custom: ServiceInstance = { id: 'svc_c', engine: 'custom', version: 'x', scope: { kind: 'shared' }, publishedPort: 9999, credentials: {}, active: false, env: { MY_SERVICE_URL: 'http://127.0.0.1:9999' } };
        expect(serviceEnvFor([custom])).toEqual({ GENIE_SERVICE_CUSTOM_X_HOST: '127.0.0.1', GENIE_SERVICE_CUSTOM_X_PORT: '9999', MY_SERVICE_URL: 'http://127.0.0.1:9999' });
        // Two customs both emit — each namespaced by its own name (Genie 1's rule), neither shadows the other.
        const second: ServiceInstance = { ...custom, id: 'svc_c2', version: 'y', publishedPort: 9998, env: {} };
        expect(serviceEnvFor([custom, second])).toMatchObject({ GENIE_SERVICE_CUSTOM_X_PORT: '9999', GENIE_SERVICE_CUSTOM_Y_PORT: '9998' });
    });

    it('two different engines both emit; the env never carries a container hostname', () => {
        const env = serviceEnvFor([pg('17', 54321), { id: 'svc_r', engine: 'redis', version: '7', scope: { kind: 'shared' }, publishedPort: 63790, credentials: {}, active: false }]);
        expect(env.PGPORT).toBe('54321');
        expect(env.REDIS_PORT).toBe('63790');
        expect(Object.values(env).some((v) => /genie-|_default|postgres:\/\/postgres@/.test(v))).toBe(false);
    });
});

describe('switching the active version costs data visibility — said BEFORE the click', () => {
    it('names both versions and says the new one starts EMPTY and nothing is deleted', () => {
        expect(switchActiveWarning({ engine: 'postgres', from: '16', to: '17' })).toBe('Switching postgres from 16 to 17: each version keeps its own data volume, so 17 starts EMPTY. Nothing in 16 is deleted; switch back any time.');
    });
});

describe('the container plan — port isolation only', () => {
    it('publishes the engine’s internal port on a loopback host port, names the container and volume by engine key, and carries the credentials as env', () => {
        const plan = containerPlan({ engine: 'postgres', major: '17', scope: { kind: 'dedicated', workspaceId: 'tynn' }, publishedPort: 54321, credentials: { user: 'genie', password: 'pw', database: 'tynn' } });
        expect(plan).toEqual({
            image: 'postgres:17',
            name: 'genie-tynn-postgres-17',
            volume: 'genie-tynn-postgres-17-data',
            publish: ['127.0.0.1:54321:5432'],
            env: { POSTGRES_USER: 'genie', POSTGRES_PASSWORD: 'pw', POSTGRES_DB: 'tynn' },
        });
        const shared = containerPlan({ engine: 'redis', major: '7', scope: { kind: 'shared' }, publishedPort: 63790 });
        expect(shared.name).toBe('genie-shared-redis-7');
        // ONE publish: Redis has no surface beside its port (Mailpit's two are pinned in services-more.test.ts).
        expect(shared.publish).toEqual(['127.0.0.1:63790:6379']);
    });

    it('an unknown engine or major is refused — never an invented image tag', () => {
        expect(() => containerPlan({ engine: 'oracle', major: '19', scope: { kind: 'shared' }, publishedPort: 1 })).toThrow(/oracle/);
        expect(() => containerPlan({ engine: 'postgres', major: '9', scope: { kind: 'shared' }, publishedPort: 1 })).toThrow(/9/);
    });
});
