import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { featureSnapshot, handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * SERVICE ENGINES THROUGH THE FEATURE IPC — the Services tab's main-side half. The registry is
 * composed with the other services (Docker is an injected runner here); adding an engine opens a
 * form, a submit without the image on the machine comes back asking for CONSENT with the image
 * named and nothing created, a consented submit creates and starts it, and the snapshot carries
 * every instance with its status read from Docker. Stop, start, make-active and remove go through.
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
    // The daemon: when it is down, every command answers what the real CLI answers then.
    const daemon = { down: false };
    const run: DockerRunner = async (args) => {
        calls.push(args);
        if (daemon.down) return { stdout: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', exitCode: 1 };
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
        return { stdout: '', exitCode: 0 };
    };
    return { run, calls, images, containers, daemon };
}

let dir: string;
let docker: ReturnType<typeof fakeDocker>;
let services: ComposedServices;
const state = (over: Partial<FeatureState> = {}): FeatureState => ({ toolStatuses: null, knowledgeQuery: '', ...over });
const form = { workspaceId: 'tynn', engine: 'postgres', major: '17', scope: 'dedicated' as const };
// Genie's boot over the same userData and the same (fake) Docker — what a restart is. The readiness probe and the
// port probe are fakes that COUNT; everything else is the real composition.
const answered: string[] = [];
const boot = (over: Partial<Parameters<typeof composeServices>[0]> = {}) =>
    composeServices({
        userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker: docker.run,
        workspaces: () => [{ id: 'tynn', path: join(dir, 'tynn') }, { id: 'fancy', path: join(dir, 'fancy') }],
        portFree: async () => true,
        engineAnswers: async (i) => { answered.push(`${i.engine} ${i.version}`); return true; },
        ...over,
    });
const restart = async (over: Partial<Parameters<typeof composeServices>[0]> = {}) => {
    await services.shutdown();
    services = await boot(over);
    return services;
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-ipc-services-'));
    docker = fakeDocker();
    opened.length = 0;
    answered.length = 0;
    // Two registered envelopes; a site created from Hosting is kept in its workspace's project.json.
    for (const ws of ['tynn', 'fancy']) {
        await mkdir(join(dir, ws), { recursive: true });
        await writeFile(join(dir, ws, 'project.json'), `${JSON.stringify({ name: ws, repos: [] }, null, 2)}\n`, 'utf8');
    }
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker: docker.run, workspaces: () => [{ id: 'tynn', path: join(dir, 'tynn') }, { id: 'fancy', path: join(dir, 'fancy') }] });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('the snapshot', () => {
    it('has a services section, MEASURED empty before anything is added (not null), with no form open', async () => {
        const snap = await featureSnapshot(services, state());
        expect(snap.services).toEqual({ instances: [], adding: null });
    });
});

describe('adding an engine', () => {
    it('services.add opens the form with the defaults for that workspace; cancel closes it', async () => {
        const open = await handleFeatureAction(services, { kind: 'services.add', workspaceId: 'tynn' }, state());
        expect(open.services!.adding).toEqual({ workspaceId: 'tynn', defaults: form, problems: [], consent: null });
        const closed = await handleFeatureAction(services, { kind: 'services.cancelForm' }, state({ serviceAdding: open.services!.adding }));
        expect(closed.services!.adding).toBeNull();
    });

    it('a submit with a problem keeps the form open with the problem beside its field; nothing is created', async () => {
        const snap = await handleFeatureAction(services, { kind: 'services.create', form: { ...form, major: '12' }, consent: false }, state());
        expect(snap.services!.adding).toMatchObject({ workspaceId: 'tynn', problems: [{ field: 'major', message: 'postgres 12 is not a version Genie knows (14, 15, 16, 17).' }], consent: null });
        expect(snap.services!.instances).toEqual([]);
        expect(docker.calls.some((c) => c[0] === 'create' || c[0] === 'pull')).toBe(false);
    });

    it('without the image on the machine and no consent: the form stays open ASKING, with the image named; nothing is pulled or created', async () => {
        const snap = await handleFeatureAction(services, { kind: 'services.create', form, consent: false }, state());
        expect(snap.services!.adding).toEqual({
            workspaceId: 'tynn',
            defaults: form,
            problems: [],
            consent: { image: 'postgres:17', note: 'postgres:17 is not on this machine; pulling it downloads the image from Docker Hub.', form },
        });
        expect(snap.services!.instances).toEqual([]);
        expect(docker.calls.some((c) => c[0] === 'create' || c[0] === 'pull')).toBe(false);
    });

    it('with consent: pulled, created, started; the form closes; the snapshot shows the instance RUNNING on a loopback port, and the workspace env carries it', async () => {
        const snap = await handleFeatureAction(services, { kind: 'services.create', form, consent: true }, state());
        expect(snap.services!.adding).toBeNull();
        expect(snap.services!.instances).toHaveLength(1);
        const [v] = snap.services!.instances;
        expect(v).toMatchObject({ status: 'running', instance: { engine: 'postgres', version: '17', scope: { kind: 'dedicated', workspaceId: 'tynn' }, active: true } });
        expect(v!.instance.publishedPort).toBeGreaterThan(0);
        expect(docker.calls.some((c) => c[0] === 'pull' && c[1] === 'postgres:17')).toBe(true);
        expect(services.engines.envFor('tynn').DB_PORT).toBe(String(v!.instance.publishedPort));
        // The site allocator and the engine allocator are ONE: no two things on the same loopback port.
        const site = services.sites.create({ name: 'tynn', workspaceId: 'tynn', repoPath: '/w/tynn', serve: { mode: 'proxy' }, devServer: { stack: 'node', command: 'npm run dev -- --port {port}' } });
        expect(site.port).not.toBe(v!.instance.publishedPort);
    });
});

