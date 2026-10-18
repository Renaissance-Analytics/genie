import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import { genieToolDeps } from '../src/main/genie-tool-deps.js';
import { allGenieTools } from '../src/main/mcp-registrations.js';
import { hostingTools, maskEnv } from '../src/main/mcp-tools-hosting.js';
import type { Caller, Registration } from '../src/main/mcp-tools.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * AGENTS CONFIGURE SERVICES AND SITES THROUGH GENIE (the owner, 2026-10-14: "agents should be using genie mcp tools to
 * do all configuration and genie app (not the agent), handles sites and services setup, start, etc."). The `services`
 * and `sites` tools run against the REAL composition (Docker is an injected fake runner, as in
 * feature-ipc-services.test.ts) with the REAL approval queue, so what an agent does is what the Services and Hosting
 * tabs do: same validation, same env, same records. Every claim is counted; every absence has its positive control.
 */

const opened: Array<{ command?: string | undefined; env?: Readonly<Record<string, string>> | undefined }> = [];
const dataListeners = new Set<(id: string, data: string) => void>();
const pty: PtyPort = {
    open: (o) => { opened.push({ command: o.command, env: o.env }); return { id: `term_${opened.length}`, pid: 1, shell: o.command ?? 'sh', scrollback: '' }; },
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
    onData: (l) => { dataListeners.add(l); return () => dataListeners.delete(l); }, onExit: () => () => {},
};
/** What `sites open` put in front of the person, in Genie's browser. */
const shown: string[] = [];

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
        if (cmd === 'stop') { containers.set(args[1]!, 'exited'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'rm') { containers.delete(args[2]!); return { stdout: '', exitCode: 0 }; }
        // What the engine wrote, as `docker logs` answers it (set per test).
        if (cmd === 'logs') return { stdout: engineLog.text, exitCode: 0 };
        // An engine's own client inside its container (a shared engine's workspace slice): redis-cli prints the answer.
        if (cmd === 'exec') return { stdout: args.includes('PING') ? 'PONG\n' : args.includes('SETUSER') ? 'OK\n' : '', exitCode: 0 };
        return { stdout: '', exitCode: 0 };
    };
    const engineLog = { text: 'ready to accept connections\n' };
    return { run, calls, containers, engineLog };
}

let dir: string;
let docker: ReturnType<typeof fakeDocker>;
let services: ComposedServices;
let tools: Registration[];
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });
const pg = { workspaceId: 'example', engine: 'postgres', major: '17', scope: 'dedicated' as const };
const callers: Record<string, Caller> = {};

/** One call as an agent, by its terminal. */
async function call(name: 'services' | 'sites', terminalId: string, args: JsonObject, set: Registration[] = tools) {
    const reg = set.find((t) => t.definition.name === name)!;
    const r = await reg.handler({ ...args, terminalId }, { server: 'genie', tool: name, headers: {} });
    return { ...r, json: JSON.parse(r.text) as Record<string, any> };
}

/** The approval the call is waiting on, once it has asked. */
async function asked(): Promise<{ id: string; title: string }> {
    for (let i = 0; i < 200 && services.approvals.deckItems().length === 0; i++) await new Promise((r) => setTimeout(r, 0));
    const [item] = services.approvals.deckItems();
    expect(item).toBeDefined();
    return { id: item!.id, title: item!.title };
}

