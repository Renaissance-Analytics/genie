import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateServiceForm } from '../src/core/forms.js';
import { provisionSteps } from '../src/core/service-provision.js';
import { containerPlan, parseEnvLines, type ServiceInstance } from '../src/core/services.js';
import { mergeTimestampedLogs, ServiceDriver, type DockerRunner } from '../src/main/service-driver.js';
import { execFileRunner } from '../src/main/toolchain-runner.js';
import { ServiceRegistry } from '../src/main/service-registry.js';

/**
 * HOSTING SHIP LINE H6 + H7 — Genie 1's service behaviour, ported.
 *
 * H6: an engine's own log (`docker logs --tail`, bounded); "delete data" REFUSED while any other workspace keeps data
 * in the engine, naming them, with nothing removed (Genie 1's tenancy.ts lesson: a purge from the only open workspace
 * once deleted every other workspace's database); Mailpit's web inbox published beside its SMTP, and each workspace's
 * mail tagged with its own name (Genie 1's MAIL_* env).
 * H7: Meilisearch (index prefix per workspace, Genie 1's names), SeaweedFS as the S3 engine (a bucket + access key per
 * workspace, fail-closed admin identity), and a custom image (the person's image, port and env).
 *
 * The fake Docker RECORDS every argv: what Genie asks Docker for is counted here; what the engines then do with it is
 * proven against real Docker in genie-test-ubuntu. Every name and value is invented (RFC 2606 `.example` for hosts).
 */

const A = 'example-a';
const B = 'example-b';
const SHARED = { kind: 'shared' } as const;
const CUSTOM_IMAGE = 'registry.example/acme/echo:1';

