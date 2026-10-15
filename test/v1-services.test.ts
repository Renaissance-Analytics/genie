import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { planV1ServicesAdoption, workspaceDnsName, workspaceSqlIdentifier, type InspectedContainer, type V1ServiceRows } from '../src/core/v1-services.js';

/**
 * GENIE 1's SERVICE ENGINES ARE TAKEN OVER IN PLACE (2026-10-14). The owner: "the upgrade should
 * have shut down everything that was genie 1 so that everything running was genie 2 and what needed
 * to be migrated, was migrated." Genie 1's engines (one shared Postgres holding a database + role per
 * workspace, a Redis per workspace with an ACL user, Mailpit, MinIO) hold the data every workspace's
 * `.env` already names; its sandboxes and site containers ran apps Genie 2 now runs on the host.
 *
 * The plan is pure: Genie 1's rows (`dev_service_engines`, `workspaces.dev_services`,
 * `dev_service_ports`) + what Docker reports (`docker container inspect`'s shape) → what to adopt,
 * start, stop, and skip — with why. Every value here is invented (RFC 2606 names, made-up
 * passwords); nothing is copied from a real machine.
 *
 * The contract:
 * - Adopted = the SAME container, volume, port and credentials. Docker is authoritative for ports and
 *   volumes; Genie 1's remembered port is only the fallback for a stopped container.
 * - Per-workspace slices carry Genie 1's DERIVED names: `ws_<slug>` (database/role/ACL user/mail tag),
 *   `ws-<slug>` (bucket), `<identifier>:` (Redis prefix).
 * - A row with no container, a container with no row, an engine Genie 2 has no driver for, a
 *   switched-off entry, an entry Genie 1 never started — each SKIPPED with why, never silently.
 * - Stopped: Genie 1's site and workspace containers — never an engine, never an unlabelled container.
 */

const ALPHA = 'ws-alpha';
const BETA = 'ws-beta';
/** A workspace id Genie 1's slug cannot keep as it is: it gets a digest of the original id appended. */
const ODD = 'Example Corp';

const svc = (engine: string, version: string, password: string, extra: Record<string, unknown> = {}) => ({ engine, version, dedicated: false, enabled: true, password, ...extra });

const rows = (over: Partial<V1ServiceRows> = {}): V1ServiceRows => ({
    engines: [
        { key: 'postgres-17', engine: 'postgres', version: '17', workspaceId: null, adminUser: 'postgres', adminPassword: 'admin-pg-secret' },
        { key: 'postgres-16', engine: 'postgres', version: '16', workspaceId: null, adminUser: 'postgres', adminPassword: 'admin-pg16-secret' },
        { key: `redis-7@${ALPHA}`, engine: 'redis', version: '7', workspaceId: ALPHA, adminUser: 'default', adminPassword: 'admin-redis-secret' },
        { key: 'mailpit-1.30', engine: 'mailpit', version: '1.30', workspaceId: null, adminUser: '', adminPassword: 'admin-mail-secret' },
        { key: 'minio-latest', engine: 'minio', version: 'latest', workspaceId: null, adminUser: 'genie', adminPassword: 'admin-s3-secret' },
        { key: 'meilisearch-1', engine: 'meilisearch', version: '1', workspaceId: null, adminUser: '', adminPassword: 'admin-meili-secret' },
    ],
    workspaces: [
        {
            id: ALPHA,
            devServices: JSON.stringify({
                a1: svc('postgres', '17', 'alpha-pg-pw', { active: true }),
                // Stored `dedicated: false`, as old Genie 1 rows are: Redis is ALWAYS dedicated there (catalog.ts alwaysDedicated).
                a2: svc('redis', '7', 'alpha-redis-pw'),
                a3: svc('mailpit', '1.30', 'alpha-mail-pw'),
                a4: svc('minio', 'latest', 'alpha-s3-pw'),
                a5: svc('meilisearch', '1', 'alpha-meili-pw'),
            }),
        },
        {
            id: BETA,
            devServices: JSON.stringify({
                b1: svc('postgres', '17', 'beta-pg-pw'),
                b2: svc('redis', '7', 'beta-redis-pw'),
                b3: svc('mailpit', '1.30', 'beta-mail-pw', { enabled: false }),
            }),
        },
        { id: ODD, devServices: JSON.stringify({ o1: svc('postgres', '17', 'odd-pg-pw') }) },
        { id: 'ws-none', devServices: null },
    ],
    ports: [
        // Observed Docker state wins over this: the container reports 35432.
        { recordKey: 'postgres-17', portName: 'postgres', hostPort: 30001 },
    ],
    ...over,
});

