import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { serviceEnv } from '../env-wiring';
import type { ProvisionedService } from '../env-wiring';

/**
 * ENV WIRING (Tynn #234, P3) — turning a workspace's provisioned services into
 * the environment its app containers actually read.
 *
 * The value that matters is the HOST: inside the workspace's network the engine
 * is reachable by its CONTAINER NAME on its real port, never by the loopback
 * port published for people and tools on the desktop. Getting that backwards
 * produces a `DATABASE_URL` that works when you paste it into a terminal and
 * fails inside every container — which is the single most confusing failure
 * this whole feature could ship.
 */

const pg = (over: Partial<ProvisionedService> = {}): ProvisionedService => ({
    engine: 'postgres',
    host: 'genie-svc-postgres-16',
    port: 5432,
    slice: { identifier: 'ws_acme', dnsName: 'ws-acme', password: 'pw1' },
    ...over,
});

describe('relational engines', () => {
    it('addresses the engine by CONTAINER NAME on its container port', () => {
        const env = serviceEnv([pg()]);
        expect(env.DATABASE_URL).toBe('postgresql://ws_acme:pw1@genie-svc-postgres-16:5432/ws_acme');
        expect(env.PGHOST).toBe('genie-svc-postgres-16');
        expect(env.PGPORT).toBe('5432');
    });

    it('emits the engine-native variables its client libraries read', () => {
        const env = serviceEnv([pg()]);
        expect(env).toMatchObject({
            PGUSER: 'ws_acme',
            PGPASSWORD: 'pw1',
            PGDATABASE: 'ws_acme',
        });
    });

    it('emits the framework-shaped DB_* set for the PRIMARY relational service', () => {
        const env = serviceEnv([pg()]);
        expect(env).toMatchObject({
            DB_CONNECTION: 'pgsql',
            DB_HOST: 'genie-svc-postgres-16',
            DB_PORT: '5432',
            DB_DATABASE: 'ws_acme',
            DB_USERNAME: 'ws_acme',
            DB_PASSWORD: 'pw1',
        });
    });

    it('gives DB_* and DATABASE_URL to ONE engine when a workspace has two', () => {
        // DB_* and DATABASE_URL are single-valued by construction, so with both
        // a Postgres and a MySQL attached they have to name one. Postgres wins
        // deterministically; MySQL still gets its own MYSQL_* set, so nothing is
        // unreachable — it is just not the default connection.
        const env = serviceEnv([
            { ...pg(), engine: 'mysql', host: 'genie-svc-mysql-8.4', port: 3306 },
            pg(),
        ]);
        expect(env.DB_CONNECTION).toBe('pgsql');
        expect(env.DATABASE_URL).toContain('postgresql://');
        expect(env.MYSQL_HOST).toBe('genie-svc-mysql-8.4');
        expect(env.MYSQL_DATABASE).toBe('ws_acme');
    });

    it('is order-independent — the same set of services yields the same env', () => {
        const mysql = { ...pg(), engine: 'mysql' as const, host: 'm', port: 3306 };
        expect(serviceEnv([pg(), mysql])).toEqual(serviceEnv([mysql, pg()]));
    });
});

describe('redis', () => {
    it('emits a URL carrying the per-workspace ACL user, and the key prefix', () => {
        const env = serviceEnv([
            {
                engine: 'redis',
                host: 'genie-svc-redis-7',
                port: 6379,
                slice: { identifier: 'ws_acme', dnsName: 'ws-acme', password: 'pw1' },
            },
        ]);
        expect(env.REDIS_URL).toBe('redis://ws_acme:pw1@genie-svc-redis-7:6379');
        expect(env.REDIS_USERNAME).toBe('ws_acme');
        // The ACL restricts this user to `ws_acme:*`, so an app that ignores the
        // prefix gets a permission error rather than silent nothing.
        expect(env.REDIS_PREFIX).toBe('ws_acme:');
    });
});

