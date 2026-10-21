import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ServiceInstance } from '../src/core/services.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import { hostingTools } from '../src/main/mcp-tools-hosting.js';
import type { Caller, Registration } from '../src/main/mcp-tools.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * AN AGENT CHOOSES ITS WORKSPACE'S DATABASE THROUGH GENIE, AND THE PERSON APPROVES IT (2026-10-15). The moic agent could
 * not detach its workspace from Genie 1's shared `postgres-17`, nor make a pgvector Postgres its database. Now the
 * `services` tool has `use` and `detach` — each put to the PERSON first, naming the engine and what the workspace uses
 * before and after — and `add` takes `variant: "pgvector"` and a custom image's `kind`. Run against the REAL composition
 * and the REAL approval queue (Docker is a fake runner), so the agent's choice is the Services tab's choice. Counted:
 * what was asked, what Docker was asked, what the env says.
 */

const pty: PtyPort = {
    open: () => ({ id: 'term_1', pid: 1, shell: 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
    onData: () => () => {}, onExit: () => () => {},
};

function fakeDocker() {
    const calls: (readonly string[])[] = [];
    const images = new Set<string>();
    const containers = new Map<string, 'created' | 'running' | 'exited'>();
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
        if (cmd === 'exec') return { stdout: args.includes('PING') ? 'PONG\n' : '', exitCode: 0 };
        return { stdout: '', exitCode: 0 };
    };
    return { run, calls };
}

const WS = 'example';
const OTHER = 'example-other';
const V1_PORT = 37605;
const v1Postgres: ServiceInstance = {
    id: 'svc_v1_postgres-17', engine: 'postgres', version: '17', scope: { kind: 'shared' }, publishedPort: V1_PORT, credentials: {}, active: true, adopted: 'v1',
    containerName: 'genie-svc-postgres-17', admin: { user: 'postgres', password: 'admin-pg-secret' },
    slices: { [WS]: { identifier: 'ws_example', password: 'example-v1-pw', active: true } },
    publishedPorts: { postgres: V1_PORT },
};

let dir: string;
let docker: ReturnType<typeof fakeDocker>;
let services: ComposedServices;
let tools: Registration[];
const callers: Record<string, Caller> = {};
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });

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

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-mcp-db-choice-'));
    docker = fakeDocker();
    for (const ws of [WS, OTHER]) {
        await mkdir(join(dir, ws), { recursive: true });
        await writeFile(join(dir, ws, 'project.json'), `${JSON.stringify({ name: ws, repos: [] }, null, 2)}\n`, 'utf8');
    }
    services = await composeServices({
        userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker: docker.run, portFree: async () => true,
        workspaces: () => [{ id: WS, path: join(dir, WS) }, { id: OTHER, path: join(dir, OTHER) }],
    });
    await services.engines.adoptFromV1({ instances: [v1Postgres], record: { at: '2026-10-15T00:00:00.000Z', sawV1: true, sawDocker: true } });
    callers['t-example'] = { agentId: mintAgentId(), agentName: 'atlas', workspaceId: WS, workspacePath: join(dir, WS) };
    callers['t-other'] = { agentId: mintAgentId(), agentName: 'vega', workspaceId: OTHER, workspacePath: join(dir, OTHER) };
    tools = hostingTools({ resolveCaller: (id) => callers[id] ?? null, approve: (c, a, d) => services.approvals.gate(c, a, d), services });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('services detach / use: the person decides', () => {
    it('DENIED: the person was asked — naming Genie 1’s engine — and the workspace still gets its DB_*', async () => {
        expect(services.engines.envFor(WS).DB_PORT).toBe(String(V1_PORT));
        const pending = call('t-example', { action: 'detach', id: v1Postgres.id });
        const item = await asked();
        expect(item.title).toBe('atlas wants to change which service this workspace uses: stop the shared postgres 17 (127.0.0.1:37605) giving this workspace its postgres connection — its database and data stay in it, and `use` attaches it again');
        services.approvals.resolve(item.id, 'deny');
        const r = await pending;
        expect(r.isError).toBe(true);
        expect(r.json.error).toMatch(/denied by the person; nothing was changed/);
        expect(services.engines.envFor(WS).DB_PORT).toBe(String(V1_PORT));
        expect(services.engines.list().find((i) => i.id === v1Postgres.id)!.detached).toBeUndefined();
    });

    it('ALLOWED: detached — no DB_* for this workspace, the slice kept, Docker never asked; `use` (approved) brings it back', async () => {
        const pending = call('t-example', { action: 'detach', id: v1Postgres.id });
        services.approvals.resolve((await asked()).id, 'allow');
        const r = await pending;
        expect(r.isError).toBe(false);
        expect(r.json).toMatchObject({ ok: true, kind: 'postgres', using: null });
        expect(services.engines.envFor(WS)).not.toHaveProperty('DB_PORT');
        expect(services.engines.list().find((i) => i.id === v1Postgres.id)!.slices![WS]).toMatchObject({ identifier: 'ws_example', password: 'example-v1-pw' });
        expect(docker.calls.filter((c) => c[0] === 'stop' || c[0] === 'rm' || c[0] === 'exec')).toEqual([]);
        // `list` says it is detached and not in use.
        const listed = await call('t-example', { action: 'list' });
        expect((listed.json.services as Array<Record<string, unknown>>).find((s) => s.id === v1Postgres.id)).toMatchObject({ takenOverFromGenie1: true, detached: true, inUse: false });

        const back = call('t-example', { action: 'use', id: v1Postgres.id });
        const item = await asked();
        expect(item.title).toBe('atlas wants to change which service this workspace uses: postgres for this workspace: no postgres → postgres 17, shared (127.0.0.1:37605) — its terminals and sites get postgres 17, shared’s connection; nothing is deleted, and the other engine keeps its data');
        services.approvals.resolve(item.id, 'allow');
        expect((await back).json).toMatchObject({ ok: true, kind: 'postgres', using: { id: v1Postgres.id, inUse: true } });
        expect(services.engines.envFor(WS).DB_PORT).toBe(String(V1_PORT));
    });

    it('refused WITHOUT asking: detaching the workspace’s own engine, Genie 1’s engine from a workspace with no slice of it, another workspace’s engine — the deck stays empty', async () => {
        const add = call('t-example', { action: 'add', engine: 'postgres', version: '17', variant: 'pgvector' });
        services.approvals.resolve((await asked()).id, 'allow');
        const own = (await add).json.service as { id: string; port: number };
        const refusals = [
            await call('t-example', { action: 'detach', id: own.id }),
            // OTHER holds no slice of Genie 1's engine: it is not one of OTHER's services at all.
            await call('t-other', { action: 'detach', id: v1Postgres.id }),
            await call('t-other', { action: 'use', id: own.id }),
        ];
        expect(refusals.map((r) => r.isError)).toEqual([true, true, true]);
        expect(refusals[0]!.json.error).toMatch(/own engine: stop or remove it/);
        expect(refusals[1]!.json.error).toMatch(/is not one of this workspace’s services/);
        expect(services.approvals.deckItems()).toEqual([]);
        // Control: the same agent's `use` of the shared one IS put to the person.
        const pending = call('t-example', { action: 'use', id: v1Postgres.id });
        const item = await asked();
        expect(item.title).toContain('postgres (pgvector) 17 → postgres 17, shared');
        services.approvals.resolve(item.id, 'deny');
        expect((await pending).isError).toBe(true);
    });
});

