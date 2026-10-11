import { describe, expect, it } from 'vitest';
import { ServiceDriver, type DockerRunner } from '../src/main/service-driver.js';

/**
 * SERVICE ENGINES — the Docker driver (§6.6). Everything goes through an injected runner, so the tests
 * count the exact `docker` invocations instead of running any. Pulls happen only with CONSENT (an
 * image is a download the person should know about); a container is created from `containerPlan`
 * with loopback-only publishing and an engine-keyed name and volume; status is read from `docker
 * inspect`, never remembered; a missing Docker is a named refusal, not a crash.
 */

function fakeDocker(table: Record<string, { stdout: string; exitCode: number }> = {}) {
    const calls: (readonly string[])[] = [];
    const run: DockerRunner = async (args) => {
        calls.push(args);
        const key = args.slice(0, 2).join(' ');
        return table[key] ?? table[args[0]!] ?? { stdout: '', exitCode: 0 };
    };
    return { run, calls };
}

const pg = { engine: 'postgres', major: '17', scope: { kind: 'dedicated' as const, workspaceId: 'tynn' }, publishedPort: 54321, credentials: { user: 'genie', password: 'pw', database: 'tynn' } };

describe('availability', () => {
    it('reports Docker available with its version, or a named refusal when the CLI is missing or the daemon is down', async () => {
        const up = fakeDocker({ 'version --format': { stdout: '28.1.0\n', exitCode: 0 } });
        expect(await new ServiceDriver(up.run).available()).toEqual({ ok: true, version: '28.1.0' });
        const noDaemon = fakeDocker({ 'version --format': { stdout: 'Cannot connect to the Docker daemon', exitCode: 1 } });
        expect(await new ServiceDriver(noDaemon.run).available()).toEqual({ ok: false, reason: 'Docker is installed but its daemon is not running; start Docker Desktop (or dockerd) and try again' });
        const missing: DockerRunner = async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
        expect(await new ServiceDriver(missing).available()).toEqual({ ok: false, reason: 'Docker is not installed on this machine; service engines need it' });
    });
});

describe('pulling with consent', () => {
    it('pulls only when the image is absent AND consent is given; an absent image without consent is a `needs-consent` answer naming the image', async () => {
        const absent = fakeDocker({ 'image inspect': { stdout: '', exitCode: 1 } });
        const d = new ServiceDriver(absent.run);
        expect(await d.ensureImage('postgres:17', { consent: false })).toEqual({ kind: 'needs-consent', image: 'postgres:17', note: 'postgres:17 is not on this machine; pulling it downloads the image from Docker Hub.' });
        expect(absent.calls.some((c) => c[0] === 'pull')).toBe(false);
        expect(await d.ensureImage('postgres:17', { consent: true })).toEqual({ kind: 'pulled', image: 'postgres:17' });
        expect(absent.calls.at(-1)).toEqual(['pull', 'postgres:17']);
    });

    it('an image already present is `present`, with no pull — COUNTED', async () => {
        const present = fakeDocker({ 'image inspect': { stdout: '[{}]', exitCode: 0 } });
        const d = new ServiceDriver(present.run);
        expect(await d.ensureImage('postgres:17', { consent: false })).toEqual({ kind: 'present', image: 'postgres:17' });
        expect(present.calls.filter((c) => c[0] === 'pull')).toHaveLength(0);
    });
});

describe('create, start, stop, status', () => {
    it('creates the container from the plan: loopback publish, engine-keyed name and volume, the credential env, restart unless-stopped', async () => {
        const docker = fakeDocker({ 'container inspect': { stdout: '', exitCode: 1 } });
        const d = new ServiceDriver(docker.run);
        const r = await d.create(pg);
        expect(r).toEqual({ ok: true, name: 'genie-tynn-postgres-17' });
        const create = docker.calls.find((c) => c[0] === 'create')!;
        expect(create).toEqual(['create', '--name', 'genie-tynn-postgres-17', '-p', '127.0.0.1:54321:5432', '-v', 'genie-tynn-postgres-17-data:/var/lib/postgresql/data', '--restart', 'unless-stopped', '-e', 'POSTGRES_USER=genie', '-e', 'POSTGRES_PASSWORD=pw', '-e', 'POSTGRES_DB=tynn', 'postgres:17']);
    });

    it('a container that already exists is not created twice', async () => {
        const docker = fakeDocker({ 'container inspect': { stdout: '[{"State":{"Status":"exited"}}]', exitCode: 0 } });
        const d = new ServiceDriver(docker.run);
        expect(await d.create(pg)).toEqual({ ok: true, name: 'genie-tynn-postgres-17', existed: true });
        expect(docker.calls.filter((c) => c[0] === 'create')).toHaveLength(0);
    });

    it('start / stop call docker by name; status is READ from inspect — running, exited, or absent', async () => {
        const docker = fakeDocker({ 'container inspect': { stdout: '[{"State":{"Status":"running","StartedAt":"2026-10-11T05:00:00Z"}}]', exitCode: 0 } });
        const d = new ServiceDriver(docker.run);
        await d.start('genie-tynn-postgres-17');
        await d.stop('genie-tynn-postgres-17');
        expect(docker.calls.filter((c) => c[0] === 'start' || c[0] === 'stop').map((c) => c.join(' '))).toEqual(['start genie-tynn-postgres-17', 'stop genie-tynn-postgres-17']);
        expect(await d.status('genie-tynn-postgres-17')).toEqual({ state: 'running', since: '2026-10-11T05:00:00Z' });
        const gone = fakeDocker({ 'container inspect': { stdout: 'Error: No such container', exitCode: 1 } });
        expect(await new ServiceDriver(gone.run).status('x')).toEqual({ state: 'absent' });
    });

    it('a docker command that fails is reported with docker’s own words, never swallowed', async () => {
        const docker = fakeDocker({ 'container inspect': { stdout: '', exitCode: 1 }, create: { stdout: 'docker: Error response from daemon: port is already allocated.', exitCode: 125 } });
        const r = await new ServiceDriver(docker.run).create(pg);
        expect(r).toEqual({ ok: false, reason: 'docker: Error response from daemon: port is already allocated.' });
    });
});

describe('volumes', () => {
    it('remove keeps the data volume unless asked to delete it — switching versions never destroys data', async () => {
        const docker = fakeDocker();
        const d = new ServiceDriver(docker.run);
        await d.remove('genie-tynn-postgres-17', { deleteData: false });
        expect(docker.calls.map((c) => c.join(' '))).toEqual(['rm -f genie-tynn-postgres-17']);
        await d.remove('genie-tynn-postgres-17', { deleteData: true });
        expect(docker.calls.at(-1)).toEqual(['volume', 'rm', 'genie-tynn-postgres-17-data']);
    });
});
