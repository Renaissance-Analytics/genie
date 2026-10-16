import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateServiceForm } from '../src/core/forms.js';
import { containerPlan, type AdoptedSlice, type ServiceInstance } from '../src/core/services.js';
import { ServiceDriver, type DockerRunner } from '../src/main/service-driver.js';
import { ServiceRegistry } from '../src/main/service-registry.js';

/**
 * WHICH DATABASE A WORKSPACE GETS (2026-10-15). The moic agent, verbatim: "moic's migrations need `CREATE EXTENSION
 * vector`, and the catalog's postgres engine is stock `postgres:14–17` … A custom engine gets no DB_HOST/DB_PORT, and its
 * host port changes every time it's created (4118, then 4119 after remove + re-add) … The shared Genie-1 `postgres-17`
 * (svc_v1_postgres-17, takenOverFromGenie1) still injects DB_HOST/DB_PORT=37605, PG* and DATABASE_URL into this
 * workspace, and an agent can't detach it."
 *
 * So, each pinned here against a fake Docker that RECORDS every call (what the engine does with them is the
 * genie-test-ubuntu acceptance's — a real pgvector container):
 * - postgres has a `pgvector` variant: `pgvector/pgvector:pg<major>`, its own container, the same env; on a SHARED one
 *   Genie creates `vector` as the superuser in the workspace's database (the extension is not trusted: pgvector#288).
 * - a workspace's OWN engine of a kind is the one its env comes from — never a shared one beside it; `detach` stops a
 *   shared one giving its env (slice and data kept), `use` picks one by id.
 * - a custom image may say it IS a postgres: then DB_* / PG* / DATABASE_URL come from it, with its live port.
 * - a removed engine's port comes back when it is added again under the same name.
 *
 * Every value is invented; names are RFC 2606 (`example-*`).
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
        if (cmd === 'rm') { containers.delete(args[args.length - 1]!); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'exec') return { stdout: args.includes('PING') ? 'PONG\n' : args.includes('SETUSER') ? 'OK\n' : '', exitCode: 0 };
        return { stdout: '', exitCode: 0 };
    };
    const execs = () => calls.filter((c) => c[0] === 'exec').map((c) => c.slice(2));
    const creates = () => calls.filter((c) => c[0] === 'create');
    return { run, calls, containers, execs, creates };
}

let dir: string;
let docker: ReturnType<typeof fakeDocker>;
let registry: ServiceRegistry;
let port: number;
let pw: number;
let busy: Set<number>;

const open = async () => {
    registry = await ServiceRegistry.open(dir, new ServiceDriver(docker.run), {
        allocatePort: () => ++port,
        randomPassword: () => `genpw-${String(++pw).padStart(4, '0')}`,
        sliceReadiness: { timeoutMs: 5_000, pollMs: 500 },
        sleep: async () => {},
        portFree: async (p) => !busy.has(p),
    });
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-db-choice-'));
    docker = fakeDocker();
    port = 4100;
    pw = 0;
    busy = new Set();
    await open();
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const WS = 'example-moic';
const OTHER = 'example-other';
const SHARED = { kind: 'shared' } as const;
const MINE = { kind: 'dedicated', workspaceId: WS } as const;
const PG_KEYS = ['DATABASE_URL', 'DB_CONNECTION', 'DB_DATABASE', 'DB_HOST', 'DB_PASSWORD', 'DB_PORT', 'DB_USERNAME', 'PGDATABASE', 'PGHOST', 'PGPASSWORD', 'PGPORT', 'PGUSER'];
const psqlSql = (argv: readonly string[]) => (argv[0] === 'psql' ? argv[argv.length - 1]! : '');
const extensionSql = () => docker.execs().filter((a) => /CREATE EXTENSION/.test(psqlSql(a)));
/** Which ports anywhere in the env — a value that names a port the workspace must not reach is counted, not eyeballed. */
const valuesNaming = (env: Record<string, string>, p: number) => Object.entries(env).filter(([, v]) => v === String(p) || v.includes(`:${p}`)).map(([k]) => k);

