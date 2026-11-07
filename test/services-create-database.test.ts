import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ServiceInstance } from '../src/core/services.js';
import { GENIE_SKILLS } from '../src/main/agent-skills.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { hostingTools } from '../src/main/mcp-tools-hosting.js';
import type { Caller, Registration } from '../src/main/mcp-tools.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * `services createDatabase {id, name}` (Tynn #403): a workspace on a SHARED Postgres gets a second database of its own.
 * Its role (`ws_<slug>`) cannot `CREATE DATABASE` on an engine other workspaces share, so Genie makes it — as the engine's
 * superuser, OWNED by the workspace's role, CONNECT revoked from PUBLIC — the same way it creates pgvector's `vector` for
 * a workspace (core/service-provision.ts). The person approves it through the approval queue the services tool uses.
 * Everything Genie would refuse is refused with a reason in words, BEFORE the person is asked and before anything runs.
 *
 * Run against the REAL composition and approval queue; Docker is a fake runner that keeps a set of database names, so
 * "exists" is the engine's answer, not the test's. Counted: what the person was asked, what psql was asked.
 */

const pty: PtyPort = {
    open: () => ({ id: 'term_1', pid: 1, shell: 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
    onData: () => () => {}, onExit: () => () => {},
};

const sqlOf = (argv: readonly string[]): string => (argv[0] === 'psql' ? argv[argv.length - 1]! : '');

function fakeDocker() {
    const calls: (readonly string[])[] = [];
    const images = new Set<string>();
    const containers = new Map<string, 'created' | 'running' | 'exited'>();
    /** The databases the (one, fake) Postgres holds. */
    const databases = new Set<string>(['postgres', 'template0', 'template1', 'ws_example', 'ws_example_other', 'already_here']);
    const run: DockerRunner = async (args) => {
        calls.push(args);
        const [cmd, sub] = args;
        if (cmd === 'image' && sub === 'inspect') return { stdout: images.has(args[2]!) ? '[{}]' : '', exitCode: images.has(args[2]!) ? 0 : 1 };
        if (cmd === 'pull') { images.add(args[1]!); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'container' && sub === 'inspect') {
            const st = containers.get(args[2]!);
            return st ? { stdout: JSON.stringify([{ State: { Status: st, StartedAt: 't' } }]), exitCode: 0 } : { stdout: '', exitCode: 1 };
        }
        if (cmd === 'create') { containers.set(args[2]!, 'created'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'start') { containers.set(args[1]!, 'running'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'rm') { containers.delete(args[args.length - 1]!); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'exec') {
            const sql = sqlOf(args.slice(2));
            const asked = /FROM pg_database WHERE datname = '([^']*)'/.exec(sql);
            if (asked) return { stdout: databases.has(asked[1]!) ? '1\n' : '', exitCode: 0 };
            const create = /^CREATE DATABASE "([^"]+)"/.exec(sql);
            if (create) {
                if (databases.has(create[1]!)) return { stdout: `ERROR:  database "${create[1]}" already exists\n`, exitCode: 1 };
                databases.add(create[1]!);
            }
            return { stdout: args.includes('PING') ? 'PONG\n' : '', exitCode: 0 };
        }
        return { stdout: '', exitCode: 0 };
    };
    const psql = () => calls.filter((c) => c[0] === 'exec').map((c) => c.slice(2)).filter((a) => a[0] === 'psql');
    return { run, calls, databases, psql };
}

const WS = 'example';
const OTHER = 'example-other';
const STRANGER = 'example-stranger';
const v1Postgres: ServiceInstance = {
    id: 'svc_v1_postgres-17', engine: 'postgres', version: '17', scope: { kind: 'shared' }, publishedPort: 37605, credentials: {}, active: true, adopted: 'v1',
    containerName: 'genie-svc-postgres-17', admin: { user: 'postgres', password: 'admin-pg-secret' },
    slices: {
        [WS]: { identifier: 'ws_example', password: 'example-v1-pw', active: true },
        [OTHER]: { identifier: 'ws_example_other', password: 'other-v1-pw', active: true },
    },
    publishedPorts: { postgres: 37605 },
};
const v1Mysql: ServiceInstance = {
    id: 'svc_v1_mysql-8', engine: 'mysql', version: '8', scope: { kind: 'shared' }, publishedPort: 33306, credentials: {}, active: true, adopted: 'v1',
    containerName: 'genie-svc-mysql-8', admin: { user: 'root', password: 'admin-my-secret' },
    slices: { [WS]: { identifier: 'ws_example', password: 'example-my-pw', active: true } },
    publishedPorts: { mysql: 33306 },
};

let dir: string;
let docker: ReturnType<typeof fakeDocker>;
let services: ComposedServices;
let tools: Registration[];
const callers: Record<string, Caller> = {};

async function call(terminalId: string, args: JsonObject) {
    const reg = tools.find((t) => t.definition.name === 'services')!;
    const r = await reg.handler({ ...args, terminalId }, { server: 'genie', tool: 'services', headers: {} });
    return { ...r, json: JSON.parse(r.text) as Record<string, any> };
}

