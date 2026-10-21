import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DockerRunner } from '../src/main/service-driver.js';
import { ServiceDriver } from '../src/main/service-driver.js';
import { ServiceRegistry } from '../src/main/service-registry.js';

/**
 * AN ENGINE IS NEVER RE-KEYED (hosting fixes 3.1). A container Genie made holds the password and port it was made
 * with; a record saying anything else is a workspace that cannot connect ("password authentication failed").
 *
 * - `create` found the container already there and said so (`existed`), and `add` recorded a NEW password and port
 *   over it anyway. Now: the container is read back — what it was made with is compared to what Genie would make — and
 *   it is adopted only when they agree; otherwise refused in words, naming what differs and never a secret.
 * - `remove` never read Docker's answer, so a failed `docker rm` dropped the record and left the container: the state
 *   above. Now a removal Docker did not do keeps the record, in Docker's words. A container already gone is removed.
 * - Two adds at once both passed the "already there" check: one container, two records. Now one add per name at a time.
 *
 * Docker here is a fake that keeps what each container was created with (`-e`, `-p`) and answers `container inspect`
 * with it, as Docker does (`Config.Env`, `HostConfig.PortBindings`).
 */

interface Made { status: 'created' | 'running' | 'exited'; env: string[]; bindings: Record<string, { HostIp: string; HostPort: string }[]> }

function fakeDocker() {
    const calls: (readonly string[])[] = [];
    const images = new Set<string>(['postgres:17']);
    const containers = new Map<string, Made>();
    const volumes = new Set<string>();
    const fail = { rm: false, volumeRm: false };
    let createDelay = 0;
    const run: DockerRunner = async (args) => {
        calls.push(args);
        const [cmd, sub] = args;
        if (cmd === 'image' && sub === 'inspect') return { stdout: images.has(args[2]!) ? '[{}]' : '', exitCode: images.has(args[2]!) ? 0 : 1 };
        if (cmd === 'container' && sub === 'inspect') {
            const c = containers.get(args[2]!);
            return c ? { stdout: JSON.stringify([{ State: { Status: c.status, StartedAt: 't' }, Config: { Env: [...c.env, 'PATH=/usr/bin'] }, HostConfig: { PortBindings: c.bindings } }]), exitCode: 0 } : { stdout: '', exitCode: 1 };
        }
        if (cmd === 'volume' && sub === 'inspect') return { stdout: volumes.has(args[2]!) ? '[{}]' : '', exitCode: volumes.has(args[2]!) ? 0 : 1 };
        if (cmd === 'create') {
            if (createDelay > 0) await new Promise((r) => setTimeout(r, createDelay));
            const name = args[args.indexOf('--name') + 1]!;
            const env: string[] = [];
            const bindings: Made['bindings'] = {};
            args.forEach((a, i) => {
                if (a === '-e') env.push(args[i + 1]!);
                if (a === '-p') { const [ip, host, inner] = args[i + 1]!.split(':'); (bindings[`${inner}/tcp`] ??= []).push({ HostIp: ip!, HostPort: host! }); }
                if (a === '-v') volumes.add(args[i + 1]!.split(':')[0]!);
            });
            containers.set(name, { status: 'created', env, bindings });
            return { stdout: '', exitCode: 0 };
        }
        if (cmd === 'start') { const c = containers.get(args[1]!); if (c) c.status = 'running'; return { stdout: '', exitCode: 0 }; }
        if (cmd === 'rm') {
            const name = args[2]!;
            if (!containers.has(name)) return { stdout: `Error response from daemon: No such container: ${name}`, exitCode: 1 };
            if (fail.rm) return { stdout: `Error response from daemon: cannot remove container "/${name}": could not kill: permission denied`, exitCode: 1 };
            containers.delete(name);
            return { stdout: '', exitCode: 0 };
        }
        if (cmd === 'volume' && sub === 'rm') {
            if (fail.volumeRm) return { stdout: `Error response from daemon: remove ${args[2]}: volume is in use`, exitCode: 1 };
            volumes.delete(args[2]!);
            return { stdout: '', exitCode: 0 };
        }
        return { stdout: '', exitCode: 0 };
    };
    return { run, calls, containers, volumes, fail, slowCreate: (ms: number) => { createDelay = ms; } };
}

const DEDICATED = { kind: 'dedicated' as const, workspaceId: 'tynn' };
let dirs: string[] = [];
let docker: ReturnType<typeof fakeDocker>;