/** Genie 1's shared Postgres 17, taken over, with this workspace's slice ACTIVE (as Genie 1 left moic's). */
const slice = (identifier: string, password: string, extra: Partial<AdoptedSlice> = {}): AdoptedSlice => ({ identifier, password, ...extra });
const V1_PORT = 37605;
const v1Postgres: ServiceInstance = {
    id: 'svc_v1_postgres-17', engine: 'postgres', version: '17', scope: SHARED, publishedPort: V1_PORT, credentials: {}, active: true, adopted: 'v1',
    containerName: 'genie-svc-postgres-17', admin: { user: 'postgres', password: 'admin-pg-secret' },
    slices: { [WS]: slice('ws_example_moic', 'moic-v1-pw', { active: true }), [OTHER]: slice('ws_example_other', 'other-v1-pw', { active: true }) },
    publishedPorts: { postgres: V1_PORT },
};
const adoptV1 = () => registry.adoptFromV1({ instances: [v1Postgres], record: { at: '2026-10-15T00:00:00.000Z', sawV1: true, sawDocker: true } });

describe('postgres with pgvector: a variant of the postgres engine', () => {
    it('plans pgvector/pgvector:pg17 in its OWN container and volume, with the stock engine’s env — the stock 17 is the control', () => {
        const scope = { kind: 'dedicated', workspaceId: 'example' } as const;
        const credentials = { user: 'genie', password: 'pw', database: 'example' };
        const vector = containerPlan({ engine: 'postgres', major: '17', variant: 'pgvector', scope, publishedPort: 54321, credentials });
        const stock = containerPlan({ engine: 'postgres', major: '17', scope, publishedPort: 54322, credentials });
        expect(vector.image).toBe('pgvector/pgvector:pg17');
        expect(stock.image).toBe('postgres:17');
        // Two containers, two volumes: a stock 17 and a pgvector 17 in one workspace never collide.
        expect([vector.name, vector.volume]).toEqual(['genie-example-postgres-pgvector-17', 'genie-example-postgres-pgvector-17-data']);
        expect([stock.name, stock.volume]).toEqual(['genie-example-postgres-17', 'genie-example-postgres-17-data']);
        expect(vector.env).toEqual(stock.env);
        expect(vector.env).toEqual({ POSTGRES_USER: 'genie', POSTGRES_PASSWORD: 'pw', POSTGRES_DB: 'example' });
        // Every major the engine offers has its tag (Docker Hub lists pg14…pg18, read 2026-10-15).
        expect(['14', '15', '16'].map((m) => containerPlan({ engine: 'postgres', major: m, variant: 'pgvector', scope, publishedPort: 1, credentials }).image)).toEqual(['pgvector/pgvector:pg14', 'pgvector/pgvector:pg15', 'pgvector/pgvector:pg16']);
    });

    it('an unknown variant is refused by the form, by name — the known one passes (control)', () => {
        const form = { workspaceId: 'example', engine: 'postgres', major: '17', scope: 'dedicated' as const };
        expect(validateServiceForm({ ...form, variant: 'postgis' })).toEqual([{ field: 'variant', message: 'postgres has no variant "postgis" (pgvector).' }]);
        expect(validateServiceForm({ ...form, variant: 'pgvector' })).toEqual([]);
        expect(validateServiceForm({ ...form, engine: 'redis', major: '7', variant: 'pgvector' })).toEqual([{ field: 'variant', message: 'redis has no variants.' }]);
    });

    it('a DEDICATED pgvector: pulled and created from pgvector/pgvector:pg17, and the workspace env is EXACTLY the Postgres keys at its port', async () => {
        const r = await registry.add({ engine: 'postgres', major: '17', variant: 'pgvector', scope: MINE, consent: true, workspaceId: WS });
        expect(r.kind).toBe('added');
        const create = docker.creates();
        expect(create).toHaveLength(1);
        expect(create[0]).toContain('pgvector/pgvector:pg17');
        expect(create[0]).not.toContain('postgres:17');
        const i = registry.list(WS)[0]!;
        expect(i).toMatchObject({ engine: 'postgres', version: '17', variant: 'pgvector', active: true });
        const env = registry.envFor(WS);
        expect(Object.keys(env).sort()).toEqual(PG_KEYS);
        expect(env.DB_PORT).toBe(String(i.publishedPort));
        // Its user is the image's superuser (POSTGRES_USER): it creates `vector` itself, so Genie runs nothing in it.
        expect(extensionSql()).toEqual([]);
        // Asking again answers the same engine; a STOCK 17 is a different one (its own container).
        expect((await registry.add({ engine: 'postgres', major: '17', variant: 'pgvector', scope: MINE, consent: true, workspaceId: WS })).kind).toBe('exists');
        expect((await registry.add({ engine: 'postgres', major: '17', scope: MINE, consent: true, workspaceId: WS })).kind).toBe('added');
        expect(docker.creates().map((c) => c[2])).toEqual([`genie-${WS}-postgres-pgvector-17`, `genie-${WS}-postgres-17`]);
    });

    it('a SHARED pgvector: Genie creates `vector` ONCE per workspace, as the superuser, IN that workspace’s database — a stock shared one creates none (control)', async () => {
        await registry.add({ engine: 'postgres', major: '17', variant: 'pgvector', scope: SHARED, consent: true, workspaceId: 'example-a' });
        await registry.add({ engine: 'postgres', major: '17', variant: 'pgvector', scope: SHARED, consent: true, workspaceId: 'example-b' });
        const shared = registry.list().find((i) => i.variant === 'pgvector')!;
        const ext = extensionSql();
        expect(ext.map(psqlSql)).toEqual(['CREATE EXTENSION IF NOT EXISTS "vector"', 'CREATE EXTENSION IF NOT EXISTS "vector"']);
        // Connected as the ENGINE's superuser, to each workspace's OWN database — never `postgres`, never the workspace role.
        expect(ext.map((a) => a[1])).toEqual([
            `postgresql://genie:${shared.admin!.password}@127.0.0.1:5432/ws_example_a`,
            `postgresql://genie:${shared.admin!.password}@127.0.0.1:5432/ws_example_b`,
        ]);
        // After the grants: the workspace's database exists and is its own before the extension goes in.
        const order = docker.execs().map(psqlSql).filter((s) => s !== '');
        expect(order.findIndex((s) => s.includes('OWNER TO "ws_example_a"'))).toBeLessThan(order.findIndex((s) => s.includes('CREATE EXTENSION')));
        // Asked again: nothing re-run.
        await registry.add({ engine: 'postgres', major: '17', variant: 'pgvector', scope: SHARED, consent: true, workspaceId: 'example-a' });
        expect(extensionSql()).toHaveLength(2);
        // The workspace's env is the slice's — exactly the Postgres keys.
        expect(Object.keys(registry.envFor('example-a')).sort()).toEqual(PG_KEYS);
        expect(registry.envFor('example-a')).toMatchObject({ DB_DATABASE: 'ws_example_a', DB_USERNAME: 'ws_example_a', DB_PORT: String(shared.publishedPort) });

        // Control: a stock shared Postgres carves the same slice with NO extension.
        await registry.add({ engine: 'postgres', major: '16', scope: SHARED, consent: true, workspaceId: 'example-c' });
        expect(extensionSql()).toHaveLength(2);
        expect(docker.execs().filter((a) => psqlSql(a).startsWith('CREATE DATABASE "ws_example_c"'))).toHaveLength(1);
    });
});