const dockerCalls = (verb: string) => docker.calls.filter((c) => c[0] === verb).length;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-mcp-hosting-'));
    docker = fakeDocker();
    opened.length = 0;
    shown.length = 0;
    for (const ws of ['example', 'example-other']) {
        await mkdir(join(dir, ws), { recursive: true });
        await writeFile(join(dir, ws, 'project.json'), `${JSON.stringify({ name: ws, repos: [] }, null, 2)}\n`, 'utf8');
    }
    services = await composeServices({
        userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker: docker.run, portFree: async () => true,
        workspaces: () => [{ id: 'example', path: join(dir, 'example') }, { id: 'example-other', path: join(dir, 'example-other') }],
    });
    callers['t-example'] = { agentId: mintAgentId(), agentName: 'atlas', workspaceId: 'example', workspacePath: join(dir, 'example') };
    callers['t-other'] = { agentId: mintAgentId(), agentName: 'vega', workspaceId: 'example-other', workspacePath: join(dir, 'example-other') };
    tools = hostingTools({ resolveCaller: (id) => callers[id] ?? null, approve: (c, a, d) => services.approvals.gate(c, a, d), services, openInBrowser: async (url) => { shown.push(url); return { ok: true }; } });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('services: reading', () => {
    it('catalog: the engines Genie offers with their versions and images — never MinIO, which can only be taken over', async () => {
        const r = await call('services', 't-example', { action: 'catalog' });
        expect(r.isError).toBe(false);
        const engines = r.json.engines as Array<{ engine: string; versions: string[]; images: string[]; scopes: string[] }>;
        expect(engines.map((e) => e.engine)).toEqual(['postgres', 'mysql', 'mariadb', 'redis', 'mongo', 'websockets', 'mailpit', 'meilisearch', 'seaweedfs', 'custom']);
        expect(engines.find((e) => e.engine === 'meilisearch')!.images).toEqual(['getmeili/meilisearch:v1']);
        expect(engines.find((e) => e.engine === 'seaweedfs')).toMatchObject({ images: ['chrislusf/seaweedfs:4.48'], scopes: ['shared'] });
        expect(engines.find((e) => e.engine === 'custom')).toMatchObject({ versions: [], images: [], scopes: ['dedicated'] });
        expect(engines.find((e) => e.engine === 'postgres')).toMatchObject({ versions: ['14', '15', '16', '17'], scopes: ['dedicated', 'shared'] });
        expect(engines.find((e) => e.engine === 'postgres')!.images).toContain('postgres:17');
        expect(engines.find((e) => e.engine === 'mailpit')!.images).toEqual(['axllent/mailpit:v1.30']);
        expect(engines.find((e) => e.engine === 'websockets')!.scopes).toEqual(['shared']);
    });

    it('list: its own engines and the shared ones, with live status, and never another workspace’s — counted; no credential in the answer', async () => {
        await handleFeatureAction(services, { kind: 'services.create', form: pg, consent: true }, state());
        await handleFeatureAction(services, { kind: 'services.create', form: { ...pg, workspaceId: 'example-other', major: '16' }, consent: true }, state());
        await handleFeatureAction(services, { kind: 'services.create', form: { workspaceId: 'example', engine: 'redis', major: '7', scope: 'shared' }, consent: true }, state());
        expect(services.engines.list()).toHaveLength(3);

        const mine = await call('services', 't-example', { action: 'list' });
        expect((mine.json.services as Array<Record<string, unknown>>).map((s) => [s.engine, s.version, s.scope, s.status])).toEqual([['postgres', '17', 'dedicated', 'running'], ['redis', '7', 'shared', 'running']]);
        const theirs = await call('services', 't-other', { action: 'list' });
        expect((theirs.json.services as Array<Record<string, unknown>>).map((s) => [s.engine, s.version])).toEqual([['postgres', '16'], ['redis', '7']]);

        // The absence is the claim; the positive control is that each engine HAS a password to leak — the two dedicated
        // Postgres credentials, and the shared Redis's superuser and the workspace's own ACL user (H3).
        const passwords = services.engines.list()
            .flatMap((i) => [i.credentials.password, i.admin?.password, ...Object.values(i.slices ?? {}).map((s) => s.password)])
            .filter((p): p is string => typeof p === 'string');
        expect(passwords).toHaveLength(4);
        for (const p of passwords) {
            expect(p.length).toBeGreaterThan(10);
            expect(mine.text).not.toContain(p);
            expect(theirs.text).not.toContain(p);
        }
        expect(mine.text).not.toMatch(/credentials|password/i);
    });

    it('env: every variable name, the values, and the secrets MASKED — counted, with the real password the control', async () => {
        await handleFeatureAction(services, { kind: 'services.create', form: pg, consent: true }, state());
        const real = services.engines.envFor('example');
        expect(real.DB_PASSWORD).toMatch(/.{10,}/);

        const r = await call('services', 't-example', { action: 'env' });
        expect(r.isError).toBe(false);
        const variables = r.json.variables as Record<string, string>;
        expect(Object.keys(variables).sort()).toEqual(Object.keys(real).sort());
        expect((r.json.masked as string[]).sort()).toEqual(['DATABASE_URL', 'DB_PASSWORD', 'PGPASSWORD']);
        expect(variables.DB_PORT).toBe(real.DB_PORT);
        expect(variables.DB_USERNAME).toBe('genie');
        expect(variables.DATABASE_URL).toBe(real.DATABASE_URL!.replace(real.DB_PASSWORD!, '********'));
        expect(r.text).not.toContain(real.DB_PASSWORD!);
    });

    it('maskEnv masks a password inside a URL even with no password variable beside it (a MongoDB URI) — and leaves a URL without one alone', () => {
        const m = maskEnv({ MONGODB_URI: 'mongodb://genie:s3cr3t-value@127.0.0.1:4101', REDIS_URL: 'redis://127.0.0.1:4102', AWS_SECRET_ACCESS_KEY: 'k3y', MAIL_PORT: '4103' });
        expect(m.variables).toEqual({ MONGODB_URI: 'mongodb://genie:********@127.0.0.1:4101', REDIS_URL: 'redis://127.0.0.1:4102', AWS_SECRET_ACCESS_KEY: '********', MAIL_PORT: '4103' });
        expect(m.masked.sort()).toEqual(['AWS_SECRET_ACCESS_KEY', 'MONGODB_URI']);
    });

    it('a key the env also publishes under a VITE_ name is PUBLIC (the browser downloads it) — a key no VITE_ name carries, and every secret, stays masked (counted)', () => {
        const m = maskEnv({
            REVERB_APP_KEY: 'ws_example', VITE_REVERB_APP_KEY: 'ws_example', GENIE_WS_APP_KEY: 'ws_example',
            REVERB_APP_SECRET: 's3cr3t-app', GENIE_WS_APP_SECRET: 's3cr3t-app',
            MEILISEARCH_KEY: 'm4ster-key',
        });
        expect(m.variables).toEqual({
            REVERB_APP_KEY: 'ws_example', VITE_REVERB_APP_KEY: 'ws_example', GENIE_WS_APP_KEY: 'ws_example',
            REVERB_APP_SECRET: '********', GENIE_WS_APP_SECRET: '********',
            MEILISEARCH_KEY: '********',
        });
        expect(m.masked.sort()).toEqual(['GENIE_WS_APP_SECRET', 'MEILISEARCH_KEY', 'REVERB_APP_SECRET']);
    });
});

