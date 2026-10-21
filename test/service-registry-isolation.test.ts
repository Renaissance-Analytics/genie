import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServiceDriver, type DockerRunner } from '../src/main/service-driver.js';
import { ServiceRegistry } from '../src/main/service-registry.js';
import { runtimeDir } from '../src/main/paths.js';

/**
 * PER-WORKSPACE ISOLATION ON A SHARED ENGINE (hosting ship line H3) — Genie 1's behaviour. A shared Postgres used to
 * be created with ONE `genie` user and ONE `app` database, handed to every workspace: any workspace could read any
 * other's tables. Now a shared Postgres/MySQL/MariaDB/Redis keeps only its own superuser, and each workspace that USES
 * it gets its own database + role (Redis: ACL user + key prefix) with its own password, made through the engine's own
 * client in its container. The fake Docker RECORDS every `docker exec` argv, so what was asked of the engine is
 * counted; what the engine does with it is proven against real Docker in genie-test-ubuntu.
 */

function fakeDocker(input: { notReadyProbes?: number; failExec?: RegExp } = {}) {
    const calls: (readonly string[])[] = [];
    const containers = new Map<string, 'created' | 'running' | 'exited'>();
    let probesLeft = input.notReadyProbes ?? 0;
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
        if (cmd === 'exec') {
            const argv = args.slice(2);
            const probe = argv[0] === 'pg_isready' || argv[0] === 'mysqladmin' || argv[0] === 'mariadb-admin' || (argv[0] === 'redis-cli' && argv.includes('-a') && argv.at(-1) === 'PING');
            if (probe && probesLeft > 0) { probesLeft--; return { stdout: 'no response', exitCode: argv[0] === 'redis-cli' ? 0 : 2 }; }
            if (input.failExec?.test(argv.join(' '))) return { stdout: 'ERROR:  permission denied', exitCode: 1 };
            return { stdout: argv.includes('PING') ? 'PONG\n' : argv.includes('SETUSER') ? 'OK\n' : '', exitCode: 0 };
        }
        return { stdout: '', exitCode: 0 };
    };
    const execs = () => calls.filter((c) => c[0] === 'exec').map((c) => c.slice(2));
    return { run, calls, containers, execs };
}

let dir: string;
let docker: ReturnType<typeof fakeDocker>;
let registry: ServiceRegistry;
let port: number;
let pw: number;
let slept: number;

