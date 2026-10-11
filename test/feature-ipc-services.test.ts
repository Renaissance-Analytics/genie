import { mkdtemp, rm } from 'node:fs/promises';
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

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
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
        return { stdout: '', exitCode: 0 };
    };
    return { run, calls, images, containers };
}

let dir: string;
let docker: ReturnType<typeof fakeDocker>;
let services: ComposedServices;
const state = (over: Partial<FeatureState> = {}): FeatureState => ({ toolStatuses: null, knowledgeQuery: '', ...over });
const form = { workspaceId: 'tynn', engine: 'postgres', major: '17', scope: 'dedicated' as const };

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-ipc-services-'));
    docker = fakeDocker();
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker: docker.run });
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