describe('the env a workspace gets', () => {
    it('a site created from the Hosting surface runs its dev server WITH the workspace’s service env; a workspace with no engines gets none', async () => {
        const added = await handleFeatureAction(services, { kind: 'services.create', form, consent: true }, state());
        const port = added.services!.instances[0]!.instance.publishedPort;
        const site = { name: 'tynn', mode: 'proxy' as const, devServer: { stack: 'node' as const, command: 'npm run dev -- --port {port}' }, hostPort: null, root: null, spa: false };
        await handleFeatureAction(services, { kind: 'hosting.createSite', workspaceId: 'tynn', repoPath: join(dir, 'tynn'), form: site }, state());
        const dev = opened.find((o) => o.command?.startsWith('npm run dev'));
        expect(dev?.env).toMatchObject({ DB_PORT: String(port), PGPORT: String(port), DB_DATABASE: 'tynn', DB_USERNAME: 'genie' });
        expect(dev?.env?.DB_PASSWORD).toMatch(/.+/);

        await handleFeatureAction(services, { kind: 'hosting.createSite', workspaceId: 'fancy', repoPath: join(dir, 'fancy'), form: { ...site, name: 'fancy' } }, state());
        const other = opened.filter((o) => o.command?.startsWith('npm run dev')).at(-1);
        // Positive control above; here the ABSENCE is the claim: no engines, no service env.
        expect(other?.env ?? {}).not.toHaveProperty('DB_PORT');
    });
});

describe('an engine that exists', () => {
    it('stop, start, make-active and remove go through the driver; status is read from Docker on every snapshot', async () => {
        const added = await handleFeatureAction(services, { kind: 'services.create', form, consent: true }, state());
        const id = added.services!.instances[0]!.instance.id;
        expect((await handleFeatureAction(services, { kind: 'services.stop', serviceId: id }, state())).services!.instances[0]!.status).toBe('exited');
        expect((await handleFeatureAction(services, { kind: 'services.start', serviceId: id }, state())).services!.instances[0]!.status).toBe('running');

        const second = await handleFeatureAction(services, { kind: 'services.create', form: { ...form, major: '16' }, consent: true }, state());
        expect(second.services!.instances.map((v) => [v.instance.version, v.instance.active])).toEqual([['17', true], ['16', false]]);
        const switched = await handleFeatureAction(services, { kind: 'services.setActive', workspaceId: 'tynn', engine: 'postgres', version: '16' }, state());
        expect(switched.services!.instances.map((v) => [v.instance.version, v.instance.active])).toEqual([['17', false], ['16', true]]);

        const removed = await handleFeatureAction(services, { kind: 'services.remove', serviceId: id, deleteData: false }, state());
        expect(removed.services!.instances.map((v) => v.instance.version)).toEqual(['16']);
        expect(docker.calls.some((c) => c[0] === 'volume')).toBe(false);
        await expect(handleFeatureAction(services, { kind: 'services.stop', serviceId: id }, state())).rejects.toThrow(/no service/);
    });
});

