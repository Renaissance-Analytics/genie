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
const pty: PtyPort = {
    open: (o) => { opened.push({ command: o.command, env: o.env }); return { id: `term_${opened.length}`, pid: 1, shell: o.command ?? 'sh', scrollback: '' }; },
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
        if (cmd === 'stop') { containers.set(args[1]!, 'exited'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'rm') { containers.delete(args[2]!); return { stdout: '', exitCode: 0 }; }
        // An engine's own client inside its container (a shared engine's workspace slice): redis-cli prints the answer.
        if (cmd === 'exec') return { stdout: args.includes('PING') ? 'PONG\n' : args.includes('SETUSER') ? 'OK\n' : '', exitCode: 0 };
        return { stdout: '', exitCode: 0 };
    };
    return { run, calls, containers };
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
    tools = hostingTools({ resolveCaller: (id) => callers[id] ?? null, approve: (c, a, d) => services.approvals.gate(c, a, d), services });
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
        expect(engines.map((e) => e.engine)).toEqual(['postgres', 'mysql', 'mariadb', 'redis', 'mongo', 'reverb', 'mailpit']);
        expect(engines.find((e) => e.engine === 'postgres')).toMatchObject({ versions: ['14', '15', '16', '17'], scopes: ['dedicated', 'shared'] });
        expect(engines.find((e) => e.engine === 'postgres')!.images).toContain('postgres:17');
        expect(engines.find((e) => e.engine === 'mailpit')!.images).toEqual(['axllent/mailpit:v1.30']);
        expect(engines.find((e) => e.engine === 'reverb')!.scopes).toEqual(['shared']);
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

    it('a request Genie would refuse is refused WITHOUT asking: an unknown version, a dedicated Reverb, MinIO — counted, the deck empty', async () => {
        const refusals = [
            await call('services', 't-example', { action: 'add', engine: 'postgres', version: '12' }),
            await call('services', 't-example', { action: 'add', engine: 'reverb', version: '1', scope: 'dedicated' }),
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
            inbox: never, attention: never, knowledge: never, settings: never, feedback: never, approve: async () => 'denied', roster: () => [], resolveCaller: (id) => callers[id] ?? null,
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
