import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DockerRunner } from '../src/main/service-driver.js';
import { ServiceDriver } from '../src/main/service-driver.js';
import { ServiceRegistry } from '../src/main/service-registry.js';

/**
 * THE SERVICE REGISTRY (§6.6) — which engines each workspace holds, durable, driving the Docker
 * driver: adding an engine allocates a loopback port and credentials, needs consent before an image
 * is pulled, creates and starts the container; the ACTIVE version per engine is a choice with a
 * warning said BEFORE the switch; the env a workspace gets is `serviceEnvFor` over its instances;
 * status is read from Docker on every ask. A shared engine is one per workstation.
 */

function fakeDocker() {
    const calls: (readonly string[])[] = [];
    const images = new Set<string>();
    const containers = new Map<string, 'created' | 'running' | 'exited'>();
    const run: DockerRunner = async (args) => {
        calls.push(args);
        const [cmd, sub] = args;
        if (cmd === 'version') return { stdout: '28.1.0', exitCode: 0 };
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
        // An engine's own client inside its container: redis-cli prints the server's answer (it exits 0 either way).
        if (cmd === 'exec') return { stdout: args.includes('PING') ? 'PONG\n' : args.includes('SETUSER') ? 'OK\n' : '', exitCode: 0 };
        return { stdout: '', exitCode: 0 };
    };
    return { run, calls, images, containers };
}

let dir: string;
let docker: ReturnType<typeof fakeDocker>;
let registry: ServiceRegistry;
let nextPort = 54300;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-services-'));
    docker = fakeDocker();
    nextPort = 54300;
    registry = await ServiceRegistry.open(dir, new ServiceDriver(docker.run), { allocatePort: () => ++nextPort, randomPassword: () => 'pw1-generated' });
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('adding an engine', () => {
    it('without consent and without the image: nothing is created, the answer names the image to pull', async () => {
        const r = await registry.add({ engine: 'postgres', major: '17', scope: { kind: 'dedicated', workspaceId: 'tynn' }, consent: false });
        expect(r).toEqual({ kind: 'needs-consent', image: 'postgres:17', note: 'postgres:17 is not on this machine; pulling it downloads the image from Docker Hub.' });
        expect(registry.list('tynn')).toEqual([]);
        expect(docker.calls.some((c) => c[0] === 'create')).toBe(false);
    });

    it('with consent: pulls, allocates a loopback port and credentials, creates and starts the container, and remembers the instance durably', async () => {
        const r = await registry.add({ engine: 'postgres', major: '17', scope: { kind: 'dedicated', workspaceId: 'tynn' }, consent: true });
        expect(r).toMatchObject({ kind: 'added', instance: { engine: 'postgres', version: '17', publishedPort: 54301, credentials: { user: 'genie', password: 'pw1-generated', database: 'tynn' }, active: true } });
        expect(docker.containers.get('genie-tynn-postgres-17')).toBe('running');
        const reopened = await ServiceRegistry.open(dir, new ServiceDriver(docker.run), { allocatePort: () => 0, randomPassword: () => 'x' });
        expect(reopened.list('tynn').map((i) => [i.engine, i.version, i.publishedPort])).toEqual([['postgres', '17', 54301]]);
    });

    it('the FIRST version of an engine in a workspace is active; a second is not, until chosen — with the data-visibility warning returned BEFORE the switch', async () => {
        await registry.add({ engine: 'postgres', major: '16', scope: { kind: 'dedicated', workspaceId: 'tynn' }, consent: true });
        const second = await registry.add({ engine: 'postgres', major: '17', scope: { kind: 'dedicated', workspaceId: 'tynn' }, consent: true });
        expect(second).toMatchObject({ kind: 'added', instance: { version: '17', active: false } });
        expect(registry.switchWarning('tynn', 'postgres', '17')).toBe('Switching postgres from 16 to 17: each version keeps its own data volume, so 17 starts EMPTY. Nothing in 16 is deleted; switch back any time.');
        await registry.setActive('tynn', 'postgres', '17');
        expect(registry.list('tynn').map((i) => [i.version, i.active])).toEqual([['16', false], ['17', true]]);
        expect(registry.envFor('tynn').PGPORT).toBe('54302');
    });

    it('a shared engine is ONE per workstation: adding it twice answers the existing instance; reverb cannot be dedicated', async () => {
        const a = await registry.add({ engine: 'redis', major: '7', scope: { kind: 'shared' }, consent: true });
        const b = await registry.add({ engine: 'redis', major: '7', scope: { kind: 'shared' }, consent: true });
        expect(b).toMatchObject({ kind: 'exists', instance: { id: (a as { instance: { id: string } }).instance.id } });
        await expect(registry.add({ engine: 'reverb', major: '1', scope: { kind: 'dedicated', workspaceId: 'tynn' }, consent: true })).rejects.toThrow(/shared/);
    });
});

describe('env and status', () => {
    it('a workspace’s env covers its own engines AND the shared ones it USES, in host form — its own Redis user on the shared engine', async () => {
        // H3: a shared Redis is multi-tenant. The workspace that adds it gets its own ACL user; one that has not
        // used it gets nothing from it (it used to get the one unauthenticated URL every workspace shared).
        await registry.add({ engine: 'postgres', major: '17', scope: { kind: 'dedicated', workspaceId: 'tynn' }, consent: true });
        await registry.add({ engine: 'redis', major: '7', scope: { kind: 'shared' }, consent: true, workspaceId: 'tynn' });
        const env = registry.envFor('tynn');
        expect(env.DB_PORT).toBe('54301');
        expect(env.REDIS_URL).toBe('redis://ws_tynn:pw1-generated@127.0.0.1:54302');
        expect(env.REDIS_USERNAME).toBe('ws_tynn');
        expect(registry.envFor('fancy').REDIS_URL).toBeUndefined();
        expect(registry.envFor('fancy').DB_PORT).toBeUndefined();
        await registry.add({ engine: 'redis', major: '7', scope: { kind: 'shared' }, consent: true, workspaceId: 'fancy' });
        expect(registry.envFor('fancy').REDIS_URL).toBe('redis://ws_fancy:pw1-generated@127.0.0.1:54302');
    });

    it('status is read from Docker on every ask; stop and start go through the driver; remove keeps data unless asked', async () => {
        const r = await registry.add({ engine: 'postgres', major: '17', scope: { kind: 'dedicated', workspaceId: 'tynn' }, consent: true });
        const id = (r as { instance: { id: string } }).instance.id;
        expect(await registry.status(id)).toEqual({ state: 'running', since: 't' });
        await registry.stop(id);
        expect(await registry.status(id)).toEqual({ state: 'exited' });
        await registry.start(id);
        expect(await registry.status(id)).toEqual({ state: 'running', since: 't' });
        await registry.remove(id, { deleteData: false });
        expect(registry.list('tynn')).toEqual([]);
        expect(docker.calls.some((c) => c[0] === 'volume')).toBe(false);
    });
});