describe('services: add goes through the person', () => {
    it('DENIED: the person was asked — naming the engine, the version and the image that would be pulled — and nothing was pulled or created', async () => {
        const pending = call('services', 't-example', { action: 'add', engine: 'postgres', version: '17' });
        const item = await asked();
        expect(item.title).toBe('atlas wants to add a service: postgres 17, for this workspace only — Genie pulls the image postgres:17 if it is not on this machine yet, then creates and starts the container');
        expect(dockerCalls('pull') + dockerCalls('create')).toBe(0);
        services.approvals.resolve(item.id, 'deny');
        const r = await pending;
        expect(r.isError).toBe(true);
        expect(r.json.error).toMatch(/denied/);
        expect(dockerCalls('pull') + dockerCalls('create')).toBe(0);
        expect(services.engines.list()).toEqual([]);
    });

    it('ALLOWED: the approval is the pull’s consent — pulled, created, started, and the workspace env carries it', async () => {
        const pending = call('services', 't-example', { action: 'add', engine: 'postgres', version: '17' });
        services.approvals.resolve((await asked()).id, 'allow');
        const r = await pending;
        expect(r.isError).toBe(false);
        expect(r.json.outcome).toBe('added');
        expect(r.json.service).toMatchObject({ engine: 'postgres', version: '17', scope: 'dedicated', status: 'running', active: true });
        expect(docker.calls.filter((c) => c[0] === 'pull').map((c) => c[1])).toEqual(['postgres:17']);
        expect(services.engines.list().map((i) => [i.engine, i.version, i.scope])).toEqual([['postgres', '17', { kind: 'dedicated', workspaceId: 'example' }]]);
        expect(services.engines.envFor('example').DB_PORT).toBe(String(r.json.service.port));
        expect(services.engines.envFor('example-other')).not.toHaveProperty('DB_PORT');
    });

    it('a request Genie would refuse is refused WITHOUT asking: an unknown version, a dedicated WebSockets engine, MinIO — counted, the deck empty', async () => {
        const refusals = [
            await call('services', 't-example', { action: 'add', engine: 'postgres', version: '12' }),
            await call('services', 't-example', { action: 'add', engine: 'websockets', version: '4.7.0', scope: 'dedicated' }),
            await call('services', 't-example', { action: 'add', engine: 'minio', version: 'latest', scope: 'shared' }),
            await call('services', 't-example', { action: 'add', engine: 'postgres' }),
        ];
        expect(refusals.map((r) => r.isError)).toEqual([true, true, true, true]);
        expect(refusals[0]!.json.error).toBe('postgres 12 is not a version Genie knows (14, 15, 16, 17).');
        expect(services.approvals.deckItems()).toEqual([]);
        expect(docker.calls.filter((c) => c[0] === 'pull' || c[0] === 'create')).toEqual([]);
    });

    it('the same refusal the Services tab’s form shows, word for word (one validation)', async () => {
        const tab = await handleFeatureAction(services, { kind: 'services.create', form: { ...pg, major: '12' }, consent: false }, state());
        const agent = await call('services', 't-example', { action: 'add', engine: 'postgres', version: '12' });
        expect(agent.json.problems).toEqual(tab.services!.adding!.problems);
        expect((agent.json.problems as unknown[]).length).toBe(1);
    });
});