const bind = (port: number) => [{ HostIp: '127.0.0.1', HostPort: String(port) }];
const volume = (name: string, target: string) => ({ Type: 'volume', Name: name, Destination: target });
const containers = (): InspectedContainer[] => [
    {
        Name: '/genie-svc-postgres-17',
        Config: { Image: 'ghcr.io/renaissance-analytics/genie-postgres:pg17-1', Labels: { 'genie.service': 'postgres-17', 'genie.role': 'service' } },
        State: { Status: 'running' },
        NetworkSettings: { Ports: { '5432/tcp': bind(35432) } },
        HostConfig: { PortBindings: { '5432/tcp': bind(35432) } },
        Mounts: [volume('genie-svc-postgres-17-data', '/var/lib/postgresql/data')],
    },
    {
        // Stopped: Docker reports no live ports, only the configured binding.
        Name: '/genie-svc-redis-7-ws-alpha',
        Config: { Image: 'redis:7-alpine', Labels: { 'genie.service': 'redis-7', 'genie.workspace': ALPHA, 'genie.role': 'service' } },
        State: { Status: 'exited' },
        NetworkSettings: { Ports: {} },
        HostConfig: { PortBindings: { '6379/tcp': bind(36379) } },
        Mounts: [volume('genie-svc-redis-7-ws-alpha-data', '/data')],
    },
    {
        Name: '/genie-svc-mailpit-1.30',
        Config: { Image: 'axllent/mailpit:v1.30', Labels: { 'genie.service': 'mailpit-1.30', 'genie.role': 'service' } },
        State: { Status: 'running' },
        NetworkSettings: { Ports: { '1025/tcp': bind(31025), '8025/tcp': bind(38025) } },
        Mounts: [volume('genie-svc-mailpit-1.30-data', '/data')],
    },
    {
        Name: '/genie-svc-minio-latest',
        Config: { Image: 'quay.io/minio/minio:latest', Labels: { 'genie.service': 'minio-latest', 'genie.role': 'service' } },
        State: { Status: 'running' },
        NetworkSettings: { Ports: { '9000/tcp': bind(39000), '9001/tcp': bind(39001) } },
        Mounts: [volume('genie-svc-minio-latest-data', '/data')],
    },
    {
        Name: '/genie-svc-meilisearch-1',
        Config: { Image: 'getmeili/meilisearch:v1', Labels: { 'genie.service': 'meilisearch-1', 'genie.role': 'service' } },
        State: { Status: 'running' },
        NetworkSettings: { Ports: { '7700/tcp': bind(37700) } },
    },
    {
        // An engine container Genie 1's database has no row for: no credential to carry.
        Name: '/genie-svc-mysql-8.4',
        Config: { Image: 'mysql:8.4', Labels: { 'genie.service': 'mysql-8.4', 'genie.role': 'service' } },
        State: { Status: 'running' },
        NetworkSettings: { Ports: { '3306/tcp': bind(33306) } },
    },
    {
        Name: '/genie-ws-ws-alpha-site-web',
        Config: { Image: 'example.test/app-dev:1', Labels: { 'genie.workspace': ALPHA, 'genie.role': 'site', 'genie.site': 'site-web' } },
        State: { Status: 'running' },
    },
    {
        Name: '/genie-ws-ws-beta-dev',
        Config: { Image: 'example.test/dev-base:1', Labels: { 'genie.workspace': BETA, 'genie.role': 'workspace-dev' } },
        State: { Status: 'exited' },
    },
    {
        // Nothing of Genie's: a CONTROL — never stopped, never adopted, never reported.
        Name: '/example-unrelated',
        Config: { Image: 'example.test/other:1', Labels: { 'com.example.app': 'x' } },
        State: { Status: 'running' },
    },
];

/** Genie 1's slug for an id it must alter, from its own formula (argv.ts workspaceSlugFor): stem + 8 hex of sha1(original). */
const oddIdentifier = `ws_example_corp_${createHash('sha1').update(ODD).digest('hex').slice(0, 8)}`;