describe('after a restart', () => {
    const redis = { workspaceId: 'tynn', engine: 'redis', major: '7', scope: 'dedicated' as const };

    it('a registered engine that is not running is STARTED and waited for; one the PERSON stopped stays stopped — counted', async () => {
        await restart();
        await handleFeatureAction(services, { kind: 'services.create', form, consent: true }, state());
        const added = await handleFeatureAction(services, { kind: 'services.create', form: redis, consent: true }, state());
        const redisId = added.services!.instances.find((v) => v.instance.engine === 'redis')!.instance.id;
        await handleFeatureAction(services, { kind: 'services.stop', serviceId: redisId }, state());
        await services.shutdown();
        // The machine restarted: Docker is back, the containers are not running.
        for (const name of docker.containers.keys()) docker.containers.set(name, 'exited');
        const mark = docker.calls.length;
        services = await boot();
        const report = await services.engineReconcile;
        expect(docker.calls.slice(mark).filter((c) => c[0] === 'start').map((c) => c.join(' '))).toEqual(['start genie-tynn-postgres-17']);
        expect(answered).toEqual(['postgres 17']);
        expect(report.engines.map((e) => e.outcome)).toEqual(['started', 'person-stopped']);
        const snap = await featureSnapshot(services, state());
        expect(snap.services!.instances.map((v) => [v.instance.engine, v.status])).toEqual([['postgres', 'running'], ['redis', 'exited']]);
        // The person's Start clears the stop: the NEXT restart starts it too.
        await handleFeatureAction(services, { kind: 'services.start', serviceId: redisId }, state());
        for (const name of docker.containers.keys()) docker.containers.set(name, 'exited');
        const mark2 = docker.calls.length;
        await restart();
        await services.engineReconcile;
        expect(docker.calls.slice(mark2).filter((c) => c[0] === 'start').map((c) => c.join(' ')).sort()).toEqual(['start genie-tynn-postgres-17', 'start genie-tynn-redis-7']);
    });

    it('with Docker NOT running every engine SAYS so — never `absent` — and nothing is started; positive control: Docker back up reads the real state', async () => {
        await restart();
        await handleFeatureAction(services, { kind: 'services.create', form, consent: true }, state());
        await services.shutdown();
        docker.daemon.down = true;
        const mark = docker.calls.length;
        services = await boot();
        const snap = await featureSnapshot(services, state());
        expect(snap.services!.instances.map((v) => v.status)).toEqual(['docker-not-running']);
        expect(snap.services!.instances[0]!.note).toBe('Docker is installed but its daemon is not running; start Docker Desktop (or dockerd) and try again');
        const report = await services.engineReconcile;
        expect(report.docker).toEqual({ ok: false, reason: 'Docker is installed but its daemon is not running; start Docker Desktop (or dockerd) and try again' });
        expect(report.engines.map((e) => e.outcome)).toEqual(['docker-not-running']);
        expect(docker.calls.slice(mark).filter((c) => c[0] === 'start')).toHaveLength(0);
        docker.daemon.down = false;
        const back = await featureSnapshot(services, state());
        expect(back.services!.instances.map((v) => v.status)).toEqual(['running']);
        expect(back.services!.instances[0]).not.toHaveProperty('note');
    });

    it('a site created after a restart never lands on an engine’s RECORDED port (the old allocator counted from 4100 again)', async () => {
        await restart();
        const added = await handleFeatureAction(services, { kind: 'services.create', form, consent: true }, state());
        const enginePort = added.services!.instances[0]!.instance.publishedPort;
        await restart();
        expect(services.engines.list()[0]!.publishedPort).toBe(enginePort);
        const sites = [1, 2, 3].map((n) => services.sites.create({ name: `site${n}`, workspaceId: 'tynn', repoPath: '/w/tynn', serve: { mode: 'proxy' }, devServer: { stack: 'node', command: 'npm run dev -- --port {port}' } }).port);
        expect(sites).not.toContain(enginePort);
        expect(new Set(sites).size).toBe(3);
    });

    it('a port something else on the machine holds is not handed to a site (the bind probe says busy) — with the free one as control', async () => {
        await restart({ portFree: async (port) => port !== 4101 });
        const site = services.sites.create({ name: 'busy', workspaceId: 'tynn', repoPath: '/w/tynn', serve: { mode: 'proxy' }, devServer: { stack: 'node', command: 'npm run dev -- --port {port}' } });
        expect(site.port).toBe(4102);
        await restart();
        const control = services.sites.create({ name: 'free', workspaceId: 'tynn', repoPath: '/w/tynn', serve: { mode: 'proxy' }, devServer: { stack: 'node', command: 'npm run dev -- --port {port}' } });
        expect(control.port).toBe(4101);
    });
});