describe('services add: pgvector and a custom image’s kind', () => {
    it('catalog lists the pgvector variant with its images and the kinds a custom image can be', async () => {
        const r = await call('t-example', { action: 'catalog' });
        const engines = r.json.engines as Array<Record<string, any>>;
        expect(engines.find((e) => e.engine === 'postgres')!.variants).toEqual([
            { variant: 'pgvector', summary: 'PostgreSQL with pgvector — the `vector` type and its ivfflat and hnsw indexes', images: ['pgvector/pgvector:pg14', 'pgvector/pgvector:pg15', 'pgvector/pgvector:pg16', 'pgvector/pgvector:pg17'] },
        ]);
        expect(engines.find((e) => e.engine === 'custom')!.kinds).toEqual(['postgres', 'mysql', 'mariadb', 'redis', 'mongo']);
        // Control: an engine without variants lists none.
        expect(engines.find((e) => e.engine === 'redis')).not.toHaveProperty('variants');
    });

    it('{engine: postgres, version: 17, variant: pgvector}: the person sees the pgvector image, it is pulled, and it — not Genie 1’s — is the workspace’s database', async () => {
        const pending = call('t-example', { action: 'add', engine: 'postgres', version: '17', variant: 'pgvector' });
        const item = await asked();
        expect(item.title).toBe('atlas wants to add a service: postgres (pgvector) 17, for this workspace only — Genie pulls the image pgvector/pgvector:pg17 if it is not on this machine yet, then creates and starts the container');
        services.approvals.resolve(item.id, 'allow');
        const r = await pending;
        expect(r.json.service).toMatchObject({ engine: 'postgres', variant: 'pgvector', version: '17', inUse: true });
        expect(docker.calls.filter((c) => c[0] === 'pull').map((c) => c[1])).toEqual(['pgvector/pgvector:pg17']);
        expect(services.engines.envFor(WS).DB_PORT).toBe(String(r.json.service.port));
        expect(Object.values(services.engines.envFor(WS)).filter((v) => v.includes(String(V1_PORT)))).toEqual([]);
    });

    it('a custom image with kind postgres: approved with the kind named, and DB_* come from its live port', async () => {
        const pending = call('t-example', { action: 'add', engine: 'custom', name: 'pgvector', image: 'pgvector/pgvector:pg17', port: 5432, kind: 'postgres', env: { POSTGRES_USER: 'example', POSTGRES_PASSWORD: 'example-own-pw', POSTGRES_DB: 'example' } });
        const item = await asked();
        expect(item.title).toContain('a custom image pgvector/pgvector:pg17 named "pgvector" (listening on 5432 inside), as this workspace’s postgres, env POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB');
        expect(item.title).not.toContain('example-own-pw');
        services.approvals.resolve(item.id, 'allow');
        const r = await pending;
        expect(r.json.service).toMatchObject({ engine: 'custom', kind: 'postgres', inUse: true });
        expect(services.engines.envFor(WS)).toMatchObject({ DB_PORT: String(r.json.service.port), DB_USERNAME: 'example', DATABASE_URL: `postgresql://example:example-own-pw@127.0.0.1:${r.json.service.port}/example` });
        // `kind` on a catalog engine is refused without asking.
        const wrong = await call('t-example', { action: 'add', engine: 'postgres', version: '16', kind: 'postgres' });
        expect(wrong.isError).toBe(true);
        expect(services.approvals.deckItems()).toEqual([]);
    });
});

describe('the Services tab makes the same choice, without an approval (it IS the person)', () => {
    it('services.detach then services.use by id', async () => {
        await handleFeatureAction(services, { kind: 'services.detach', workspaceId: WS, serviceId: v1Postgres.id }, state());
        expect(services.engines.envFor(WS)).not.toHaveProperty('DB_PORT');
        await handleFeatureAction(services, { kind: 'services.use', workspaceId: WS, serviceId: v1Postgres.id }, state());
        expect(services.engines.envFor(WS).DB_PORT).toBe(String(V1_PORT));
        expect(services.approvals.deckItems()).toEqual([]);
    });
});
