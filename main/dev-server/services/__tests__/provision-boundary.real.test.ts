import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createDockerRuntime } from '../../docker-adapter';
import { provisionSteps, runProvisionSteps } from '../provision';
import {
    DEFAULT_VERSIONS,
    engineSpecFor,
    workspaceDnsName,
    workspaceSqlIdentifier,
} from '../catalog';
import type { ContainerRef, ContainerRuntime } from '../../container-runtime';
import type { EngineAdmin, WorkspaceSlice } from '../provision';

/**
 * REAL engine tests for the SLICE BOUNDARY (Tynn #250, step 4).
 *
 * `provision.test.ts` asserts the argv, which is the right unit test and cannot
 * possibly answer the question that matters: does the engine actually REFUSE
 * workspace A's credential on workspace B's data? A mistyped ACL selector, a
 * policy MinIO parses but does not apply, an `mc` subcommand that moved between
 * releases — every one of those produces argv that reads correctly and a
 * boundary that is not there, and no amount of string matching sees it.
 *
 * So these run Genie's OWN `provisionSteps` through Genie's OWN Docker adapter
 * against a real engine, provision TWO workspaces on it, and then try to cross
 * the line with the credential the workspace is actually handed. They belong in
 * the `npm run test:hosting` lane beside the other `*.real.test.ts` files, not
 * in the fast unit run.
 *
 * The MinIO case is the one that changed: it used to hand every workspace the
 * engine's ROOT credential, so "A deletes B's bucket" was not a boundary
 * failure — it was the documented behaviour.
 */

// PINNED, not `latest`. MinIO's `latest` disappearing is why this file's S3 half
// had to be rewritten at all; a moving tag for the client would repeat it.
const AWS_CLI_IMAGE = 'amazon/aws-cli:2.31.31';
const REDIS_IMAGE = 'redis:7-alpine';
const LABEL = { 'genie.realtest': '1' };

/** Probe the ENGINE, not the binary — the CLI stays on PATH when Docker Desktop
 *  is stopped. Skips where there is no daemon; the CI hosting job has one. */
const hasDocker = (() => {
    try {
        return (
            spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
                stdio: 'ignore',
                timeout: 15_000,
            }).status === 0
        );
    } catch {
        return false;
    }
})();

const rt: ContainerRuntime = createDockerRuntime();
const started: ContainerRef[] = [];
const nonce = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const WORKSPACE = `realtest-slice-${nonce()}`;

/** Base64url, exactly like `generateServicePassword` — `provision.ts` refuses
 *  anything else, and rightly so. */
const ADMIN: EngineAdmin = { user: 'genie', password: 'admin_pw_realtest-01' };
const REDIS_ADMIN: EngineAdmin = { user: 'default', password: 'admin_pw_realtest-01' };

/** Derived exactly the way the manager derives it, rather than hand-spelled —
 *  a hand-spelled identifier is a fixture that can be legal where the real one
 *  would not be, which is how a test proves something the product never does. */
const sliceFor = (workspaceId: string): WorkspaceSlice => ({
    identifier: workspaceSqlIdentifier(workspaceId),
    dnsName: workspaceDnsName(workspaceId),
    password: `pw_${workspaceId.replace(/[^A-Za-z0-9_-]/g, '_')}_012345`,
});

async function ensureImage(image: string): Promise<void> {
    if (!(await rt.imageExists(image))) await rt.pullImage(image);
}

async function run(
    image: string,
    name: string,
    extra: { env?: Record<string, string>; command?: string[]; entrypoint?: string[] },
): Promise<ContainerRef> {
    const ref = await rt.runContainer({
        workspaceId: WORKSPACE,
        name,
        image,
        labels: LABEL,
        ...extra,
    });
    started.push(ref);
    return ref;
}

/** Poll until the engine answers, rather than sleeping a guessed interval. */
async function waitFor(check: () => Promise<boolean>, budgetMs = 40_000): Promise<void> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
        if (await check().catch(() => false)) return;
        if (Date.now() > deadline) throw new Error('engine never became ready');
        await new Promise((r) => setTimeout(r, 400));
    }
}

beforeAll(async () => {
    if (!hasDocker) return;
    await ensureImage(engineSpecFor('seaweedfs').image(DEFAULT_VERSIONS.seaweedfs));
    await ensureImage(AWS_CLI_IMAGE);
    await ensureImage(REDIS_IMAGE);
    await rt.networkEnsure(WORKSPACE);
}, 180_000);

afterEach(async () => {
    for (const ref of started.splice(0)) {
        await rt.stop(ref.id).catch(() => {});
        await rt.remove(ref.id).catch(() => {});
    }
});

afterAll(async () => {
    if (hasDocker) await rt.networkRemove(WORKSPACE).catch(() => {});
});