describe('namespace engines', () => {
    it('hands out the SHARED master credential plus the workspace namespace', () => {
        const env = serviceEnv([
            {
                engine: 'meilisearch',
                host: 'genie-svc-meilisearch-1',
                port: 7700,
                slice: { identifier: 'ws_acme', dnsName: 'ws-acme', password: 'unused' },
                adminPassword: 'master-key',
            },
        ]);
        expect(env.MEILISEARCH_HOST).toBe('http://genie-svc-meilisearch-1:7700');
        expect(env.MEILISEARCH_KEY).toBe('master-key');
        expect(env.MEILISEARCH_INDEX_PREFIX).toBe('ws_acme_');
    });

    const MINIO = {
        engine: 'minio' as const,
        host: 'genie-svc-minio-latest',
        port: 9000,
        slice: { identifier: 'ws_acme', dnsName: 'ws-acme', password: 'slice-pw_123' },
    };

    it('gives MinIO the DNS-safe bucket name, never the SQL one', () => {
        const env = serviceEnv([MINIO]);
        // An S3 bucket may not contain an underscore.
        expect(env.AWS_BUCKET).toBe('ws-acme');
        expect(env.AWS_ENDPOINT).toBe('http://genie-svc-minio-latest:9000');
        expect(env.AWS_USE_PATH_STYLE_ENDPOINT).toBe('true');
    });

    /**
     * MinIO used to hand every workspace `AWS_ACCESS_KEY_ID=genie` and the
     * engine's ROOT password, because it was a namespace engine and had no
     * per-workspace credential to give. That made every other workspace's
     * bucket — an installed Genie App's included — one `mc rb --force` away
     * (Tynn #250, step 4). It now has an IAM user of its own.
     */
    it('gives MinIO the WORKSPACE credential, and never the root one', () => {
        const env = serviceEnv([MINIO]);
        expect(env.AWS_ACCESS_KEY_ID).toBe('ws-acme');
        expect(env.AWS_SECRET_ACCESS_KEY).toBe('slice-pw_123');
    });

    it('leaks no root credential even when one is passed alongside', () => {
        // Belt and braces: a caller that still attaches the engine admin must
        // not be able to put it back into the environment by accident.
        const env = serviceEnv([{ ...MINIO, adminUser: 'genie', adminPassword: 'root-pw' }]);
        expect(Object.values(env)).not.toContain('root-pw');
        expect(env.AWS_ACCESS_KEY_ID).toBe('ws-acme');
    });

    it('points mail at the shared catch-all', () => {
        const env = serviceEnv([
            {
                engine: 'mailpit',
                host: 'genie-svc-mailpit-1',
                port: 1025,
                slice: { identifier: 'ws_acme', dnsName: 'ws-acme', password: 'unused' },
            },
        ]);
        expect(env).toMatchObject({
            MAIL_MAILER: 'smtp',
            MAIL_HOST: 'genie-svc-mailpit-1',
            MAIL_PORT: '1025',
        });
    });
});

describe('websockets (Sockudo)', () => {
    const sockudo = (over: Partial<ProvisionedService> = {}): ProvisionedService => ({
        engine: 'websockets',
        host: 'genie-svc-websockets-1',
        port: 8080,
        slice: { identifier: 'ws_acme', dnsName: 'ws-acme', password: 'unused' },
        adminPassword: 'master-secret',
        ...over,
    });

    it('gives the backend the CONTAINER connection + a per-workspace app whose secret is derived from the master', () => {
        const env = serviceEnv([sockudo()]);
        // The app secret is HMAC(master, app_id) — the SAME formula the shared
        // genie-reverb server uses, so the two agree without any registration.
        const derived = createHmac('sha256', 'master-secret').update('ws_acme').digest('hex');
        expect(env).toMatchObject({
            BROADCAST_CONNECTION: 'reverb',
            REVERB_APP_ID: 'ws_acme',
            REVERB_APP_KEY: 'ws_acme',
            REVERB_APP_SECRET: derived,
            // BACKEND path: container name + container port over http — never the
            // published loopback (the same rule every other engine follows).
            REVERB_HOST: 'genie-svc-websockets-1',
            REVERB_PORT: '8080',
            REVERB_SCHEME: 'http',
        });
    });

    it('keeps REVERB_* as DEPRECATED ALIASES beside the canonical GENIE_WS_* names', () => {
        // Renaming the engine must not break a single hosted app. A Laravel app
        // reads REVERB_* because that is Laravel's reverb-driver contract, not
        // because Genie chose the word — so those names keep being emitted, with
        // the same values, and BROADCAST_CONNECTION keeps selecting that driver.
        // GENIE_WS_* is the vendor-neutral name a non-Laravel app can read.
        const env = serviceEnv([sockudo()]);
        expect(env.GENIE_WS_HOST).toBe('genie-svc-websockets-1');
        expect(env.GENIE_WS_PORT).toBe('8080');
        expect(env.GENIE_WS_SCHEME).toBe('http');
        expect(env.GENIE_WS_APP_ID).toBe('ws_acme');
        expect(env.GENIE_WS_APP_KEY).toBe('ws_acme');
        expect(env.GENIE_WS_APP_SECRET).toBe(env.REVERB_APP_SECRET);
        // Alias and canonical never disagree — one connection, two spellings.
        expect(env.REVERB_HOST).toBe(env.GENIE_WS_HOST);
        expect(env.REVERB_PORT).toBe(env.GENIE_WS_PORT);
        expect(env.REVERB_SCHEME).toBe(env.GENIE_WS_SCHEME);
        expect(env.BROADCAST_CONNECTION).toBe('reverb');
    });

    it('derives DIFFERENT secrets per workspace from the same master, so one cannot forge another', () => {
        const secretFor = (id: string) =>
            serviceEnv([
                sockudo({ slice: { identifier: id, dnsName: id.replace(/_/g, '-'), password: 'x' } }),
            ]).REVERB_APP_SECRET;
        expect(secretFor('ws_a')).not.toBe(secretFor('ws_b'));
    });
});