describe('services: start, stop, remove', () => {
    it('stop and start act at once on its own engine (no approval), and the status read back from Docker says so', async () => {
        await handleFeatureAction(services, { kind: 'services.create', form: pg, consent: true }, state());
        const id = services.engines.list()[0]!.id;
        const stopped = await call('services', 't-example', { action: 'stop', id });
        expect(stopped.json.service).toMatchObject({ id, status: 'exited' });
        const started = await call('services', 't-example', { action: 'start', id });
        expect(started.json.service).toMatchObject({ id, status: 'running' });
        expect(services.approvals.deckItems()).toEqual([]);
    });

    it('another workspace’s engine is refused for every action, without asking and without a Docker call — the owner’s own call is the control', async () => {
        await handleFeatureAction(services, { kind: 'services.create', form: pg, consent: true }, state());
        const id = services.engines.list()[0]!.id;
        const mark = docker.calls.length;
        const refused = await Promise.all(['start', 'stop', 'remove'].map((action) => call('services', 't-other', { action, id })));
        expect(refused.map((r) => [r.isError, /not one of this workspace’s services/.test(String(r.json.error))])).toEqual([[true, true], [true, true], [true, true]]);
        expect(docker.calls.slice(mark).filter((c) => ['start', 'stop', 'rm'].includes(c[0]!))).toEqual([]);
        expect(services.approvals.deckItems()).toEqual([]);
        // Control: the same id from its own workspace goes through.
        expect((await call('services', 't-example', { action: 'stop', id })).isError).toBe(false);
        expect(docker.calls.slice(mark).filter((c) => c[0] === 'stop')).toHaveLength(1);
    });

    it('a SHARED engine is seen and started by an agent, never stopped or removed by one (it serves every workspace)', async () => {
        await handleFeatureAction(services, { kind: 'services.create', form: { workspaceId: 'example', engine: 'redis', major: '7', scope: 'shared' }, consent: true }, state());
        const id = services.engines.list()[0]!.id;
        expect((await call('services', 't-other', { action: 'start', id })).isError).toBe(false);
        const stop = await call('services', 't-other', { action: 'stop', id });
        const remove = await call('services', 't-example', { action: 'remove', id });
        expect([stop.isError, remove.isError]).toEqual([true, true]);
        expect(stop.json.error).toMatch(/shared by every workspace/);
        expect(dockerCalls('stop') + dockerCalls('rm')).toBe(0);
        expect(services.approvals.deckItems()).toEqual([]);
    });

    it('deleteData is refused OUTRIGHT — never put to the person, nothing removed; a plain remove asks, and keeps the data volume', async () => {
        await handleFeatureAction(services, { kind: 'services.create', form: pg, consent: true }, state());
        const id = services.engines.list()[0]!.id;
        const refused = await call('services', 't-example', { action: 'remove', id, deleteData: true });
        expect(refused.isError).toBe(true);
        expect(refused.json.error).toMatch(/never deletes/);
        expect(services.approvals.deckItems()).toEqual([]);
        expect(dockerCalls('rm')).toBe(0);
        expect(services.engines.list()).toHaveLength(1);

        const pending = call('services', 't-example', { action: 'remove', id });
        const item = await asked();
        expect(item.title).toMatch(/^atlas wants to remove a service: postgres 17 \(127\.0\.0\.1:\d+\) — its container is removed; its data volume is KEPT$/);
        services.approvals.resolve(item.id, 'allow');
        const r = await pending;
        expect(r.json).toMatchObject({ ok: true, removed: id, dataKept: true });
        expect(dockerCalls('rm')).toBe(1);
        expect(docker.calls.filter((c) => c[0] === 'volume')).toEqual([]);
        expect(services.engines.list()).toEqual([]);
    });

    it('a denied remove removes nothing', async () => {
        await handleFeatureAction(services, { kind: 'services.create', form: pg, consent: true }, state());
        const id = services.engines.list()[0]!.id;
        const pending = call('services', 't-example', { action: 'remove', id });
        services.approvals.resolve((await asked()).id, 'deny');
        expect((await pending).isError).toBe(true);
        expect(dockerCalls('rm')).toBe(0);
        expect(services.engines.list()).toHaveLength(1);
    });

    it('the Services tab hears an agent act: the registry’s onChange fires on its add, stop, start and remove — counted', async () => {
        let changes = 0;
        services.engines.onChange(() => { changes += 1; });
        const adding = call('services', 't-example', { action: 'add', engine: 'postgres', version: '17' });
        services.approvals.resolve((await asked()).id, 'allow');
        await adding;
        expect(changes).toBe(1);
        const id = services.engines.list()[0]!.id;
        await call('services', 't-example', { action: 'stop', id });
        await call('services', 't-example', { action: 'start', id });
        expect(changes).toBe(3);
        const removing = call('services', 't-example', { action: 'remove', id });
        services.approvals.resolve((await asked()).id, 'allow');
        await removing;
        expect(changes).toBe(4);
    });
});

describe('services: logs (H6)', () => {
    it('the end of the engine’s output, bounded — and every credential Genie holds for that engine MASKED in it (another workspace’s password is the control: present in the raw log)', async () => {
        const shared = { engine: 'redis', major: '7', scope: 'shared' as const };
        await handleFeatureAction(services, { kind: 'services.create', form: { ...shared, workspaceId: 'example' }, consent: true }, state());
        await handleFeatureAction(services, { kind: 'services.create', form: { ...shared, workspaceId: 'example-other' }, consent: true }, state());
        const redis = services.engines.list()[0]!;
        const theirs = redis.slices!['example-other']!.password;
        const admin = redis.admin!.password;
        docker.engineLog.text = `ACL SETUSER ws_example_other reset on >${theirs} ~ws_example_other:*\nrequirepass ${admin}\nready\n`;

        const r = await call('services', 't-example', { action: 'logs', id: redis.id, tail: 999_999 });
        expect(r.isError).toBe(false);
        expect(docker.calls.filter((c) => c[0] === 'logs')).toEqual([['logs', '--timestamps', '--tail', '5000', 'genie-shared-redis-7']]);
        expect(r.json).toMatchObject({ ok: true, id: redis.id, tail: 5000 });
        expect(r.text).not.toContain(theirs);
        expect(r.text).not.toContain(admin);
        expect((r.json.logs as string).match(/\*{8}/g)).toHaveLength(2);
        expect(r.json.logs).toContain('ready');
    });

    it('a WebSockets engine: EVERY workspace app’s secret masked in its log, counted — each app’s id stays visible (the control)', async () => {
        const ws = { engine: 'websockets', major: '4.7.0', scope: 'shared' as const };
        await handleFeatureAction(services, { kind: 'services.create', form: { ...ws, workspaceId: 'example' }, consent: true }, state());
        await handleFeatureAction(services, { kind: 'services.create', form: { ...ws, workspaceId: 'example-other' }, consent: true }, state());
        const engine = services.engines.list().find((i) => i.engine === 'websockets')!;
        const mine = engine.slices!['example']!;
        const theirs = engine.slices!['example-other']!;
        // Two apps, two distinct secrets: there is something of each workspace's to leak.
        expect([mine.identifier, theirs.identifier]).toEqual(['ws_example', 'ws_example_other']);
        expect(mine.password).not.toBe(theirs.password);
        docker.engineLog.text = `app ${mine.identifier} secret ${mine.password}\napp ${theirs.identifier} secret ${theirs.password}\nlistening on 0.0.0.0:6001\n`;

        const r = await call('services', 't-example', { action: 'logs', id: engine.id });
        expect(r.isError).toBe(false);
        expect(docker.calls.filter((c) => c[0] === 'logs')).toEqual([['logs', '--timestamps', '--tail', '500', 'genie-shared-websockets-4.7.0']]);
        expect(r.text).not.toContain(mine.password);
        expect(r.text).not.toContain(theirs.password);
        expect((r.json.logs as string).match(/\*{8}/g)).toHaveLength(2);
        // The ids are not secrets (each is its app's public key too): masked would be over-reach, and they are what a log is read for.
        expect(r.json.logs).toBe('app ws_example secret ********\napp ws_example_other secret ********\nlistening on 0.0.0.0:6001\n');
    });

    it('another workspace’s engine: refused without a Docker call — the owner’s own read is the control', async () => {
        await handleFeatureAction(services, { kind: 'services.create', form: pg, consent: true }, state());
        const id = services.engines.list()[0]!.id;
        const refused = await call('services', 't-other', { action: 'logs', id });
        expect(refused.isError).toBe(true);
        expect(refused.json.error).toMatch(/not one of this workspace’s services/);
        expect(dockerCalls('logs')).toBe(0);
        expect((await call('services', 't-example', { action: 'logs', id })).isError).toBe(false);
        expect(docker.calls.filter((c) => c[0] === 'logs')).toEqual([['logs', '--timestamps', '--tail', '500', 'genie-example-postgres-17']]);
    });
});