async function asked(): Promise<{ id: string; title: string }> {
    for (let i = 0; i < 200 && services.approvals.deckItems().length === 0; i++) await new Promise((r) => setTimeout(r, 0));
    const [item] = services.approvals.deckItems();
    expect(item).toBeDefined();
    return { id: item!.id, title: item!.title };
}

const creates = () => docker.psql().map(sqlOf).filter((s) => s.startsWith('CREATE DATABASE'));

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-create-database-'));
    docker = fakeDocker();
    for (const ws of [WS, OTHER, STRANGER]) {
        await mkdir(join(dir, ws), { recursive: true });
        await writeFile(join(dir, ws, 'project.json'), `${JSON.stringify({ name: ws, repos: [] }, null, 2)}\n`, 'utf8');
    }
    services = await composeServices({
        userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker: docker.run, portFree: async () => true,
        workspaces: () => [WS, OTHER, STRANGER].map((id) => ({ id, path: join(dir, id) })),
    });
    await services.engines.adoptFromV1({ instances: [v1Postgres, v1Mysql], record: { at: '2026-10-15T00:00:00.000Z', sawV1: true, sawDocker: true } });
    callers['t-example'] = { agentId: mintAgentId(), agentName: 'atlas', workspaceId: WS, workspacePath: join(dir, WS) };
    callers['t-other'] = { agentId: mintAgentId(), agentName: 'vega', workspaceId: OTHER, workspacePath: join(dir, OTHER) };
    callers['t-stranger'] = { agentId: mintAgentId(), agentName: 'lyra', workspaceId: STRANGER, workspacePath: join(dir, STRANGER) };
    tools = hostingTools({ resolveCaller: (id) => callers[id] ?? null, approve: (c, a, d) => services.approvals.gate(c, a, d), services });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('services createDatabase on a shared Postgres', () => {
    it('asks the person, then creates the database OWNED by the workspace’s role, as the superuser, with CONNECT revoked from PUBLIC', async () => {
        const pending = call('t-example', { action: 'createDatabase', id: v1Postgres.id, name: 'example_testing' });
        const item = await asked();
        // The person reads the database, its owner and the engine.
        expect(item.title).toContain('example_testing');
        expect(item.title).toContain('ws_example');
        expect(item.title).toContain('postgres 17');
        // Nothing was created while the person was being asked.
        expect(creates()).toEqual([]);
        services.approvals.resolve(item.id, 'allow');
        const r = await pending;
        expect(r.isError).toBe(false);
        expect(r.json).toMatchObject({ ok: true, database: 'example_testing', owner: 'ws_example', service: { id: v1Postgres.id } });

        expect(creates()).toEqual(['CREATE DATABASE "example_testing" OWNER "ws_example"']);
        expect(docker.databases.has('example_testing')).toBe(true);
        const sql = docker.psql().map(sqlOf);
        const grants = sql.find((s) => s.includes('ON DATABASE "example_testing"'));
        expect(grants).toBeDefined();
        expect(grants).toContain('REVOKE CONNECT ON DATABASE "example_testing" FROM PUBLIC');
        expect(grants).toContain('GRANT ALL PRIVILEGES ON DATABASE "example_testing" TO "ws_example"');
        // No other workspace's role is granted anything on it.
        expect(sql.filter((s) => s.includes('example_testing') && s.includes('ws_example_other'))).toEqual([]);
        // Every statement ran as the ENGINE's superuser — never as the workspace role.
        for (const argv of docker.psql()) expect(argv[1]).toMatch(/^postgresql:\/\/postgres:admin-pg-secret@127\.0\.0\.1:5432\//);
        // The database is recorded on the workspace's slice — and on no other workspace's.
        const i = services.engines.list().find((x) => x.id === v1Postgres.id)!;
        expect(i.slices![WS]!.databases).toEqual(['example_testing']);
        expect(i.slices![OTHER]!.databases).toBeUndefined();
    });

    it('a denied request creates nothing', async () => {
        const pending = call('t-example', { action: 'createDatabase', id: v1Postgres.id, name: 'example_testing' });
        services.approvals.resolve((await asked()).id, 'deny');
        const r = await pending;
        expect(r.isError).toBe(true);
        expect(r.json.error).toMatch(/denied by the person; nothing was created/);
        expect(creates()).toEqual([]);
    });

    it('on a SHARED pgvector, Genie also creates `vector` in the new database, as the superuser — after it is the workspace’s', async () => {
        await services.engines.add({ engine: 'postgres', major: '17', variant: 'pgvector', scope: { kind: 'shared' }, consent: true, workspaceId: WS });
        const vector = services.engines.list().find((x) => x.variant === 'pgvector')!;
        const pending = call('t-example', { action: 'createDatabase', id: vector.id, name: 'example_vectors' });
        services.approvals.resolve((await asked()).id, 'allow');
        expect((await pending).isError).toBe(false);
        const ext = docker.psql().filter((a) => sqlOf(a).startsWith('CREATE EXTENSION') && a[1]!.endsWith('/example_vectors'));
        expect(ext.map(sqlOf)).toEqual(['CREATE EXTENSION IF NOT EXISTS "vector"']);
        const order = docker.psql().map(sqlOf);
        expect(order.findIndex((s) => s.includes('ON DATABASE "example_vectors"'))).toBeLessThan(order.lastIndexOf('CREATE EXTENSION IF NOT EXISTS "vector"'));
    });
});

describe('createDatabase is refused, with the reason in words, BEFORE the person is asked and before anything is created', () => {
    const refused = async (terminalId: string, args: JsonObject) => {
        // Adding a shared engine below makes a workspace's own slice database: what counts is what THIS call creates.
        const before = creates().length;
        const r = await call(terminalId, { action: 'createDatabase', ...args });
        expect(r.isError).toBe(true);
        expect(services.approvals.deckItems()).toEqual([]);
        expect(creates().slice(before)).toEqual([]);
        return String(r.json.error);
    };

    it('an invalid name — each named; a valid one is asked (control)', async () => {
        for (const name of ['Example', '1example', 'ex-ample', 'ex ample', 'ex"ample', 'x'.repeat(64), '']) {
            expect(await refused('t-example', { id: v1Postgres.id, name })).toMatch(/name/i);
        }
        // Names Genie gives workspaces' own databases, and Postgres's own, are not a workspace's to take.
        expect(await refused('t-example', { id: v1Postgres.id, name: 'ws_example_stranger' })).toMatch(/ws_/);
        expect(await refused('t-example', { id: v1Postgres.id, name: 'pg_example' })).toMatch(/pg_/);
        // Control: the boundary name (63 characters, leading underscore) is valid and goes to the person.
        const pending = call('t-example', { action: 'createDatabase', id: v1Postgres.id, name: `_${'a'.repeat(62)}` });
        services.approvals.resolve((await asked()).id, 'deny');
        await pending;
    });

    it('a database that already exists — the engine’s own answer', async () => {
        expect(await refused('t-example', { id: v1Postgres.id, name: 'already_here' })).toMatch(/already_here.*already exists/);
        expect(await refused('t-example', { id: v1Postgres.id, name: 'postgres' })).toMatch(/already exists/);
    });

    it('an engine that is not a Postgres', async () => {
        expect(await refused('t-example', { id: v1Mysql.id, name: 'example_testing' })).toMatch(/mysql 8.*not a Postgres|only.*Postgres/i);
    });

    it('an engine the workspace cannot use: another workspace’s, one it has no database on, one it is detached from, its own dedicated one', async () => {
        // No slice on Genie 1's engine: not this workspace's to see.
        expect(await refused('t-stranger', { id: v1Postgres.id, name: 'stranger_testing' })).toMatch(/not one of this workspace’s services/);
        // A new shared Postgres the stranger has no database on: visible, not usable.
        await services.engines.add({ engine: 'postgres', major: '16', scope: { kind: 'shared' }, consent: true, workspaceId: WS });
        const shared16 = services.engines.list().find((x) => x.version === '16')!;
        expect(await refused('t-stranger', { id: shared16.id, name: 'stranger_testing' })).toMatch(/no database on|`add`/);
        // Another workspace's own engine.
        await services.engines.add({ engine: 'postgres', major: '15', scope: { kind: 'dedicated', workspaceId: OTHER }, consent: true, workspaceId: OTHER });
        const others = services.engines.list().find((x) => x.version === '15')!;
        expect(await refused('t-example', { id: others.id, name: 'example_testing' })).toMatch(/not one of this workspace’s services/);
        // Its own dedicated one: its user is that engine's superuser and creates databases itself.
        await services.engines.add({ engine: 'postgres', major: '14', scope: { kind: 'dedicated', workspaceId: WS }, consent: true, workspaceId: WS });
        const mine = services.engines.list().find((x) => x.version === '14')!;
        expect(await refused('t-example', { id: mine.id, name: 'example_testing' })).toMatch(/shared/);
        // Detached from the shared one.
        await services.engines.detach(WS, v1Postgres.id);
        expect(await refused('t-example', { id: v1Postgres.id, name: 'example_testing' })).toMatch(/detached/);
    });

    it('`id` and `name` are both needed', async () => {
        expect(await refused('t-example', { name: 'example_testing' })).toMatch(/`id`/);
        expect(await refused('t-example', { id: v1Postgres.id })).toMatch(/`name`/);
    });
});

describe('the services tool and its skill name the action', () => {
    it('the tool’s description, its action list and the genie-services skill list createDatabase', () => {
        const def = tools.find((t) => t.definition.name === 'services')!.definition;
        expect(def.description).toMatch(/`createDatabase` \{id, name\}/);
        const schema = def.inputSchema as { properties: { action: { enum: string[] } } };
        expect(schema.properties.action.enum).toContain('createDatabase');
        expect(GENIE_SKILLS.find((s) => s.name === 'genie-services')!.body).toMatch(/`createDatabase`/);
    });
});