/** A registry over the SAME Docker: `fresh` = its own empty record, as a lost or edited services.json leaves it. */
async function registry(opts: { port: number; password: string }) {
    const dir = await mkdtemp(join(tmpdir(), 'genie2-rekey-'));
    dirs.push(dir);
    return ServiceRegistry.open(dir, new ServiceDriver(docker.run), { allocatePort: () => opts.port, randomPassword: () => opts.password });
}

beforeEach(() => { docker = fakeDocker(); dirs = []; });
afterEach(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const creates = () => docker.calls.filter((c) => c[0] === 'create').length;

describe('a container already there is adopted only as it is', () => {
    it('made with other credentials and port: REFUSED in words naming what differs — no secret, nothing recorded, not re-made', async () => {
        const first = await registry({ port: 54301, password: 'pw-original' });
        await first.add({ engine: 'postgres', major: '17', scope: DEDICATED, consent: true });
        expect(creates()).toBe(1);

        // The record is gone (another services.json), the container is not: Genie would now make it with new values.
        const second = await registry({ port: 54999, password: 'pw-new' });
        const err = await second.add({ engine: 'postgres', major: '17', scope: DEDICATED, consent: true }).then(() => null, (e: Error) => e.message);
        expect(err).not.toBeNull();
        expect(err).toMatch(/already/i);
        expect(err).toMatch(/54301/);
        expect(err).toMatch(/POSTGRES_PASSWORD/);
        expect(err).not.toMatch(/pw-original|pw-new/);
        expect(second.list('tynn')).toEqual([]);
        expect(creates()).toBe(1);
    });

    it('CONTROL: made with exactly what Genie would make: adopted — recorded with the container’s own port and credentials', async () => {
        const first = await registry({ port: 54301, password: 'pw-original' });
        await first.add({ engine: 'postgres', major: '17', scope: DEDICATED, consent: true });
        const again = await registry({ port: 54301, password: 'pw-original' });
        const r = await again.add({ engine: 'postgres', major: '17', scope: DEDICATED, consent: true });
        expect(r.kind).toBe('added');
        expect(again.list('tynn').map((i) => [i.publishedPort, i.credentials.password])).toEqual([[54301, 'pw-original']]);
        expect(creates()).toBe(1);
    });
});

describe('a removal Docker did not do keeps the record', () => {
    it('`docker rm` refused: the remove fails in Docker’s words, the engine is still listed, and adding it again is “exists”', async () => {
        const reg = await registry({ port: 54301, password: 'pw-original' });
        const added = await reg.add({ engine: 'postgres', major: '17', scope: DEDICATED, consent: true });
        const id = (added as { instance: { id: string } }).instance.id;
        docker.fail.rm = true;
        const err = await reg.remove(id, { deleteData: false }).then(() => null, (e: Error) => e.message);
        expect(err).toMatch(/permission denied/);
        expect(reg.list('tynn').map((i) => i.id)).toEqual([id]);
        expect((await reg.add({ engine: 'postgres', major: '17', scope: DEDICATED, consent: true })).kind).toBe('exists');
    });

    it('the data volume in use: a delete-data remove fails in Docker’s words and keeps the record', async () => {
        const reg = await registry({ port: 54301, password: 'pw-original' });
        const added = await reg.add({ engine: 'postgres', major: '17', scope: DEDICATED, consent: true });
        const id = (added as { instance: { id: string } }).instance.id;
        docker.fail.volumeRm = true;
        const err = await reg.remove(id, { deleteData: true, workspaceId: 'tynn' }).then(() => null, (e: Error) => e.message);
        expect(err).toMatch(/volume is in use/);
        expect(reg.list('tynn').map((i) => i.id)).toEqual([id]);
    });

    it('CONTROL: a container already gone (`No such container`) is removed — the record goes, as before', async () => {
        const reg = await registry({ port: 54301, password: 'pw-original' });
        const added = await reg.add({ engine: 'postgres', major: '17', scope: DEDICATED, consent: true });
        const id = (added as { instance: { id: string } }).instance.id;
        docker.containers.clear();
        await reg.remove(id, { deleteData: false });
        expect(reg.list('tynn')).toEqual([]);
    });
});

describe('two adds of the same engine at once', () => {
    it('make ONE container and ONE record; the second is answered “exists” (counted)', async () => {
        const reg = await registry({ port: 54301, password: 'pw-original' });
        docker.slowCreate(30);
        const [a, b] = await Promise.all([
            reg.add({ engine: 'postgres', major: '17', scope: DEDICATED, consent: true }),
            reg.add({ engine: 'postgres', major: '17', scope: DEDICATED, consent: true }),
        ]);
        expect([a.kind, b.kind].sort()).toEqual(['added', 'exists']);
        expect(creates()).toBe(1);
        expect(reg.list('tynn')).toHaveLength(1);
    });
});