describe('services: a custom image goes through the person, image named (H7)', () => {
    const IMAGE = 'registry.example/acme/echo:1';
    const custom = { action: 'add', engine: 'custom', image: IMAGE, port: 8080, env: { GREETING: 'hello', API_TOKEN: 'not-for-the-approval' } };

    it('DENIED: the person saw the image, its port and its env NAMES (never a value) — and nothing was pulled or created', async () => {
        const pending = call('services', 't-example', custom);
        const item = await asked();
        expect(item.title).toBe(`atlas wants to add a service: a custom image ${IMAGE} named "custom" (listening on 8080 inside), env GREETING, API_TOKEN, for this workspace only — Genie pulls the image ${IMAGE} if it is not on this machine yet, then creates and starts the container`);
        expect(item.title).not.toContain('not-for-the-approval');
        services.approvals.resolve(item.id, 'deny');
        const r = await pending;
        expect(r.isError).toBe(true);
        expect(r.json.error).toMatch(/denied/);
        expect(dockerCalls('pull') + dockerCalls('create')).toBe(0);
        expect(services.engines.list()).toEqual([]);
    });

    it('ALLOWED: pulled and created as named, dedicated to the workspace, and its connection is in the workspace’s env', async () => {
        const pending = call('services', 't-example', custom);
        services.approvals.resolve((await asked()).id, 'allow');
        const r = await pending;
        expect(r.isError).toBe(false);
        expect(r.json.service).toMatchObject({ engine: 'custom', version: 'custom', scope: 'dedicated', image: IMAGE });
        expect(docker.calls.filter((c) => c[0] === 'pull').map((c) => c[1])).toEqual([IMAGE]);
        expect(docker.calls.filter((c) => c[0] === 'create')[0]!.at(-1)).toBe(IMAGE);
        expect(services.engines.envFor('example')).toMatchObject({ GENIE_SERVICE_CUSTOM_CUSTOM_HOST: '127.0.0.1', GREETING: 'hello' });
        expect(services.engines.envFor('example-other')).not.toHaveProperty('GREETING');
    });

    it('a custom image Genie would not run is refused WITHOUT asking — no image, a shared scope, an env that is not strings; counted, the deck empty', async () => {
        const refusals = [
            await call('services', 't-example', { action: 'add', engine: 'custom', port: 8080 }),
            await call('services', 't-example', { ...custom, scope: 'shared' }),
            await call('services', 't-example', { ...custom, env: { N: 1 } }),
        ];
        expect(refusals.map((r) => r.isError)).toEqual([true, true, true]);
        expect(refusals[0]!.json.error).toMatch(/Name the image/);
        expect(refusals[1]!.json.error).toMatch(/always dedicated/);
        expect(services.approvals.deckItems()).toEqual([]);
        expect(docker.calls.filter((c) => c[0] === 'pull' || c[0] === 'create')).toEqual([]);
    });
});