describe("Genie 1's service engines: the take-over plan", () => {
    const plan = planV1ServicesAdoption(rows(), containers())!;
    const byId = new Map(plan.adopt.map((i) => [i.id, i]));

    it('adopts exactly the four engines Genie 2 can run and Genie 1 recorded AND Docker has — COUNTED', () => {
        expect(plan.adopt).toHaveLength(4);
        expect([...byId.keys()].sort()).toEqual(['svc_v1_mailpit-1.30', 'svc_v1_minio-latest', 'svc_v1_postgres-17', `svc_v1_redis-7@${ALPHA}`]);
        expect(plan.adopt.every((i) => i.adopted === 'v1')).toBe(true);
    });

    it('the shared Postgres: SAME container, image, volume and port, Genie 1\'s superuser kept, and one slice per workspace with Genie 1\'s derived names', () => {
        expect(byId.get('svc_v1_postgres-17')).toEqual({
            id: 'svc_v1_postgres-17',
            engine: 'postgres',
            version: '17',
            scope: { kind: 'shared' },
            // Docker's 35432, not the 30001 Genie 1 once remembered.
            publishedPort: 35432,
            credentials: {},
            active: true,
            adopted: 'v1',
            containerName: 'genie-svc-postgres-17',
            image: 'ghcr.io/renaissance-analytics/genie-postgres:pg17-1',
            volume: 'genie-svc-postgres-17-data',
            admin: { user: 'postgres', password: 'admin-pg-secret' },
            slices: {
                [ALPHA]: { identifier: 'ws_ws_alpha', password: 'alpha-pg-pw', active: true },
                [BETA]: { identifier: 'ws_ws_beta', password: 'beta-pg-pw' },
                [ODD]: { identifier: oddIdentifier, password: 'odd-pg-pw' },
            },
            publishedPorts: { postgres: 35432 },
        });
    });

    it('a per-workspace Redis: dedicated to its workspace, its ACL user and key prefix in the slice, the port from the STOPPED container\'s binding', () => {
        expect(byId.get(`svc_v1_redis-7@${ALPHA}`)).toMatchObject({
            scope: { kind: 'dedicated', workspaceId: ALPHA },
            containerName: 'genie-svc-redis-7-ws-alpha',
            publishedPort: 36379,
            volume: 'genie-svc-redis-7-ws-alpha-data',
            admin: { user: 'default', password: 'admin-redis-secret' },
            slices: { [ALPHA]: { identifier: 'ws_ws_alpha', password: 'alpha-redis-pw', prefix: 'ws_ws_alpha:' } },
        });
        // Only ALPHA's: BETA's Redis entry had no engine of its own in Genie 1.
        expect(Object.keys(byId.get(`svc_v1_redis-7@${ALPHA}`)!.slices!)).toEqual([ALPHA]);
    });

    it('Mailpit keeps BOTH published surfaces (SMTP is the port, the web inbox is recorded); MinIO its S3 port and console, the bucket in the slice', () => {
        expect(byId.get('svc_v1_mailpit-1.30')).toMatchObject({ publishedPort: 31025, publishedPorts: { smtp: 31025, ui: 38025 }, slices: { [ALPHA]: { identifier: 'ws_ws_alpha', password: 'alpha-mail-pw' } } });
        // BETA switched Mailpit off in Genie 1: no slice.
        expect(Object.keys(byId.get('svc_v1_mailpit-1.30')!.slices!)).toEqual([ALPHA]);
        expect(byId.get('svc_v1_minio-latest')).toMatchObject({ scope: { kind: 'shared' }, publishedPort: 39000, publishedPorts: { s3: 39000, console: 39001 }, slices: { [ALPHA]: { identifier: 'ws_ws_alpha', password: 'alpha-s3-pw', bucket: 'ws-ws-alpha' } } });
    });

    it('starts only the adopted container that is not running', () => {
        expect(plan.start).toEqual(['genie-svc-redis-7-ws-alpha']);
    });

    it("stops Genie 1's site and sandbox containers — and CONTROL: no engine, nothing unlabelled", () => {
        expect(plan.stop.map((s) => s.name)).toEqual(['genie-ws-ws-alpha-site-web', 'genie-ws-ws-beta-dev']);
        expect(plan.stop[0]!.why).toMatch(/site container/);
        // A dedicated engine carries genie.workspace too: it is adopted, never stopped.
        expect(plan.stop.map((s) => s.name)).not.toContain('genie-svc-redis-7-ws-alpha');
        expect(JSON.stringify(plan)).not.toContain('example-unrelated');
    });

    it('skips five things, each with why — COUNTED, and nothing silently', () => {
        const why = new Map(plan.skipped.map((s) => [s.what, s.why]));
        expect(plan.skipped).toHaveLength(5);
        expect(why.get('engine postgres-16')).toMatch(/no container exists/);
        expect(why.get('engine meilisearch-1')).toMatch(/Genie 2 has no meilisearch engine; its container genie-svc-meilisearch-1 is left running/);
        expect(why.get('container genie-svc-mysql-8.4')).toMatch(/no record/);
        expect(why.get(`workspace ${BETA}: redis-7`)).toMatch(/never started an engine/);
        expect(why.get(`workspace ${BETA}: mailpit-1.30`)).toMatch(/switched off/);
    });

    it("derives Genie 1's names exactly: a clean id is kept, an id it must alter gets 8 hex of sha1 of the ORIGINAL", () => {
        expect(workspaceSqlIdentifier('ws-alpha')).toBe('ws_ws_alpha');
        expect(workspaceDnsName('ws-alpha')).toBe('ws-ws-alpha');
        expect(workspaceSqlIdentifier(ODD)).toBe(oddIdentifier);
        // CONTROL: two ids that sanitise alike stay apart.
        expect(workspaceSqlIdentifier('example/corp')).not.toBe(workspaceSqlIdentifier(ODD));
    });
});