function fakeDocker(input: { absentImages?: readonly string[] } = {}) {
    const calls: (readonly string[])[] = [];
    const absent = new Set(input.absentImages ?? []);
    const containers = new Map<string, 'created' | 'running' | 'exited'>();
    const run: DockerRunner = async (args) => {
        calls.push(args);
        const [cmd, sub] = args;
        if (cmd === 'image' && sub === 'inspect') return absent.has(args[2]!) ? { stdout: '', exitCode: 1 } : { stdout: '[{}]', exitCode: 0 };
        if (cmd === 'pull') { absent.delete(args[1]!); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'container' && sub === 'inspect') {
            const st = containers.get(args[2]!);
            return st ? { stdout: JSON.stringify([{ State: { Status: st, StartedAt: 't' } }]), exitCode: 0 } : { stdout: '', exitCode: 1 };
        }
        if (cmd === 'create') { containers.set(args[2]!, 'created'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'start') { containers.set(args[1]!, 'running'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'stop') { containers.set(args[1]!, 'exited'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'rm') { containers.delete(args[2]!); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'logs') return { stdout: 'engine started\nready to accept connections\n', exitCode: 0 };
        if (cmd === 'exec') return { stdout: args.includes('PING') ? 'PONG\n' : args.includes('SETUSER') ? 'OK\n' : '', exitCode: 0 };
        return { stdout: '', exitCode: 0 };
    };
    const of = (verb: string) => calls.filter((c) => c[0] === verb);
    const execs = () => calls.filter((c) => c[0] === 'exec').map((c) => c.slice(2));
    /** The `-p` values of the create calls, in order. */
    const published = () => of('create').flatMap((c) => c.flatMap((a, i) => (c[i - 1] === '-p' ? [a] : [])));
    return { run, calls, containers, of, execs, published };
}

let dir: string;
let docker: ReturnType<typeof fakeDocker>;
let registry: ServiceRegistry;
let port: number;
let pw: number;

const open = async (d: ReturnType<typeof fakeDocker>) => {
    docker = d;
    registry = await ServiceRegistry.open(dir, new ServiceDriver(d.run), {
        allocatePort: () => ++port,
        // Distinct, generated-alphabet passwords, so "whose secret is this" is answerable.
        randomPassword: () => `genpw-${String(++pw).padStart(4, '0')}`,
        sliceReadiness: { timeoutMs: 5_000, pollMs: 500 },
        now: () => 0,
        sleep: async () => {},
    });
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-services-more-'));
    port = 4100;
    pw = 0;
    await open(fakeDocker());
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const added = async (input: Parameters<ServiceRegistry['add']>[0]): Promise<ServiceInstance> => {
    const r = await registry.add(input);
    if (r.kind === 'needs-consent') throw new Error(`unexpected consent question for ${r.image}`);
    return r.instance;
};
const find = (id: string): ServiceInstance => registry.list().find((i) => i.id === id)!;

describe('engine logs (H6)', () => {
    it('`docker logs --tail N` on the container — Genie 1’s default of 500, any tail bounded to 1–5000 — every argv counted', async () => {
        const d = fakeDocker();
        const driver = new ServiceDriver(d.run);
        const name = 'genie-example-a-postgres-17';
        expect(await driver.logs(name)).toEqual({ text: 'engine started\nready to accept connections\n', tail: 500 });
        for (const tail of [50, 100_000, 0, -3, Number.NaN, 12.7]) await driver.logs(name, tail);
        expect(d.of('logs')).toEqual([500, 50, 5000, 1, 1, 500, 12].map((n) => ['logs', '--timestamps', '--tail', String(n), name]));
    });

    it('BOTH of Docker’s streams, back in the order they were written — Postgres writes only to stderr, and its lines are all there (counted)', async () => {
        // Docker trims the fraction's trailing zeros, so `.1Z` is later than `.09Z` and earlier than `.12Z`: compared as numbers, not text.
        const out = '2026-10-15T01:00:00.09Z out one\n2026-10-15T01:00:00.12Z out two\n';
        const err = '2026-10-15T01:00:00.1Z err one\n  a continuation of err one\n2026-10-15T01:00:01Z err two\n';
        const both: DockerRunner = async () => ({ stdout: out, exitCode: 0, streams: { stdout: out, stderr: err } });
        expect((await new ServiceDriver(both).logs('genie-example-a-postgres-17')).text).toBe('out one\nerr one\n  a continuation of err one\nout two\nerr two\n');
        // stderr alone (Postgres): the runner's `stdout` falls back to it, and the streams carry it once — never twice.
        const pgOnly: DockerRunner = async () => ({ stdout: err, exitCode: 0, streams: { stdout: '', stderr: err } });
        expect((await new ServiceDriver(pgOnly).logs('genie-example-a-postgres-17')).text).toBe('err one\n  a continuation of err one\nerr two\n');
        expect(mergeTimestampedLogs('', '')).toBe('');
    });

    it('the production runner hands back both streams as written (control: `stdout` still falls back to stderr for callers that read one)', async () => {
        const r = await execFileRunner(process.execPath, ['-e', 'process.stdout.write("to-out\\n"); process.stderr.write("to-err\\n")']);
        expect(r.streams).toEqual({ stdout: 'to-out\n', stderr: 'to-err\n' });
        const errOnly = await execFileRunner(process.execPath, ['-e', 'process.stderr.write("only-err\\n")']);
        expect(errOnly).toMatchObject({ stdout: 'only-err\n', streams: { stdout: '', stderr: 'only-err\n' } });
    });

    it('a container Docker cannot read is an ERROR in Docker’s own words — never an empty log', async () => {
        const gone: DockerRunner = async () => ({ stdout: 'Error response from daemon: No such container: genie-example-a-redis-7', exitCode: 1 });
        await expect(new ServiceDriver(gone).logs('genie-example-a-redis-7')).rejects.toThrow('No such container: genie-example-a-redis-7');
    });

    it('the registry reads the engine’s OWN container, and nothing else is asked of Docker', async () => {
        const pg = await added({ engine: 'postgres', major: '17', scope: { kind: 'dedicated', workspaceId: A }, consent: true });
        const mark = docker.calls.length;
        expect(await registry.logs(pg.id, 20)).toEqual({ text: 'engine started\nready to accept connections\n', tail: 20 });
        expect(docker.calls.slice(mark)).toEqual([['logs', '--timestamps', '--tail', '20', 'genie-example-a-postgres-17']]);
    });
});

describe('delete data (H6): refused while ANOTHER workspace keeps data in the engine', () => {
    const rmAndVolume = (mark: number) => docker.calls.slice(mark).filter((c) => c[0] === 'rm' || c[0] === 'volume');

    it('a shared Postgres two workspaces use: deleting it as A is REFUSED naming B’s database — and nothing at all is removed', async () => {
        const pg = await added({ engine: 'postgres', major: '17', scope: SHARED, consent: true, workspaceId: A });
        await added({ engine: 'postgres', major: '17', scope: SHARED, consent: true, workspaceId: B });
        const mark = docker.calls.length;
        await expect(registry.remove(pg.id, { deleteData: true, workspaceId: A })).rejects.toThrow('ws_example_b (workspace example-b)');
        // Asked for by nobody in particular, every holder is "another" — both named.
        await expect(registry.remove(pg.id, { deleteData: true })).rejects.toThrow('ws_example_a (workspace example-a) and ws_example_b (workspace example-b)');
        expect(rmAndVolume(mark)).toEqual([]);
        expect(registry.list().map((i) => i.id)).toEqual([pg.id]);
    });

    it('control: the SOLE holder deletes — its container removed and ITS volume removed, once each', async () => {
        const pg = await added({ engine: 'postgres', major: '17', scope: SHARED, consent: true, workspaceId: A });
        const mark = docker.calls.length;
        await registry.remove(pg.id, { deleteData: true, workspaceId: A });
        expect(rmAndVolume(mark)).toEqual([['rm', '-f', 'genie-shared-postgres-17'], ['volume', 'rm', 'genie-shared-postgres-17-data']]);
        expect(registry.list()).toEqual([]);
    });

    it('a dedicated engine is its workspace’s: another workspace is refused (named), its own deletes', async () => {
        const pg = await added({ engine: 'postgres', major: '17', scope: { kind: 'dedicated', workspaceId: A }, consent: true });
        const mark = docker.calls.length;
        await expect(registry.remove(pg.id, { deleteData: true, workspaceId: B })).rejects.toThrow('example-a (workspace example-a)');
        expect(rmAndVolume(mark)).toEqual([]);
        await registry.remove(pg.id, { deleteData: true, workspaceId: A });
        expect(docker.calls.slice(mark).filter((c) => c[0] === 'volume')).toEqual([['volume', 'rm', 'genie-example-a-postgres-17-data']]);
    });

    it('a shared engine whose users Genie does not record (a shared Mailpit) is treated as IN USE: delete refused; removing it keeping its data works (control)', async () => {
        const mail = await added({ engine: 'mailpit', major: '1.30', scope: SHARED, consent: true, workspaceId: A });
        const mark = docker.calls.length;
        await expect(registry.remove(mail.id, { deleteData: true, workspaceId: A })).rejects.toThrow(/cannot tell whose data its volume genie-shared-mailpit-1\.30-data holds/);
        expect(rmAndVolume(mark)).toEqual([]);
        await registry.remove(mail.id, { deleteData: false });
        expect(rmAndVolume(mark)).toEqual([['rm', '-f', 'genie-shared-mailpit-1.30']]);
    });
});

describe('Mailpit (H6): its SMTP AND its web inbox, each workspace’s mail tagged', () => {
    it('the plan publishes BOTH ports, loopback only; a plan without the inbox’s port is refused, not quietly half-published', () => {
        const plan = containerPlan({ engine: 'mailpit', major: '1.30', scope: SHARED, publishedPort: 31025, surfacePorts: { ui: 38025 } });
        expect(plan.publish).toEqual(['127.0.0.1:31025:1025', '127.0.0.1:38025:8025']);
        expect(() => containerPlan({ engine: 'mailpit', major: '1.30', scope: SHARED, publishedPort: 31025 })).toThrow('ui (8025)');
    });

    it('added: two loopback ports allocated, the container created with both, the inbox port recorded; each workspace’s env carries ITS tag (Genie 1’s names)', async () => {
        const mail = await added({ engine: 'mailpit', major: '1.30', scope: SHARED, consent: true, workspaceId: A });
        expect(docker.published()).toEqual(['127.0.0.1:4101:1025', '127.0.0.1:4102:8025']);
        expect(mail.publishedPorts).toEqual({ ui: 4102 });
        expect(registry.envFor(A)).toEqual({ MAIL_MAILER: 'smtp', MAIL_HOST: '127.0.0.1', MAIL_PORT: '4101', MAIL_FROM_ADDRESS: 'genie+ws_example_a@mail.gen', GENIE_MAIL_TAG: 'ws_example_a' });
        const b = registry.envFor(B);
        expect(b.GENIE_MAIL_TAG).toBe('ws_example_b');
        // COUNTED: nothing in B's env names A.
        expect(Object.values(b).filter((v) => v.includes('ws_example_a'))).toHaveLength(0);
    });
});

describe('Meilisearch (H7)', () => {
    it('the plan: Genie 1’s image and tag, the master key from env, its data at /meili_data', async () => {
        expect(containerPlan({ engine: 'meilisearch', major: '1', scope: { kind: 'dedicated', workspaceId: A }, publishedPort: 4107, credentials: { password: 'genpw-0001' } })).toEqual({
            image: 'getmeili/meilisearch:v1',
            name: 'genie-example-a-meilisearch-1',
            volume: 'genie-example-a-meilisearch-1-data',
            publish: ['127.0.0.1:4107:7700'],
            env: { MEILI_MASTER_KEY: 'genpw-0001', MEILI_ENV: 'development' },
        });
    });

    it('shared: each workspace gets ITS index prefix under Genie 1’s names; the key is the engine’s master key (namespace isolation, as Genie 1’s)', async () => {
        const meili = await added({ engine: 'meilisearch', major: '1', scope: SHARED, consent: true, workspaceId: A });
        await registry.add({ engine: 'meilisearch', major: '1', scope: SHARED, consent: true, workspaceId: B });
        expect(docker.of('create')).toHaveLength(1);
        expect(docker.of('create')[0]).toContain('genie-shared-meilisearch-1-data:/meili_data');
        const master = find(meili.id).credentials.password!;
        expect(master).toMatch(/^genpw-/);
        expect(registry.envFor(A)).toEqual({ MEILISEARCH_HOST: 'http://127.0.0.1:4101', MEILISEARCH_KEY: master, MEILISEARCH_INDEX_PREFIX: 'ws_example_a_' });
        expect(registry.envFor(B).MEILISEARCH_INDEX_PREFIX).toBe('ws_example_b_');
        expect(Object.values(registry.envFor(A)).filter((v) => v.includes('ws_example_b'))).toHaveLength(0);
    });
});

describe('SeaweedFS, the S3 engine (H7)', () => {
    const admin = { user: 'genie', password: 'genpw-admin1' };

    it('the container writes its admin identity BEFORE its server starts (fail-closed), and publishes only S3 — never the unauthenticated filer', () => {
        const plan = containerPlan({ engine: 'seaweedfs', major: '4.48', scope: SHARED, publishedPort: 4101, admin });
        expect(plan.image).toBe('chrislusf/seaweedfs:4.48');
        expect(plan.publish).toEqual(['127.0.0.1:4101:8333']);
        expect(plan.publish.filter((p) => p.endsWith(':8888'))).toHaveLength(0);
        expect(plan.entrypoint).toBe('sh');
        expect(plan.command?.[0]).toBe('-c');
        const script = plan.command![1]!;
        expect(script).toContain(`'{"identities":[{"name":"genie","credentials":[{"accessKey":"genie","secretKey":"genpw-admin1"}]`);
        expect(script.indexOf('> /etc/seaweedfs/s3.json')).toBeGreaterThan(-1);
        expect(script.indexOf('> /etc/seaweedfs/s3.json')).toBeLessThan(script.indexOf('exec /entrypoint.sh server'));
        expect(script).toContain('-s3.config=/etc/seaweedfs/s3.json');
        expect(() => containerPlan({ engine: 'seaweedfs', major: '4.48', scope: SHARED, publishedPort: 4101 })).toThrow(/unauthenticated/);
        expect(() => containerPlan({ engine: 'seaweedfs', major: '4.48', scope: { kind: 'dedicated', workspaceId: A }, publishedPort: 4101, admin })).toThrow(/shared/);
    });

    it('two workspaces: each gets ITS bucket and access key with ITS secret — A’s env never holds B’s secret or the admin’s (counted, with the secrets as the control)', async () => {
        const s3 = await added({ engine: 'seaweedfs', major: '4.48', scope: SHARED, consent: true, workspaceId: A });
        await registry.add({ engine: 'seaweedfs', major: '4.48', scope: SHARED, consent: true, workspaceId: B });
        const create = docker.of('create')[0]!;
        // `--entrypoint` takes one word and precedes the image; the script follows the image.
        const image = create.indexOf('chrislusf/seaweedfs:4.48');
        expect(create[create.indexOf('--entrypoint') + 1]).toBe('sh');
        expect(create.indexOf('--entrypoint')).toBeLessThan(image);
        expect(create[image + 1]).toBe('-c');

        const i = find(s3.id);
        const sa = i.slices![A]!;
        const sb = i.slices![B]!;
        expect([sa.bucket, sb.bucket]).toEqual(['ws-example-a', 'ws-example-b']);
        const steps = docker.execs().map((argv) => argv.join(' '));
        expect(steps.filter((s) => s === 'sh -c nc -z 127.0.0.1 8333').length).toBeGreaterThanOrEqual(2);
        expect(steps.filter((s) => s.includes("'s3.bucket.create -name ws-example-a'"))).toHaveLength(1);
        expect(steps.filter((s) => s.includes(`s3.configure -user ws-example-a -access_key ws-example-a -secret_key ${sa.password} -buckets ws-example-a -actions Read,Write,List,Tagging -apply`))).toHaveLength(1);
        expect(steps.filter((s) => s.includes(`-access_key ws-example-b -secret_key ${sb.password} -buckets ws-example-b`))).toHaveLength(1);
        // A workspace credential is never an Admin (an Admin reaches every bucket).
        expect(steps.filter((s) => /-actions [^']*Admin/.test(s))).toHaveLength(0);

        const envA = registry.envFor(A);
        expect(envA).toEqual({ AWS_ENDPOINT: 'http://127.0.0.1:4101', AWS_ACCESS_KEY_ID: 'ws-example-a', AWS_SECRET_ACCESS_KEY: sa.password, AWS_BUCKET: 'ws-example-a', AWS_DEFAULT_REGION: 'us-east-1', AWS_USE_PATH_STYLE_ENDPOINT: 'true' });
        expect(new Set([sa.password, sb.password, i.admin!.password]).size).toBe(3);
        expect(registry.envFor(B).AWS_SECRET_ACCESS_KEY).toBe(sb.password);
        expect(JSON.stringify(envA)).not.toContain(sb.password);
        expect(JSON.stringify(envA)).not.toContain(i.admin!.password);
    });

    it('a bucket name that is not a derived one is refused before it reaches a shell', () => {
        expect(() => provisionSteps('seaweedfs', admin, { identifier: 'ws_example_a', password: 'genpw-0001', bucket: "x'; rm -rf / #" })).toThrow(/bucket name/);
        expect(provisionSteps('seaweedfs', admin, { identifier: 'ws_example_a', password: 'genpw-0001', bucket: 'ws-example-a' })).toHaveLength(2);
    });
});

describe('a custom image (H7)', () => {
    const custom = { image: CUSTOM_IMAGE, internalPort: 8080, env: { GREETING: 'hello' } };

    it('the plan is the person’s image, port and env — no data volume — and it is always dedicated', () => {
        expect(containerPlan({ engine: 'custom', major: 'echo', scope: { kind: 'dedicated', workspaceId: A }, publishedPort: 4101, custom })).toEqual({
            image: CUSTOM_IMAGE, name: 'genie-example-a-custom-echo', volume: null, publish: ['127.0.0.1:4101:8080'], env: { GREETING: 'hello' },
        });
        expect(() => containerPlan({ engine: 'custom', major: 'echo', scope: SHARED, publishedPort: 4101, custom })).toThrow(/always dedicated/);
    });

    it('asks before pulling (naming ITS registry), then creates it exactly as named; Genie 1’s GENIE_SERVICE_CUSTOM_<NAME>_* plus its env reach only its workspace', async () => {
        await open(fakeDocker({ absentImages: [CUSTOM_IMAGE] }));
        const ask = await registry.add({ engine: 'custom', major: 'echo', scope: { kind: 'dedicated', workspaceId: A }, consent: false, custom });
        expect(ask).toEqual({ kind: 'needs-consent', image: CUSTOM_IMAGE, note: `${CUSTOM_IMAGE} is not on this machine; pulling it downloads the image from registry.example.` });
        expect(docker.of('pull').length + docker.of('create').length).toBe(0);

        const echo = await added({ engine: 'custom', major: 'echo', scope: { kind: 'dedicated', workspaceId: A }, consent: true, custom });
        expect(docker.of('pull')).toEqual([['pull', CUSTOM_IMAGE]]);
        const create = docker.of('create')[0]!;
        expect(create).not.toContain('-v');
        expect(create.slice(-1)).toEqual([CUSTOM_IMAGE]);
        expect(create).toContain('GREETING=hello');
        expect(echo).toMatchObject({ engine: 'custom', version: 'echo', image: CUSTOM_IMAGE, internalPort: 8080, env: { GREETING: 'hello' } });
        expect(registry.envFor(A)).toEqual({ GENIE_SERVICE_CUSTOM_ECHO_HOST: '127.0.0.1', GENIE_SERVICE_CUSTOM_ECHO_PORT: '4101', GREETING: 'hello' });
        expect(registry.envFor(B)).toEqual({});

        // Nothing to delete: a custom image keeps no volume — the container goes, no `volume rm` is invented.
        const mark = docker.calls.length;
        await registry.remove(echo.id, { deleteData: true, workspaceId: A });
        expect(docker.calls.slice(mark).map((c) => c[0])).toEqual(['rm']);
    });

    it('the form refuses what Genie would not run — every problem at once; a good one passes (control)', () => {
        const bad = validateServiceForm({ workspaceId: A, engine: 'custom', major: '', scope: 'shared', custom: { name: 'Bad Name', image: '-v /:/host', port: null, env: { 'NOT OK': 'x' } } });
        expect(bad.map((p) => p.field)).toEqual(['scope', 'name', 'image', 'port', 'env']);
        expect(bad.find((p) => p.field === 'env')!.message).toContain('"NOT OK"');
        expect(validateServiceForm({ workspaceId: A, engine: 'custom', major: '', scope: 'dedicated', custom: { name: 'echo', image: CUSTOM_IMAGE, port: 8080, env: { GREETING: 'hello' } } })).toEqual([]);
    });

    it('the env box reads NAME=value lines; a line that is not one keeps its text as the name, so the form names it', () => {
        expect(parseEnvLines('GREETING=hello\r\n\n# a comment\nURL=http://h.example/?a=b\nnot a pair')).toEqual({ GREETING: 'hello', URL: 'http://h.example/?a=b', 'not a pair': '' });
    });
});