describe('sites', () => {
    const add = (terminalId: string, args: JsonObject) => call('sites', terminalId, { action: 'add', ...args });

    it('add: served with the workspace’s service env — the dev server the Hosting tab would run — and kept in project.json; list shows it', async () => {
        await handleFeatureAction(services, { kind: 'services.create', form: pg, consent: true }, state());
        const port = services.engines.list()[0]!.publishedPort;
        const r = await add('t-example', { name: 'example', devCommand: 'npm run dev -- --port {port}', stack: 'node' });
        expect(r.isError).toBe(false);
        expect(r.json.site).toMatchObject({ id: 'site_example', host: 'example.gen', url: 'https://example.gen/', state: 'running' });
        const dev = opened.find((o) => o.command?.startsWith('npm run dev'));
        expect(dev?.env).toMatchObject({ DB_PORT: String(port), DB_DATABASE: 'example' });
        const manifest = JSON.parse(await readFile(join(dir, 'example', 'project.json'), 'utf8')) as { sites?: Record<string, unknown> };
        expect(Object.keys(manifest.sites ?? {})).toHaveLength(1);
        const listed = await call('sites', 't-example', { action: 'list' });
        expect((listed.json.sites as Array<{ host: string }>).map((s) => s.host)).toEqual(['example.gen']);
        // Another workspace's agent does not see it.
        expect((await call('sites', 't-other', { action: 'list' })).json.sites).toEqual([]);
    });

    it('add is refused with the Hosting tab’s own problems, word for word, and nothing is created', async () => {
        const form = { name: 'Not A Label', mode: 'proxy' as const, devServer: null, hostPort: null, root: null, spa: false };
        const tab = await handleFeatureAction(services, { kind: 'hosting.createSite', workspaceId: 'example', repoPath: join(dir, 'example'), form }, state());
        const agent = await add('t-example', { name: 'Not A Label', mode: 'proxy' });
        expect(agent.isError).toBe(true);
        expect(agent.json.problems).toEqual(tab.hosting!.adding!.problems);
        expect((agent.json.problems as unknown[]).length).toBe(2);
        expect(services.sites.list()).toEqual([]);
    });

    it('a folder outside its workspace is refused, and nothing is created or written', async () => {
        const r = await add('t-example', { name: 'elsewhere', repoPath: '../example-other', hostPort: 4999 });
        expect(r.isError).toBe(true);
        expect(r.json.error).toMatch(/outside/);
        expect(services.sites.list()).toEqual([]);
        const other = JSON.parse(await readFile(join(dir, 'example-other', 'project.json'), 'utf8')) as { sites?: unknown };
        expect(other.sites).toBeUndefined();
    });

    it('stop and start at once; remove asks the person — denied keeps it, allowed removes it from project.json', async () => {
        await add('t-example', { name: 'example', devCommand: 'npm run dev -- --port {port}' });
        expect((await call('sites', 't-example', { action: 'stop', site: 'example' })).json.site).toMatchObject({ state: 'stopped' });
        expect((await call('sites', 't-example', { action: 'start', site: 'example.gen' })).json.site).toMatchObject({ state: 'running' });
        expect(services.approvals.deckItems()).toEqual([]);

        const denied = call('sites', 't-example', { action: 'remove', site: 'site_example' });
        const item = await asked();
        expect(item.title).toMatch(/^atlas wants to remove a site: example\.gen \(.+\) — stopped and removed from this workspace’s project\.json; the folder and its files are not touched$/);
        services.approvals.resolve(item.id, 'deny');
        expect((await denied).isError).toBe(true);
        expect(services.sites.list()).toHaveLength(1);

        const allowed = call('sites', 't-example', { action: 'remove', site: 'example' });
        services.approvals.resolve((await asked()).id, 'allow');
        expect((await allowed).json).toMatchObject({ ok: true, removed: 'site_example' });
        expect(services.sites.list()).toEqual([]);
        const manifest = JSON.parse(await readFile(join(dir, 'example', 'project.json'), 'utf8')) as { sites?: Record<string, unknown> };
        expect(Object.keys(manifest.sites ?? {})).toHaveLength(0);
    });

    it('another workspace’s site is refused for start, stop and remove, without asking — the owner’s own stop is the control', async () => {
        await add('t-example', { name: 'example', devCommand: 'npm run dev -- --port {port}' });
        const refused = await Promise.all(['start', 'stop', 'remove'].map((action) => call('sites', 't-other', { action, site: 'site_example' })));
        expect(refused.map((r) => r.isError)).toEqual([true, true, true]);
        expect(services.approvals.deckItems()).toEqual([]);
        expect(services.sites.get('site_example')).toMatchObject({ state: 'running' });
        expect((await call('sites', 't-example', { action: 'stop', site: 'site_example' })).isError).toBe(false);
        expect(services.sites.get('site_example')).toMatchObject({ state: 'stopped' });
    });
});

