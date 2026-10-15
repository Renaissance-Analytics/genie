import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { containerPlan, type AdoptedSlice, type ServiceInstance } from '../src/core/services.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import { ServiceDriver } from '../src/main/service-driver.js';
import { ServiceRegistry } from '../src/main/service-registry.js';

/**
 * GENIE 1's ENGINES IN GENIE 2's REGISTRY (2026-10-14). The owner: "the upgrade should have shut down
 * everything that was genie 1 so that everything running was genie 2 and what needed to be migrated,
 * was migrated." The engines are taken over in place, so:
 *
 * - an adopted instance is NEVER created, pulled, started by `add`, or re-keyed — every engine bakes
 *   its credential into its data directory, and a fresh one locks the apps out;
 * - its env is GENIE 1's: the exact names and values Genie 1's env-wiring produced in host form, which
 *   is what Genie 1 wrote into each workspace's `.env` — pinned here literally, name by name;
 * - it is addressed by its own container name and its own volume, never ones Genie 2 would derive.
 *
 * Every value is invented.
 */

function fakeDocker() {
    const calls: (readonly string[])[] = [];
    const containers = new Map<string, 'created' | 'running' | 'exited'>();
    const run: DockerRunner = async (args) => {
        calls.push(args);
        const [cmd, sub] = args;
        if (cmd === 'image' && sub === 'inspect') return { stdout: '[{}]', exitCode: 0 };
        if (cmd === 'container' && sub === 'inspect') {
            const st = containers.get(args[2]!);
            return st ? { stdout: JSON.stringify([{ State: { Status: st, StartedAt: 't' } }]), exitCode: 0 } : { stdout: '', exitCode: 1 };
        }
        if (cmd === 'create') { containers.set(args[2]!, 'created'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'start') { containers.set(args[1]!, 'running'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'stop') { containers.set(args[1]!, 'exited'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'rm') { containers.delete(args[2]!); return { stdout: '', exitCode: 0 }; }
        return { stdout: '', exitCode: 0 };
    };
    return { run, calls, containers };
}

const ALPHA = 'ws-alpha';
const BETA = 'ws-beta';

const adopted = (over: Partial<ServiceInstance> & Pick<ServiceInstance, 'id' | 'engine' | 'version' | 'publishedPort' | 'containerName'>): ServiceInstance => ({
    scope: { kind: 'shared' },
    credentials: {},
    active: false,
    adopted: 'v1',
    admin: { user: 'admin', password: 'admin-secret' },
    slices: {},
    ...over,
});
const slice = (identifier: string, password: string, extra: Partial<AdoptedSlice> = {}): AdoptedSlice => ({ identifier, password, ...extra });

const pg17 = adopted({
    id: 'svc_v1_postgres-17', engine: 'postgres', version: '17', publishedPort: 35432, containerName: 'genie-svc-postgres-17',
    image: 'ghcr.io/renaissance-analytics/genie-postgres:pg17-1', volume: 'example-pgdata', admin: { user: 'postgres', password: 'admin-pg-secret' },
    slices: { [ALPHA]: slice('ws_ws_alpha', 'alpha-pg-pw', { active: true }), [BETA]: slice('ws_ws_beta', 'beta-pg-pw') },
    publishedPorts: { postgres: 35432 },
});
const redisAlpha = adopted({
    id: `svc_v1_redis-7@${ALPHA}`, engine: 'redis', version: '7', publishedPort: 36379, containerName: 'genie-svc-redis-7-ws-alpha', scope: { kind: 'dedicated', workspaceId: ALPHA },
    slices: { [ALPHA]: slice('ws_ws_alpha', 'alpha-redis-pw', { prefix: 'ws_ws_alpha:' }) },
});
const mailpit = adopted({ id: 'svc_v1_mailpit-1.30', engine: 'mailpit', version: '1.30', publishedPort: 31025, containerName: 'genie-svc-mailpit-1.30', slices: { [ALPHA]: slice('ws_ws_alpha', 'alpha-mail-pw') }, publishedPorts: { smtp: 31025, ui: 38025 } });
const minio = adopted({ id: 'svc_v1_minio-latest', engine: 'minio', version: 'latest', publishedPort: 39000, containerName: 'genie-svc-minio-latest', slices: { [ALPHA]: slice('ws_ws_alpha', 'alpha-s3-pw', { bucket: 'ws-ws-alpha' }) } });
const RECORD = { at: '2026-10-14T00:00:00.000Z', sawV1: true, sawDocker: true } as const;

/** GENIE 1's host-form env for ALPHA (env-wiring.ts serviceEnv over provisionedForHost) — written from Genie 1's source, not from this code. */
const ALPHA_ENV_FROM_GENIE_1 = {
    PGHOST: '127.0.0.1', PGPORT: '35432', PGUSER: 'ws_ws_alpha', PGPASSWORD: 'alpha-pg-pw', PGDATABASE: 'ws_ws_alpha',
    DATABASE_URL: 'postgresql://ws_ws_alpha:alpha-pg-pw@127.0.0.1:35432/ws_ws_alpha',
    DB_CONNECTION: 'pgsql', DB_HOST: '127.0.0.1', DB_PORT: '35432', DB_DATABASE: 'ws_ws_alpha', DB_USERNAME: 'ws_ws_alpha', DB_PASSWORD: 'alpha-pg-pw',
    REDIS_URL: 'redis://ws_ws_alpha:alpha-redis-pw@127.0.0.1:36379', REDIS_HOST: '127.0.0.1', REDIS_PORT: '36379', REDIS_USERNAME: 'ws_ws_alpha', REDIS_PASSWORD: 'alpha-redis-pw', REDIS_PREFIX: 'ws_ws_alpha:',
    MAIL_MAILER: 'smtp', MAIL_HOST: '127.0.0.1', MAIL_PORT: '31025', MAIL_FROM_ADDRESS: 'genie+ws_ws_alpha@mail.gen', GENIE_MAIL_TAG: 'ws_ws_alpha',
    AWS_ENDPOINT: 'http://127.0.0.1:39000', AWS_ACCESS_KEY_ID: 'ws-ws-alpha', AWS_SECRET_ACCESS_KEY: 'alpha-s3-pw', AWS_BUCKET: 'ws-ws-alpha', AWS_DEFAULT_REGION: 'us-east-1', AWS_USE_PATH_STYLE_ENDPOINT: 'true',
};

let dir: string;
let docker: ReturnType<typeof fakeDocker>;
let registry: ServiceRegistry;
let nextPort = 54300;
const open = (randomPassword = () => 'pw1') => ServiceRegistry.open(dir, new ServiceDriver(docker.run), { allocatePort: () => ++nextPort, randomPassword });

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-services-adopted-'));
    docker = fakeDocker();
    nextPort = 54300;
    registry = await open();
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('taking over Genie 1 engines', () => {
    it('registers them with NO docker call at all — no create, no pull, no start — and records the take-over in the same file', async () => {
        const done = await registry.adoptFromV1({ instances: [pg17, redisAlpha, mailpit, minio], record: RECORD });
        expect(done).toEqual({ adopted: 4, alreadyHere: 0 });
        expect(docker.calls).toHaveLength(0);
        const reopened = await open();
        expect(reopened.list().map((i) => i.id)).toEqual([pg17.id, redisAlpha.id, mailpit.id, minio.id]);
        expect(reopened.v1Import()).toEqual(RECORD);
    });

    it('a second pass adds nothing twice (stable ids)', async () => {
        await registry.adoptFromV1({ instances: [pg17, redisAlpha], record: RECORD });
        const again = await registry.adoptFromV1({ instances: [pg17, redisAlpha, mailpit], record: RECORD });
        expect(again).toEqual({ adopted: 1, alreadyHere: 2 });
        expect(registry.list()).toHaveLength(3);
    });
});

describe("an adopted engine's env is Genie 1's", () => {
    beforeEach(async () => {
        await registry.adoptFromV1({ instances: [pg17, redisAlpha, mailpit, minio], record: RECORD });
    });

    it("ALPHA gets EXACTLY Genie 1's names and values — Postgres, its own Redis ACL user and prefix, the Mailpit tag, its own bucket", () => {
        expect(registry.envFor(ALPHA)).toEqual(ALPHA_ENV_FROM_GENIE_1);
    });

    it("BETA gets its OWN slice of the shared Postgres — and not ALPHA's dedicated Redis, Mailpit or bucket", () => {
        expect(registry.envFor(BETA)).toEqual({
            PGHOST: '127.0.0.1', PGPORT: '35432', PGUSER: 'ws_ws_beta', PGPASSWORD: 'beta-pg-pw', PGDATABASE: 'ws_ws_beta',
            DATABASE_URL: 'postgresql://ws_ws_beta:beta-pg-pw@127.0.0.1:35432/ws_ws_beta',
            DB_CONNECTION: 'pgsql', DB_HOST: '127.0.0.1', DB_PORT: '35432', DB_DATABASE: 'ws_ws_beta', DB_USERNAME: 'ws_ws_beta', DB_PASSWORD: 'beta-pg-pw',
        });
    });

    it('a workspace with no slice gets nothing from a shared adopted engine (CONTROL: ALPHA, same registry, gets plenty)', () => {
        expect(registry.envFor('ws-gamma')).toEqual({});
        expect(Object.keys(registry.envFor(ALPHA)).length).toBeGreaterThan(0);
    });

    it("with Postgres AND MySQL, DATABASE_URL/DB_* are Postgres's whatever the order (Genie 1's rule) — MySQL keeps its own MYSQL_*", async () => {
        const mysql = adopted({ id: 'svc_v1_mysql-8.4', engine: 'mysql', version: '8.4', publishedPort: 33306, containerName: 'genie-svc-mysql-8.4', slices: { [ALPHA]: slice('ws_ws_alpha', 'alpha-my-pw'), 'ws-delta': slice('ws_ws_delta', 'delta-my-pw') } });
        // AFTER Postgres in the file: a last-writer-wins env would hand DB_* to MySQL.
        await registry.adoptFromV1({ instances: [mysql], record: RECORD });
        const env = registry.envFor(ALPHA);
        expect(env.DB_CONNECTION).toBe('pgsql');
        expect(env.DATABASE_URL).toBe('postgresql://ws_ws_alpha:alpha-pg-pw@127.0.0.1:35432/ws_ws_alpha');
        expect({ MYSQL_HOST: env.MYSQL_HOST, MYSQL_PORT: env.MYSQL_PORT, MYSQL_USER: env.MYSQL_USER, MYSQL_PASSWORD: env.MYSQL_PASSWORD, MYSQL_DATABASE: env.MYSQL_DATABASE }).toEqual({ MYSQL_HOST: '127.0.0.1', MYSQL_PORT: '33306', MYSQL_USER: 'ws_ws_alpha', MYSQL_PASSWORD: 'alpha-my-pw', MYSQL_DATABASE: 'ws_ws_alpha' });
        // Positive control: a workspace with MySQL and no Postgres slice — MySQL DOES own them.
        expect(registry.envFor('ws-delta')).toMatchObject({ DB_CONNECTION: 'mysql', DATABASE_URL: 'mysql://ws_ws_delta:delta-my-pw@127.0.0.1:33306/ws_ws_delta', DB_PORT: '33306' });
    });
});

describe('an adopted engine is never created or re-keyed', () => {
    beforeEach(async () => {
        await registry.adoptFromV1({ instances: [pg17, minio], record: RECORD });
    });

    it('adding the same engine/version/scope answers the ADOPTED instance — no pull, no create, no start; its credentials untouched', async () => {
        const r = await registry.add({ engine: 'postgres', major: '17', scope: { kind: 'shared' }, consent: true });
        expect(r).toMatchObject({ kind: 'exists', instance: { id: pg17.id } });
        expect(docker.calls.filter((c) => ['create', 'pull', 'start'].includes(c[0]!) || (c[0] === 'image' && c[1] === 'inspect'))).toHaveLength(0);
        expect(registry.list().find((i) => i.id === pg17.id)).toEqual(pg17);
    });

    it('a reopened registry with a DIFFERENT password generator still has every Genie 1 credential, and the same env', async () => {
        const before = registry.envFor(ALPHA);
        const reopened = await open(() => 'ROTATED');
        expect(reopened.list().find((i) => i.id === pg17.id)).toEqual(pg17);
        expect(reopened.envFor(ALPHA)).toEqual(before);
        expect(JSON.stringify(reopened.list())).not.toContain('ROTATED');
    });

    it('MinIO is adopt-only: asking for the one Genie 1 left answers it; a NEW one is refused, and no container is planned for it', async () => {
        expect(await registry.add({ engine: 'minio', major: 'latest', scope: { kind: 'shared' }, consent: true })).toMatchObject({ kind: 'exists', instance: { id: minio.id } });
        await registry.remove(minio.id, { deleteData: false });
        await expect(registry.add({ engine: 'minio', major: 'latest', scope: { kind: 'shared' }, consent: true })).rejects.toThrow(/taken over from Genie 1/);
        expect(() => containerPlan({ engine: 'minio', major: 'latest', scope: { kind: 'shared' }, publishedPort: 1 })).toThrow(/taken over from Genie 1/);
        expect(docker.calls.some((c) => c[0] === 'create')).toBe(false);
    });

    it('Mailpit can be added new, from its real tag (`v1.30` — there is no bare `1.30`)', () => {
        expect(containerPlan({ engine: 'mailpit', major: '1.30', scope: { kind: 'shared' }, publishedPort: 31025 }).image).toBe('axllent/mailpit:v1.30');
    });
});

describe('an adopted engine is addressed by ITS container and ITS volume', () => {
    beforeEach(async () => {
        await registry.adoptFromV1({ instances: [pg17], record: RECORD });
        docker.containers.set('genie-svc-postgres-17', 'running');
    });

    it("status, stop and start go to Genie 1's container name — not one Genie 2 would derive", async () => {
        expect(await registry.status(pg17.id)).toEqual({ state: 'running', since: 't' });
        await registry.stop(pg17.id);
        await registry.start(pg17.id);
        expect(docker.calls.filter((c) => c[0] === 'stop' || c[0] === 'start')).toEqual([['stop', 'genie-svc-postgres-17'], ['start', 'genie-svc-postgres-17']]);
        expect(docker.calls.flat()).not.toContain('genie-shared-postgres-17');
    });

    it('delete-data removes the volume the container actually mounts', async () => {
        await registry.remove(pg17.id, { deleteData: true });
        expect(docker.calls.filter((c) => c[0] === 'volume')).toEqual([['volume', 'rm', 'example-pgdata']]);
    });

    it("switching the active version is the WORKSPACE's slice: ALPHA moves to 16, BETA stays where it was", async () => {
        const pg16 = adopted({ id: 'svc_v1_postgres-16', engine: 'postgres', version: '16', publishedPort: 35416, containerName: 'genie-svc-postgres-16', slices: { [ALPHA]: slice('ws_ws_alpha', 'alpha-pg16-pw'), [BETA]: slice('ws_ws_beta', 'beta-pg16-pw') } });
        await registry.adoptFromV1({ instances: [pg16], record: RECORD });
        // BETA has no active slice: the highest version, deterministically.
        expect(registry.envFor(BETA).PGPORT).toBe('35432');
        expect(registry.envFor(ALPHA).PGPORT).toBe('35432');
        await registry.setActive(ALPHA, 'postgres', '16');
        expect(registry.envFor(ALPHA)).toMatchObject({ PGPORT: '35416', PGPASSWORD: 'alpha-pg16-pw' });
        expect(registry.envFor(BETA).PGPORT).toBe('35432');
    });
});