describe('the custom escape hatch', () => {
    it('exposes its endpoint under a name derived from the service, plus its own env', () => {
        const env = serviceEnv([
            {
                engine: 'custom',
                host: 'genie-svc-custom-thing-acme',
                port: 9999,
                name: 'thing',
                slice: { identifier: 'ws_acme', dnsName: 'ws-acme', password: 'pw' },
                customEnv: { THING_TOKEN: 'abc' },
            },
        ]);
        expect(env.GENIE_SERVICE_THING_HOST).toBe('genie-svc-custom-thing-acme');
        expect(env.GENIE_SERVICE_THING_PORT).toBe('9999');
        expect(env.THING_TOKEN).toBe('abc');
    });
});

describe('nothing provisioned', () => {
    it('is an empty environment, not a set of half-filled keys', () => {
        expect(serviceEnv([])).toEqual({});
    });
});

/**
 * TWO MAJORS OF ONE ENGINE (#242 P3).
 *
 * A workspace's services are keyed by (engine, VERSION), so it can hold
 * postgres 16 AND 17 at once — and they are different containers with different
 * VOLUMES, i.e. different data. But `DATABASE_URL`, `DB_*` and `PG*` name ONE
 * connection, so somebody has to lose. Left to the old ordering the answer was
 * incoherent rather than merely arbitrary: the single-valued keys were pinned to
 * the FIRST entry while the engine-native keys were overwritten by the LAST, so
 * an app reading DB_HOST and a tool reading PGHOST reached DIFFERENT DATABASES.
 *
 * The ACTIVE version owns every name for its engine; the other stays reachable
 * as a container but contributes no environment.
 */
describe('two versions of one engine', () => {
    const pg16 = pg({ host: 'genie-svc-postgres-16', version: '16' });
    const pg17 = pg({ host: 'genie-svc-postgres-17', version: '17', active: true });

    it('gives EVERY name to the active version — never a split brain', () => {
        const env = serviceEnv([pg16, pg17]);
        expect(env.PGHOST).toBe('genie-svc-postgres-17');
        expect(env.DATABASE_URL).toContain('genie-svc-postgres-17');
        expect(env.DB_HOST).toBe('genie-svc-postgres-17');
        // The losing version contributes NOTHING — no half-set of variables
        // pointing at a database the app is not using.
        expect(env.DATABASE_URL).not.toContain('postgres-16');
    });

    it('is order-independent — the active one wins whichever way they arrive', () => {
        expect(serviceEnv([pg17, pg16]).PGHOST).toBe(serviceEnv([pg16, pg17]).PGHOST);
    });

    it('falls back to a STABLE choice when neither is marked active', () => {
        // No explicit choice is still not licence to be incoherent: one version
        // owns all the names, and the same one every time.
        const env = serviceEnv([pg16, pg({ host: 'genie-svc-postgres-17', version: '17' })]);
        expect(env.DATABASE_URL).toContain(env.PGHOST!);
        expect(env.DB_HOST).toBe(env.PGHOST);
    });

    it('still lets a DIFFERENT engine keep its own native variables', () => {
        // The rule is one-per-ENGINE, not one overall: a workspace with Postgres
        // and MySQL still gets MYSQL_* alongside the primary's DATABASE_URL.
        const env = serviceEnv([
            pg17,
            { ...pg(), engine: 'mysql', host: 'genie-svc-mysql-8', port: 3306 },
        ]);
        expect(env.DATABASE_URL).toContain('postgres-17');
        expect(env.MYSQL_HOST).toBe('genie-svc-mysql-8');
    });
});