describe('sites: status, restart, logs, open, detect, update (S6)', () => {
    const add = (terminalId: string, args: JsonObject) => call('sites', terminalId, { action: 'add', ...args });
    const say = (text: string) => { const ptyId = `term_${opened.findIndex((o) => o.command?.startsWith('npm run dev')) + 1}`; for (const l of dataListeners) l(ptyId, text); };

    it('status: the site and each of its processes as Genie sees them now', async () => {
        await add('t-example', { name: 'example', devCommand: 'npm run dev -- --port {port}' });
        const r = await call('sites', 't-example', { action: 'status', site: 'example.gen' });
        expect(r.isError).toBe(false);
        expect(r.json.site).toMatchObject({ id: 'site_example', host: 'example.gen', state: 'running' });
        expect((r.json.processes as Array<Record<string, unknown>>).map((p) => [p.id, p.name, p.state])).toEqual([['site_example', 'example.gen dev server', 'running']]);
    });

    it('restart: a new run at once, no approval; the site is running', async () => {
        await add('t-example', { name: 'example', devCommand: 'npm run dev -- --port {port}' });
        const runs = () => opened.filter((o) => o.command?.startsWith('npm run dev')).length;
        expect(runs()).toBe(1);
        const r = await call('sites', 't-example', { action: 'restart', site: 'example' });
        expect(r.json.site).toMatchObject({ state: 'running' });
        expect(runs()).toBe(2);
        expect(services.approvals.deckItems()).toEqual([]);
    });

    it('logs: the end of each process’s output, bounded by `lines`, still there after a stop', async () => {
        await add('t-example', { name: 'example', devCommand: 'npm run dev -- --port {port}' });
        say('compiled 1\ncompiled 2\nError: Cannot find module vite\n');
        await call('sites', 't-example', { action: 'stop', site: 'example' });
        const all = await call('sites', 't-example', { action: 'logs', site: 'example' });
        const p = (all.json.processes as Array<{ id: string; log: string; lines: number }>);
        expect(p.map((x) => x.id)).toEqual(['site_example']);
        expect(p[0]!.log).toContain('Error: Cannot find module vite');
        const two = await call('sites', 't-example', { action: 'logs', site: 'example', lines: 2 });
        expect((two.json.processes as Array<{ lines: number; log: string }>)[0]!.lines).toBe(2);
        expect((await call('sites', 't-example', { action: 'logs', site: 'example', lines: 0 })).json.error).toBe('`lines` is a positive number');
    });

    it('open: answers the URL and puts it in front of the person in Genie’s browser; a stopped site is refused and nothing is opened (control)', async () => {
        await add('t-example', { name: 'example', devCommand: 'npm run dev -- --port {port}' });
        const r = await call('sites', 't-example', { action: 'open', site: 'example' });
        expect(r.json).toMatchObject({ ok: true, url: 'https://example.gen/' });
        expect(shown).toEqual(['https://example.gen/']);
        await call('sites', 't-example', { action: 'stop', site: 'example' });
        const refused = await call('sites', 't-example', { action: 'open', site: 'example' });
        expect(refused.isError).toBe(true);
        expect(refused.json.error).toMatch(/not being served \(stopped\); start it first/);
        expect(shown).toHaveLength(1);
    });

    it('detect: what Genie would serve for a folder — Genie 1’s <folder>.<workspace> name — with NO side effect (nothing started, written, asked)', async () => {
        await mkdir(join(dir, 'example', 'repos', 'web', 'dist'), { recursive: true });
        await writeFile(join(dir, 'example', 'repos', 'web', 'dist', 'index.html'), '<!doctype html>', 'utf8');
        const fileBefore = await readFile(join(dir, 'example', 'project.json'), 'utf8');
        const r = await call('sites', 't-example', { action: 'detect', repoPath: 'repos/web' });
        expect(r.isError).toBe(false);
        expect(r.json.detected).toMatchObject({ name: 'web.example', mode: 'static', root: 'dist', spa: true });
        expect(r.json.host).toBe('web.example.gen');
        expect(opened).toEqual([]);
        expect(services.sites.list()).toEqual([]);
        expect(await readFile(join(dir, 'example', 'project.json'), 'utf8')).toBe(fileBefore);
        expect(services.approvals.deckItems()).toEqual([]);
    });

    it('detect and add refuse a folder OUTSIDE the workspace before reading it — another workspace’s folder included', async () => {
        for (const action of ['detect', 'add']) {
            const r = await call('sites', 't-example', { action, repoPath: '../example-other' });
            expect(r.isError).toBe(true);
            expect(r.json.error).toMatch(/outside this workspace/);
        }
        expect(services.sites.list()).toEqual([]);
    });

    it('update ASKS the person, naming every change; DENIED changes nothing — not project.json, not the running site', async () => {
        await add('t-example', { name: 'example', devCommand: 'npm run dev -- --port {port}' });
        const fileBefore = await readFile(join(dir, 'example', 'project.json'), 'utf8');
        const pending = call('sites', 't-example', { action: 'update', site: 'example', name: 'app.example', devCommand: 'npm start -- --port {port}' });
        const item = await asked();
        expect(item.title).toBe('atlas wants to change a site: example.gen — name example.gen → app.example.gen; command npm run dev -- --port {port} → npm start -- --port {port} — written to this workspace’s project.json and served as changed');
        services.approvals.resolve(item.id, 'deny');
        const r = await pending;
        expect(r.isError).toBe(true);
        expect(r.json.error).toMatch(/denied/);
        expect(await readFile(join(dir, 'example', 'project.json'), 'utf8')).toBe(fileBefore);
        expect(services.sites.list().map((x) => [x.host, x.state])).toEqual([['example.gen', 'running']]);
    });

    it('update ALLOWED: written to project.json under the same key and served under the new name', async () => {
        await add('t-example', { name: 'example', devCommand: 'npm run dev -- --port {port}' });
        const [key] = Object.keys((JSON.parse(await readFile(join(dir, 'example', 'project.json'), 'utf8')) as { sites: Record<string, unknown> }).sites);
        const pending = call('sites', 't-example', { action: 'update', site: 'example', name: 'app.example' });
        services.approvals.resolve((await asked()).id, 'allow');
        const r = await pending;
        expect(r.isError).toBe(false);
        expect(r.json.site).toMatchObject({ id: 'site_app.example', host: 'app.example.gen', state: 'running' });
        const kept = JSON.parse(await readFile(join(dir, 'example', 'project.json'), 'utf8')) as { sites: Record<string, Record<string, unknown>> };
        expect(Object.keys(kept.sites)).toEqual([key]);
        expect(kept.sites[key!]).toMatchObject({ name: 'app', genName: 'app.example.gen' });
    });

    it('update refused WITHOUT asking: an invalid name, a taken name, a static site with no root — the Edit form’s problems; and a change to nothing asks nothing', async () => {
        await add('t-example', { name: 'example', devCommand: 'npm run dev -- --port {port}' });
        await add('t-example', { name: 'docs', hostPort: 5174 });
        const refusals = [
            await call('sites', 't-example', { action: 'update', site: 'example', name: 'bad_name.example' }),
            await call('sites', 't-example', { action: 'update', site: 'example', name: 'docs' }),
            await call('sites', 't-example', { action: 'update', site: 'example', mode: 'static', root: '' }),
        ];
        expect(refusals.map((r) => (r.json.problems as Array<{ field: string }>).map((p) => p.field))).toEqual([['name'], ['name'], ['root']]);
        expect(refusals[1]!.json.error).toBe('docs.gen is already a site.');
        const same = await call('sites', 't-example', { action: 'update', site: 'example', name: 'example' });
        expect(same.json.note).toMatch(/nothing to change/);
        expect(services.approvals.deckItems()).toEqual([]);
    });

    it('SCOPED: another workspace’s site is "no site" for status, restart, logs, open, update — refused, nothing asked, run, opened or written; its own agent’s call is the control', async () => {
        await add('t-example', { name: 'example', devCommand: 'npm run dev -- --port {port}' });
        const runs = opened.length;
        const fileBefore = await readFile(join(dir, 'example', 'project.json'), 'utf8');
        const refused = await Promise.all(['status', 'restart', 'logs', 'open', 'update'].map((action) => call('sites', 't-other', { action, site: 'site_example', name: 'stolen' })));
        expect(refused.map((r) => [r.isError, /no site "site_example" in this workspace/.test(String(r.json.error))])).toEqual([[true, true], [true, true], [true, true], [true, true], [true, true]]);
        expect(opened.length).toBe(runs);
        expect(shown).toEqual([]);
        expect(services.approvals.deckItems()).toEqual([]);
        expect(await readFile(join(dir, 'example', 'project.json'), 'utf8')).toBe(fileBefore);
        // Control: the owner's agent reaches it.
        expect((await call('sites', 't-example', { action: 'status', site: 'site_example' })).isError).toBe(false);
    });

    it('the tool names every action, and an unknown one lists them', async () => {
        const def = tools.find((t) => t.definition.name === 'sites')!.definition;
        const schema = def.inputSchema as { properties: { action: { enum: string[] } } };
        expect(schema.properties.action.enum).toEqual(['list', 'status', 'detect', 'add', 'start', 'stop', 'restart', 'logs', 'open', 'update', 'remove']);
        const r = await call('sites', 't-example', { action: 'teleport' });
        expect(r.json.error).toBe('unknown action "teleport"; the actions are list, status, detect, add, start, stop, restart, logs, open, update, remove');
    });
});