describe('a workspace’s own engine is the one its env comes from', () => {
    it('Genie 1’s shared postgres-17 gives DB_* until the workspace has its own — then its OWN port, and nothing names 37605', async () => {
        await adoptV1();
        // Control: with no engine of its own, the shared one (its slice) is the workspace's — as today.
        expect(registry.envFor(WS)).toMatchObject({ DB_PORT: String(V1_PORT), DB_USERNAME: 'ws_example_moic' });
        await registry.add({ engine: 'postgres', major: '17', scope: MINE, consent: true, workspaceId: WS });
        const own = registry.list(WS)[0]!;
        const env = registry.envFor(WS);
        expect(env.DB_PORT).toBe(String(own.publishedPort));
        expect(env.PGPORT).toBe(String(own.publishedPort));
        expect(env.DB_USERNAME).toBe('genie');
        expect(valuesNaming(env, V1_PORT)).toEqual([]);
        expect(JSON.stringify(env)).not.toContain('moic-v1-pw');
        // The other workspace, which has no engine of its own, still gets its slice of the shared one.
        expect(registry.envFor(OTHER)).toMatchObject({ DB_PORT: String(V1_PORT), DB_PASSWORD: 'other-v1-pw' });
        // `choices` says the same thing the env does.
        const pg = registry.choices(WS).find((c) => c.kind === 'postgres')!;
        expect(pg.chosen?.id).toBe(own.id);
        expect(pg.candidates.map((c) => c.instance.id).sort()).toEqual([own.id, v1Postgres.id].sort());
    });

    it('`use` picks by ID — a dedicated 17 and the shared 17 are two engines; the person can go back to the shared one', async () => {
        await adoptV1();
        await registry.add({ engine: 'postgres', major: '17', scope: MINE, consent: true, workspaceId: WS });
        const own = registry.list(WS)[0]!;
        await registry.use(WS, v1Postgres.id);
        expect(registry.envFor(WS).DB_PORT).toBe(String(V1_PORT));
        expect(registry.list(WS)[0]!.active).toBe(false);
        await registry.use(WS, own.id);
        expect(registry.envFor(WS).DB_PORT).toBe(String(own.publishedPort));
        // The version form ("Make active" on postgres 17) means THIS workspace's own 17, never both.
        await registry.setActive(WS, 'postgres', '17');
        expect(registry.envFor(WS).DB_PORT).toBe(String(own.publishedPort));
        expect(registry.list().find((i) => i.id === v1Postgres.id)!.slices![WS]!.active).toBe(false);
        // OTHER's slice was never touched.
        expect(registry.list().find((i) => i.id === v1Postgres.id)!.slices![OTHER]!.active).toBe(true);
    });

    it('`detach` stops the shared engine giving its env — slice, role and data KEPT; `use` attaches it again; another workspace is untouched', async () => {
        await adoptV1();
        const choice = await registry.detach(WS, v1Postgres.id);
        expect(choice).toMatchObject({ kind: 'postgres', chosen: null });
        const env = registry.envFor(WS);
        expect(PG_KEYS.filter((k) => k in env)).toEqual([]);
        expect(valuesNaming(env, V1_PORT)).toEqual([]);
        const after = registry.list().find((i) => i.id === v1Postgres.id)!;
        expect(after.slices![WS]).toMatchObject({ identifier: 'ws_example_moic', password: 'moic-v1-pw' });
        expect(after.detached).toEqual([WS]);
        // Nothing was asked of Docker: no stop, no rm, no exec.
        expect(docker.calls).toEqual([]);
        expect(registry.envFor(OTHER).DB_PORT).toBe(String(V1_PORT));
        await registry.use(WS, v1Postgres.id);
        expect(registry.envFor(WS).DB_PORT).toBe(String(V1_PORT));
        expect(registry.list().find((i) => i.id === v1Postgres.id)!.detached).toBeUndefined();
    });

    it('a workspace’s own engine cannot be detached, and another workspace’s cannot be used — both refused, nothing written', async () => {
        await registry.add({ engine: 'postgres', major: '17', scope: MINE, consent: true, workspaceId: WS });
        const own = registry.list(WS)[0]!;
        await expect(registry.detach(WS, own.id)).rejects.toThrow(/own engine: stop or remove it/);
        await expect(registry.use(OTHER, own.id)).rejects.toThrow(/another workspace's engine/);
        expect(registry.list(WS)[0]).toEqual(own);
    });
});

describe('a custom image that says it IS a postgres', () => {
    const custom = (kind?: string) => ({
        engine: 'custom', major: 'pgvector', scope: MINE, consent: true, workspaceId: WS,
        custom: { image: 'pgvector/pgvector:pg17', internalPort: 5432, env: { POSTGRES_USER: 'moic', POSTGRES_PASSWORD: 'moic-own-pw', POSTGRES_DB: 'moic' }, ...(kind ? { kind } : {}) },
    });

    it('gives DB_* / PG* / DATABASE_URL from ITS live port and ITS env — and beats Genie 1’s shared one beside it', async () => {
        await adoptV1();
        await registry.add(custom('postgres'));
        const i = registry.list(WS)[0]!;
        const p = String(i.publishedPort);
        const env = registry.envFor(WS);
        expect(env).toMatchObject({
            DATABASE_URL: `postgresql://moic:moic-own-pw@127.0.0.1:${p}/moic`,
            DB_CONNECTION: 'pgsql', DB_HOST: '127.0.0.1', DB_PORT: p, DB_DATABASE: 'moic', DB_USERNAME: 'moic', DB_PASSWORD: 'moic-own-pw',
            PGHOST: '127.0.0.1', PGPORT: p, PGDATABASE: 'moic', PGUSER: 'moic', PGPASSWORD: 'moic-own-pw',
            // Still its own names and env, as every custom engine's.
            GENIE_SERVICE_CUSTOM_PGVECTOR_HOST: '127.0.0.1', GENIE_SERVICE_CUSTOM_PGVECTOR_PORT: p,
        });
        expect(valuesNaming(env, V1_PORT)).toEqual([]);
    });

    it('CONTROL: the same image WITHOUT a kind gives only GENIE_SERVICE_CUSTOM_* and its own env — never DB_*', async () => {
        await registry.add(custom());
        const i = registry.list(WS)[0]!;
        expect(registry.envFor(WS)).toEqual({
            GENIE_SERVICE_CUSTOM_PGVECTOR_HOST: '127.0.0.1', GENIE_SERVICE_CUSTOM_PGVECTOR_PORT: String(i.publishedPort),
            POSTGRES_USER: 'moic', POSTGRES_PASSWORD: 'moic-own-pw', POSTGRES_DB: 'moic',
        });
    });

    it('a kind that is not an engine is refused by the form and the registry, before anything is pulled', async () => {
        expect(validateServiceForm({ workspaceId: WS, engine: 'custom', major: '', scope: 'dedicated', custom: { name: 'pgvector', image: 'pgvector/pgvector:pg17', port: 5432, env: {}, kind: 'oracle' } }))
            .toEqual([{ field: 'kind', message: '"oracle" is not an engine a custom image can be (postgres, mysql, mariadb, redis, mongo).' }]);
        await expect(registry.add(custom('oracle'))).rejects.toThrow(/cannot be a "oracle"/);
        expect(docker.calls).toEqual([]);
    });
});

describe('a removed engine’s port comes back when it is added again under the same name', () => {
    const pgvectorCustom = (name = 'pgvector') => ({
        engine: 'custom', major: name, scope: MINE, consent: true, workspaceId: WS,
        custom: { image: 'pgvector/pgvector:pg17', internalPort: 5432, env: { POSTGRES_PASSWORD: 'moic-own-pw' }, kind: 'postgres' },
    });

    it('remove + re-add: the SAME port (4101, not 4102), and services.json remembers it across a reopen', async () => {
        await registry.add(pgvectorCustom());
        const first = registry.list(WS)[0]!.publishedPort;
        expect(first).toBe(4101);
        await registry.remove(registry.list(WS)[0]!.id, { deleteData: false });
        // Remembered — and reserved, so the allocator hands it to nothing else meanwhile.
        expect(registry.reservedPorts()).toContain(4101);
        await open();
        await registry.add(pgvectorCustom());
        expect(registry.list(WS)[0]!.publishedPort).toBe(4101);
        expect(port).toBe(4101);
        // Handed back: no longer remembered beside the engine that holds it (counted once).
        expect(registry.reservedPorts().filter((p) => p === 4101)).toHaveLength(1);
        expect(registry.envFor(WS).DB_PORT).toBe('4101');
    });

    it('CONTROLS: another name gets a fresh port; a remembered port something else now holds is NOT reused', async () => {
        await registry.add(pgvectorCustom());
        await registry.remove(registry.list(WS)[0]!.id, { deleteData: false });
        await registry.add(pgvectorCustom('other'));
        expect(registry.list(WS).map((i) => i.publishedPort)).toEqual([4102]);
        // Something outside Genie bound 4101 meanwhile: the probe says so, and a fresh port is allocated.
        busy.add(4101);
        await registry.add(pgvectorCustom());
        expect(registry.list(WS).find((i) => i.version === 'pgvector')!.publishedPort).toBe(4103);
        expect(registry.reservedPorts()).not.toContain(4101);
    });
});