const open = async (d: ReturnType<typeof fakeDocker>) => {
    docker = d;
    registry = await ServiceRegistry.open(dir, new ServiceDriver(d.run), {
        allocatePort: () => ++port,
        // Distinct, generated-alphabet passwords, so "whose password is this" is answerable.
        randomPassword: () => `genpw-${String(++pw).padStart(4, '0')}`,
        sliceReadiness: { timeoutMs: 5_000, pollMs: 500 },
        now: () => slept * 500,
        sleep: async () => { slept++; },
    });
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-isolation-'));
    port = 4100;
    pw = 0;
    slept = 0;
    await open(fakeDocker());
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const SHARED = { kind: 'shared' } as const;
const A = 'example-a';
const B = 'example-b';
const psqlSql = (argv: readonly string[]) => (argv[0] === 'psql' ? argv[argv.length - 1]! : '');

describe('a shared Postgres: one superuser, and a database + role per workspace that uses it', () => {
    it('the container is created with the superuser only — no shared `app` database, no workspace credential', async () => {
        await registry.add({ engine: 'postgres', major: '17', scope: SHARED, consent: true, workspaceId: A });
        const create = docker.calls.find((c) => c[0] === 'create')!;
        expect(create.filter((a) => a.startsWith('POSTGRES_'))).toEqual(['POSTGRES_USER=genie', 'POSTGRES_PASSWORD=genpw-0001', 'POSTGRES_DB=postgres']);
        const i = registry.list().find((x) => x.engine === 'postgres')!;
        expect(i.admin).toEqual({ user: 'genie', password: 'genpw-0001' });
        expect(i.credentials).toEqual({});
    });

    it('two workspaces get DISTINCT identifiers and passwords — counted; neither is the superuser’s', async () => {
        await registry.add({ engine: 'postgres', major: '17', scope: SHARED, consent: true, workspaceId: A });
        await registry.add({ engine: 'postgres', major: '17', scope: SHARED, consent: true, workspaceId: B });
        const i = registry.list().find((x) => x.engine === 'postgres')!;
        expect(registry.list()).toHaveLength(1);
        const slices = Object.entries(i.slices ?? {});
        expect(slices.map(([ws, s]) => [ws, s.identifier])).toEqual([[A, 'ws_example_a'], [B, 'ws_example_b']]);
        const passwords = slices.map(([, s]) => s.password);
        expect(new Set(passwords).size).toBe(2);
        expect(passwords).not.toContain(i.admin!.password);
        // The engine was asked to create exactly those two roles and databases.
        const created = docker.execs().map(psqlSql).filter((sql) => sql.startsWith('CREATE DATABASE'));
        expect(created).toEqual(['CREATE DATABASE "ws_example_a" OWNER "ws_example_a"', 'CREATE DATABASE "ws_example_b" OWNER "ws_example_b"']);
    });

    it('provisioning is issued ONCE per workspace: asking again (add, or make active) runs no command and makes no container', async () => {
        await registry.add({ engine: 'postgres', major: '17', scope: SHARED, consent: true, workspaceId: A });
        const first = docker.execs().length;
        expect(docker.execs().filter((a) => a[0] === 'psql')).toHaveLength(3);
        const again = await registry.add({ engine: 'postgres', major: '17', scope: SHARED, consent: true, workspaceId: A });
        await registry.setActive(A, 'postgres', '17');
        expect(again.kind).toBe('exists');
        expect(docker.execs()).toHaveLength(first);
        expect(docker.calls.filter((c) => c[0] === 'create')).toHaveLength(1);
        expect(Object.keys(registry.list()[0]!.slices ?? {})).toEqual([A]);
    });

    it('env for A NEVER carries B’s database, role or password — and B’s own env does (the control)', async () => {
        await registry.add({ engine: 'postgres', major: '17', scope: SHARED, consent: true, workspaceId: A });
        await registry.add({ engine: 'postgres', major: '17', scope: SHARED, consent: true, workspaceId: B });
        const slices = registry.list()[0]!.slices!;
        const envA = registry.envFor(A);
        const envB = registry.envFor(B);
        const textA = JSON.stringify(envA);
        const textB = JSON.stringify(envB);
        expect(envA).toMatchObject({ DB_DATABASE: 'ws_example_a', DB_USERNAME: 'ws_example_a', DB_PASSWORD: slices[A]!.password, DB_PORT: '4101' });
        expect(textA).not.toContain(slices[B]!.password);
        expect(textA).not.toContain('ws_example_b');
        expect(textB).toContain(slices[B]!.password);
        expect(textB).toContain('ws_example_b');
        // The superuser reaches no workspace.
        expect(textA + textB).not.toContain(registry.list()[0]!.admin!.password);
        // A workspace that never used it gets nothing from it.
        expect(registry.envFor('example-c')).toEqual({});
    });

    it('a shared engine added with no workspace makes no slice; the first workspace to make it ACTIVE gets one', async () => {
        await registry.add({ engine: 'postgres', major: '17', scope: SHARED, consent: true });
        expect(docker.execs()).toEqual([]);
        expect(registry.envFor(A)).toEqual({});
        await registry.setActive(A, 'postgres', '17');
        expect(registry.list()[0]!.slices?.[A]).toMatchObject({ identifier: 'ws_example_a', active: true });
        expect(registry.envFor(A).DB_DATABASE).toBe('ws_example_a');
    });

    it('waits for the engine to answer its own client before creating anything (bounded), and the steps then run in order', async () => {
        await open(fakeDocker({ notReadyProbes: 3 }));
        await registry.add({ engine: 'postgres', major: '17', scope: SHARED, consent: true, workspaceId: A });
        expect(docker.execs().map((a) => a[0])).toEqual(['pg_isready', 'pg_isready', 'pg_isready', 'pg_isready', 'psql', 'psql', 'psql']);
        expect(slept).toBe(3);
    });

    it('a step the engine refuses fails the add with the engine’s words, and NO slice is recorded — asking again retries', async () => {
        await open(fakeDocker({ failExec: /REVOKE CONNECT/ }));
        await expect(registry.add({ engine: 'postgres', major: '17', scope: SHARED, consent: true, workspaceId: A })).rejects.toThrow('postgres 17: making the grants for ws_example_a failed: ERROR:  permission denied');
        expect(registry.list()[0]!.slices).toEqual({});
        expect(registry.envFor(A)).toEqual({});
    });
});

describe('a shared MySQL / MariaDB: root only in the container; a schema and user per workspace', () => {
    it('mysql is created with MYSQL_ROOT_PASSWORD alone and provisioned with `mysql`; mariadb with MARIADB_ROOT_PASSWORD and `mariadb`', async () => {
        await registry.add({ engine: 'mysql', major: '8', scope: SHARED, consent: true, workspaceId: A });
        await registry.add({ engine: 'mariadb', major: '11', scope: SHARED, consent: true, workspaceId: A });
        const creates = docker.calls.filter((c) => c[0] === 'create');
        expect(creates[0]!.filter((a) => a.startsWith('MYSQL_'))).toEqual([`MYSQL_ROOT_PASSWORD=${registry.list()[0]!.admin!.password}`]);
        expect(creates[1]!.filter((a) => a.startsWith('MARIADB_'))).toEqual([`MARIADB_ROOT_PASSWORD=${registry.list()[1]!.admin!.password}`]);
        expect(docker.execs().filter((a) => a.includes('-e')).map((a) => a[0])).toEqual(['mysql', 'mariadb']);
        expect(registry.envFor(A)).toMatchObject({ MYSQL_USER: 'ws_example_a', MYSQL_DATABASE: 'ws_example_a' });
    });
});

/*
 * A SHARED REDIS MADE BEFORE THE OWNER'S D2 (hosting fixes 3.2: Redis is always its own now). One already on a machine
 * keeps serving its workspaces as it was made — each its own ACL user and key prefix, put back whenever the engine
 * restarts — but none is added any more, and no other workspace joins one. Seeded here as services.json holds it.
 */
describe('a shared Redis made before D2: its ACL users, kept — and no new one', () => {
    const shared = {
        id: 'svc_redis_shared', engine: 'redis', version: '7', scope: SHARED, publishedPort: 4101, credentials: {}, active: true,
        admin: { user: 'default', password: 'genpw-admin' },
        slices: {
            [A]: { identifier: 'ws_example_a', password: 'genpw-slice-a', prefix: 'ws_example_a:' },
            [B]: { identifier: 'ws_example_b', password: 'genpw-slice-b', prefix: 'ws_example_b:' },
        },
    };
    const seeded = async () => {
        await mkdir(runtimeDir(dir), { recursive: true });
        await writeFile(join(runtimeDir(dir), 'services.json'), JSON.stringify({ instances: [shared] }), 'utf8');
        const d = fakeDocker();
        d.containers.set('genie-shared-redis-7', 'running');
        await open(d);
    };

    it('none is added any more, for a workspace or alone — in words', async () => {
        for (const workspaceId of [A, undefined]) {
            const r = await registry.add({ engine: 'redis', major: '7', scope: SHARED, consent: true, ...(workspaceId ? { workspaceId } : {}) }).then(() => null, (e: Error) => e.message);
            expect(r).toMatch(/redis is always dedicated to one workspace/);
        }
        expect(docker.calls.filter((c) => c[0] === 'create')).toHaveLength(0);
    });

    it('one already on the machine still gives each of its workspaces REDIS_USERNAME / PASSWORD / PREFIX of its own', async () => {
        await seeded();
        expect(registry.envFor(A)).toEqual({
            REDIS_URL: 'redis://ws_example_a:genpw-slice-a@127.0.0.1:4101',
            REDIS_HOST: '127.0.0.1',
            REDIS_PORT: '4101',
            REDIS_USERNAME: 'ws_example_a',
            REDIS_PASSWORD: 'genpw-slice-a',
            REDIS_PREFIX: 'ws_example_a:',
        });
    });

    it('its ACL users live in memory: a restart of the engine puts EVERY workspace’s back — counted, once each', async () => {
        await seeded();
        await registry.stop(shared.id);
        await registry.start(shared.id);
        const put = docker.execs().filter((a) => a.includes('SETUSER'));
        expect(put.map((a) => a[a.indexOf('SETUSER') + 1])).toEqual(['ws_example_a', 'ws_example_b']);
        expect(put[0]).toEqual(expect.arrayContaining(['ws_example_a', 'reset', '>genpw-slice-a', '~ws_example_a:*']));
        // Restoring re-keys nothing: the passwords recorded are the ones put back.
        expect(registry.envFor(A).REDIS_PASSWORD).toBe('genpw-slice-a');
    });
});

describe('a dedicated Redis (the only kind added now)', () => {
    it('a DEDICATED Redis gets a password too (requirepass), append-only, and hands it in REDIS_URL / REDIS_PASSWORD; no ACL user', async () => {
        await registry.add({ engine: 'redis', major: '7', scope: { kind: 'dedicated', workspaceId: A }, consent: true });
        const i = registry.list()[0]!;
        expect(i.credentials.password).toMatch(/^genpw-/);
        expect(docker.calls.find((c) => c[0] === 'create')!.slice(-6)).toEqual(['redis:7', 'redis-server', '--requirepass', i.credentials.password, '--appendonly', 'yes']);
        expect(registry.envFor(A)).toMatchObject({ REDIS_URL: `redis://:${i.credentials.password}@127.0.0.1:4101`, REDIS_PASSWORD: i.credentials.password });
        expect(docker.execs()).toEqual([]);
    });
});

describe('what H3 leaves alone', () => {
    it('a dedicated Postgres is unchanged: its own `genie` user and a database named for the workspace, no exec', async () => {
        await registry.add({ engine: 'postgres', major: '17', scope: { kind: 'dedicated', workspaceId: A }, consent: true });
        expect(registry.list()[0]!.credentials).toEqual({ user: 'genie', password: 'genpw-0001', database: A });
        expect(registry.list()[0]!.slices).toBeUndefined();
        expect(docker.execs()).toEqual([]);
    });
});