describe('who is calling, and where', () => {
    it('nobody Genie knows is refused before anything is read', async () => {
        const r = await call('services', 't-nobody', { action: 'list' });
        expect(r.isError).toBe(true);
        expect(r.json.error).toMatch(/not one Genie knows/);
    });

    it('a Genie with no services (doctor mode) says so for both tools; the normal wiring reaches the composition (control)', async () => {
        const none = hostingTools({ resolveCaller: (id) => callers[id] ?? null, approve: async () => 'denied', services: null });
        for (const name of ['services', 'sites'] as const) {
            const r = await call(name, 't-example', { action: 'list' }, none);
            expect(r.isError).toBe(true);
            expect(r.json.error).toMatch(/no services or sites/);
        }
        const never = (() => { throw new Error('not exercised'); }) as never;
        const wired = allGenieTools(genieToolDeps({
            inbox: never, attention: never, knowledge: never, settings: never, approve: async () => 'denied', roster: () => [], resolveCaller: (id) => callers[id] ?? null,
            userActive: () => true, glow: () => false, thumbsUp: () => {}, openFile: never, terminals: never, hosting: services,
            sidecar: { register: never, start: never, running: () => false },
            plugins: { tools: () => [], guard: () => null, run: never },
        }));
        const r = await call('services', 't-example', { action: 'list' }, wired);
        expect(r.isError).toBe(false);
        expect(r.json.services).toEqual([]);
    });

    it('both tools tell an agent that Genie runs everything and never to use docker, and carry a title', () => {
        for (const t of tools) {
            expect(t.definition.description).toMatch(/GENIE runs/);
            expect(t.definition.description).toMatch(/never [^.]*`docker`/i);
            expect(typeof t.definition.title).toBe('string');
        }
        expect(tools.map((t) => t.definition.name)).toEqual(['services', 'sites']);
    });
});