describe('the take-over plan — the edges', () => {
    it('cannot see Genie 1, or Docker did not answer: no plan, nothing claimed', () => {
        expect(planV1ServicesAdoption(null, containers())).toBeNull();
        expect(planV1ServicesAdoption(rows(), null)).toBeNull();
    });

    it("a stopped container with no binding falls back to Genie 1's remembered port; with neither it is skipped, not adopted on a guess", () => {
        const stopped = containers().map((c) => (c.Name === '/genie-svc-postgres-17' ? { ...c, State: { Status: 'exited' }, NetworkSettings: { Ports: {} }, HostConfig: { PortBindings: {} } } : c));
        const remembered = planV1ServicesAdoption(rows(), stopped)!;
        expect(remembered.adopt.find((i) => i.id === 'svc_v1_postgres-17')).toMatchObject({ publishedPort: 30001 });
        expect(remembered.start).toContain('genie-svc-postgres-17');

        const forgotten = planV1ServicesAdoption(rows({ ports: [] }), stopped)!;
        expect(forgotten.adopt.map((i) => i.id)).not.toContain('svc_v1_postgres-17');
        expect(forgotten.skipped.find((s) => s.what === 'engine postgres-17')?.why).toMatch(/publishes no host port/);
        // Positive control: the same fixture with the port present DOES adopt it.
        expect(remembered.adopt.map((i) => i.id)).toContain('svc_v1_postgres-17');
    });

    it("a dedicated engine whose workspace did not come over to Genie 2 is left as it is, and said", () => {
        const plan = planV1ServicesAdoption(rows(), containers(), { workspaces: [BETA, ODD] })!;
        expect(plan.adopt.map((i) => i.id)).not.toContain(`svc_v1_redis-7@${ALPHA}`);
        expect(plan.skipped.find((s) => s.what === `engine redis-7@${ALPHA}`)?.why).toMatch(/not in Genie 2/);
        // The shared engines still come over, and the container is neither started nor stopped.
        expect(plan.adopt.map((i) => i.id)).toContain('svc_v1_postgres-17');
        expect([...plan.start, ...plan.stop.map((s) => s.name)]).not.toContain('genie-svc-redis-7-ws-alpha');
    });

    it('an adopted engine no workspace holds a slice of is taken over, and the plan says it gives nobody env', () => {
        const plan = planV1ServicesAdoption(rows({ workspaces: [] }), containers())!;
        expect(plan.adopt.find((i) => i.id === 'svc_v1_postgres-17')!.slices).toEqual({});
        expect(plan.skipped.find((s) => s.what === 'engine postgres-17 (adopted)')?.why).toMatch(/no workspace holds a slice/);
    });

    // Projected against the owner's real Genie 1 data (2026-10-14): two stopped engines nobody held a slice of were
    // planned to be STARTED — woken for no app.
    it('an adopted engine no workspace uses is never started; CONTROL: the same stopped engines, used, are', () => {
        const allStopped = containers().map((c) => ({ ...c, State: { ...(c.State ?? {}), Status: 'exited' } }));
        const unused = planV1ServicesAdoption(rows({ workspaces: [] }), allStopped)!;
        // COUNTED: nothing of Genie 1's engines is started when no workspace uses any of them.
        expect(unused.start.filter((n) => n.startsWith('genie-svc-'))).toEqual([]);
        expect(unused.skipped.find((s) => s.what === 'engine postgres-17 (adopted)')?.why).toMatch(/left stopped/);
        const used = planV1ServicesAdoption(rows(), allStopped)!;
        expect(used.start).toContain('genie-svc-postgres-17');
    });
});