describe('REAL SeaweedFS — a workspace reaches its own bucket and nothing else', () => {
    /**
     * The MinIO version of this block is gone because MinIO's images are gone
     * (genie#758) — both registries answer 401 anonymously and Docker Hub's tag
     * list reports `object not found`. The BOUNDARY it asserted is not gone and
     * must not be: it is the only thing proving a scoped credential is actually
     * scoped. So it changed engines rather than being deleted.
     *
     * The image ref AND the container's entrypoint come from the CATALOG rather
     * than being restated here. That matters more than usual: the entrypoint is
     * exactly where the security property lives, because
     * `weed/s3api/auth_credentials.go:414` leaves the S3 gateway ALLOW-ALL unless
     * it is started with `-s3.config`. Restating it would let this pass against a
     * construction Genie does not ship.
     *
     * Calls go through a real AWS CLI in a sibling container — the same SigV4
     * path an application takes — rather than a tool baked into the engine image.
     */
    const spec = engineSpecFor('seaweedfs');
    const SEAWEED_IMAGE = spec.image(DEFAULT_VERSIONS.seaweedfs);

    /**
     * One long-lived CLI container, driven with `exec`. A one-shot `docker run`
     * per call would need its exit status, and the runtime exposes no `wait` —
     * `exec` returns a CommandResult, which is what every assertion here reads.
     */
    let cli: ContainerRef | null = null;

    // The file-level afterEach stops and REMOVES every container a test started,
    // so a ref cached across tests is a dead id by the next one. That surfaced on
    // CI as `No such container: …` from the second test onward, on a run where
    // the engine itself was fine — the anonymous-refusal test passed. Forget it
    // here and let the next test start a fresh one.
    afterEach(() => {
        cli = null;
    });

    const startCli = async (): Promise<ContainerRef> => {
        if (cli) return cli;
        cli = await run(AWS_CLI_IMAGE, `genie-realtest-aws-${nonce()}`, {
            // The image's ENTRYPOINT is `aws`, so it would exit immediately.
            entrypoint: ['sh'],
            command: ['-c', 'sleep 3600'],
        });
        return cli;
    };

    /** `aws ...` as a given identity. Credentials ride in via `env` so they never
     *  appear in an argv a process listing would show. */
    const awsAs = async (
        endpoint: string,
        accessKey: string,
        secretKey: string,
        argv: string[],
    ) => {
        const c = await startCli();
        return rt.exec(c.id, [
            'env',
            `AWS_ACCESS_KEY_ID=${accessKey}`,
            `AWS_SECRET_ACCESS_KEY=${secretKey}`,
            'AWS_DEFAULT_REGION=us-east-1',
            'aws',
            '--endpoint-url',
            endpoint,
            ...argv,
        ]);
    };

    const startEngine = async (): Promise<{ ref: ContainerRef; endpoint: string }> => {
        const name = `genie-realtest-seaweed-${nonce()}`;
        const ref = await run(SEAWEED_IMAGE, name, {
            // THE ENTRYPOINT UNDER TEST: it writes the admin identity and then
            // execs the image's own entrypoint. If it did not, the gateway would
            // come up unauthenticated — which is why the anonymous probe below is
            // asserted before anything else.
            entrypoint: spec.entrypoint?.(ADMIN.password),
        });
        await waitFor(async () => {
            const probe = await rt.exec(ref.id, ['sh', '-c', 'nc -z 127.0.0.1 8333']);
            return probe.code === 0;
        }, 120_000);
        return { ref, endpoint: `http://${name}:8333` };
    };

    it.skipIf(!hasDocker)(
        'refuses an ANONYMOUS caller — the property the entrypoint exists for',
        async () => {
            // Asserted on its own, and first. Without `-s3.config` SeaweedFS
            // answers every unsigned request, so a suite that only checked
            // CROSS-workspace access would pass against a wide-open engine: each
            // workspace would indeed reach its own bucket, and so would everyone.
            const { endpoint } = await startEngine();

            const anon = await awsAs(endpoint, '', '', ['s3api', 'list-buckets']);
            expect(anon.code).not.toBe(0);
        },
        300_000,
    );

    it.skipIf(!hasDocker)(
        'provisions two workspaces, and refuses each one the other’s bucket',
        async () => {
            const { ref, endpoint } = await startEngine();

            const acme = sliceFor('acme-1a2b3c4d');
            const notes = sliceFor('notes-9f8e7d6c');
            for (const slice of [acme, notes]) {
                const result = await runProvisionSteps(
                    rt,
                    ref.id,
                    provisionSteps('seaweedfs', ADMIN, slice),
                );
                expect(result.ok, result.error).toBe(true);
            }

            // Its own bucket, with EXACTLY the credential `env-wiring.ts` hands the
            // workspace: access key = bucket name, secret = its own password.
            const wrote = await awsAs(endpoint, acme.dnsName, acme.password, [
                's3api',
                'put-object',
                '--bucket',
                acme.dnsName,
                '--key',
                'f.txt',
            ]);
            expect(wrote.code, wrote.stderr).toBe(0);

            // The other workspace's bucket: refused for reading…
            const listed = await awsAs(endpoint, acme.dnsName, acme.password, [
                's3api',
                'list-objects-v2',
                '--bucket',
                notes.dnsName,
            ]);
            expect(listed.code).not.toBe(0);

            // …and for the call that would destroy it.
            const removed = await awsAs(endpoint, acme.dnsName, acme.password, [
                's3api',
                'delete-bucket',
                '--bucket',
                notes.dnsName,
            ]);
            expect(removed.code).not.toBe(0);

            // …and it is still there, seen by an identity permitted to look.
            const still = await awsAs(endpoint, 'genie', ADMIN.password, [
                's3api',
                'list-buckets',
            ]);
            expect(still.code, still.stderr).toBe(0);
            expect(still.stdout).toContain(notes.dnsName);
        },
        300_000,
    );

    it.skipIf(!hasDocker)(
        'converges when provisioning runs again, keeping the data',
        async () => {
            const { ref, endpoint } = await startEngine();

            const acme = sliceFor('acme-1a2b3c4d');
            const steps = provisionSteps('seaweedfs', ADMIN, acme);
            expect((await runProvisionSteps(rt, ref.id, steps)).ok).toBe(true);

            const wrote = await awsAs(endpoint, acme.dnsName, acme.password, [
                's3api',
                'put-object',
                '--bucket',
                acme.dnsName,
                '--key',
                'f.txt',
            ]);
            expect(wrote.code, wrote.stderr).toBe(0);

            // Provisioning runs on EVERY acquire, so a second pass must succeed and
            // must not empty what the first created. `s3.configure` is convergent
            // by construction — GetUser, then Create on NotFound, Update otherwise
            // — and this is what holds that claim to account.
            const again = await runProvisionSteps(rt, ref.id, steps);
            expect(again.ok, again.error).toBe(true);

            const listed = await awsAs(endpoint, acme.dnsName, acme.password, [
                's3api',
                'list-objects-v2',
                '--bucket',
                acme.dnsName,
            ]);
            expect(listed.code, listed.stderr).toBe(0);
            expect(listed.stdout).toContain('f.txt');
        },
        300_000,
    );
});

describe('REAL Redis — the key prefix, and the commands it cannot scope', () => {
    it.skipIf(!hasDocker)('lets a workspace at its own keys and refuses the rest', async () => {
        const ref = await run(REDIS_IMAGE, `genie-realtest-redis-acl-${nonce()}`, {
            command: ['redis-server', '--requirepass', REDIS_ADMIN.password, '--appendonly', 'yes'],
        });
        const cli = (...argv: string[]) =>
            rt.exec(ref.id, [
                'redis-cli',
                '-a',
                REDIS_ADMIN.password,
                '--no-auth-warning',
                ...argv,
            ]);
        await waitFor(async () => (await cli('ping')).stdout.includes('PONG'));

        const acme = sliceFor('acme-1a2b3c4d');
        const result = await runProvisionSteps(
            rt,
            ref.id,
            provisionSteps('redis', REDIS_ADMIN, acme),
        );
        expect(result.ok, result.error).toBe(true);

        const asAcme = (...argv: string[]) =>
            rt.exec(ref.id, [
                'redis-cli',
                '--user',
                acme.identifier,
                '--pass',
                acme.password,
                '--no-auth-warning',
                ...argv,
            ]);

        // Its own prefix works — the ACL is not simply denying everything, which
        // is the way this test could pass while proving nothing.
        expect((await asAcme('set', `${acme.identifier}:k`, 'v')).stdout).toContain('OK');
        // Another workspace's keys, and the two commands a key pattern cannot
        // scope, are all refused.
        expect((await asAcme('get', 'ws_other:k')).stdout).toContain('NOPERM');
        expect((await asAcme('swapdb', '0', '1')).stdout).toContain('NOPERM');
        expect((await asAcme('function', 'flush')).stdout).toContain('NOPERM');
    }, 180_000);

    it.skipIf(!hasDocker)('fails provisioning Redis ANSWERS with an error, though redis-cli exits 0 (genie#643)', async () => {
        // The real client, not a fake: `redis-cli` exits 0 on an error reply. A
        // wrong admin password gets `NOAUTH` for the `ACL SETUSER`, creates no
        // user, and used to count as provisioned — the same shape as the
        // `LOADING` reply that left a real workspace with WRONGPASS.
        const ref = await run(REDIS_IMAGE, `genie-realtest-redis-noauth-${nonce()}`, {
            command: ['redis-server', '--requirepass', REDIS_ADMIN.password, '--appendonly', 'yes'],
        });
        const ping = () =>
            rt.exec(ref.id, ['redis-cli', '-a', REDIS_ADMIN.password, '--no-auth-warning', 'ping']);
        await waitFor(async () => (await ping()).stdout.includes('PONG'));

        const wrongAdmin: EngineAdmin = { user: 'default', password: 'admin_pw_not-this-one' };
        const refused = await rt.exec(ref.id, ['redis-cli', '-a', wrongAdmin.password, '--no-auth-warning', 'ping']);
        // The premise, measured here rather than assumed.
        expect(refused.code).toBe(0);

        const result = await runProvisionSteps(rt, ref.id, provisionSteps('redis', wrongAdmin, sliceFor('acme-1a2b3c4d')));

        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/NOAUTH|WRONGPASS/);
    }, 180_000);
});
