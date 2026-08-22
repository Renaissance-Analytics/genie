import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createDockerRuntime } from '../../docker-adapter';
import { provisionSteps, runProvisionSteps } from '../provision';
import { workspaceDnsName, workspaceSqlIdentifier } from '../catalog';
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

const MINIO_IMAGE = 'minio/minio:latest';
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
    extra: { env?: Record<string, string>; command?: string[] },
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
    await ensureImage(MINIO_IMAGE);
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

describe('REAL MinIO — a workspace reaches its own bucket and nothing else', () => {
    it.skipIf(!hasDocker)(
        'provisions two workspaces, and refuses each one the other’s bucket',
        async () => {
            const ref = await run(MINIO_IMAGE, `genie-realtest-minio-${nonce()}`, {
                env: { MINIO_ROOT_USER: ADMIN.user, MINIO_ROOT_PASSWORD: ADMIN.password },
                command: ['server', '/data', '--console-address', ':9001'],
            });
            await waitFor(async () => (await rt.exec(ref.id, ['mc', '--version'])).code === 0);
            await waitFor(
                async () =>
                    (
                        await rt.exec(ref.id, [
                            'mc',
                            'alias',
                            'set',
                            'probe',
                            'http://127.0.0.1:9000',
                            ADMIN.user,
                            ADMIN.password,
                        ])
                    ).code === 0,
            );

            const acme = sliceFor('acme-1a2b3c4d');
            const notes = sliceFor('notes-9f8e7d6c');
            for (const slice of [acme, notes]) {
                const result = await runProvisionSteps(
                    rt,
                    ref.id,
                    provisionSteps('minio', ADMIN, slice),
                );
                expect(result.ok, result.error).toBe(true);
            }

            // Sign in as `acme` with EXACTLY the credential env-wiring hands the
            // workspace: access key = its bucket name, secret = its own password.
            const asAcme = async (...argv: string[]) => rt.exec(ref.id, ['mc', ...argv]);
            expect(
                (
                    await asAcme(
                        'alias',
                        'set',
                        'acme',
                        'http://127.0.0.1:9000',
                        acme.dnsName,
                        acme.password,
                    )
                ).code,
            ).toBe(0);

            // Its own bucket: writable.
            const wrote = await rt.exec(ref.id, [
                'sh',
                '-c',
                `echo hello > /tmp/f.txt && mc cp /tmp/f.txt acme/${acme.dnsName}/f.txt`,
            ]);
            expect(wrote.code, wrote.stderr).toBe(0);

            // The other workspace's bucket: refused, for reading AND for the
            // command that would destroy it.
            const listed = await asAcme('ls', `acme/${notes.dnsName}`);
            expect(listed.code).not.toBe(0);
            const removed = await asAcme('rb', '--force', `acme/${notes.dnsName}`);
            expect(removed.code).not.toBe(0);

            // …and it is still there.
            const still = await rt.exec(ref.id, ['mc', 'ls', 'probe/']);
            expect(still.stdout).toContain(notes.dnsName);
        },
        180_000,
    );

    it.skipIf(!hasDocker)('converges when provisioning runs again, keeping the data', async () => {
        const ref = await run(MINIO_IMAGE, `genie-realtest-minio-${nonce()}`, {
            env: { MINIO_ROOT_USER: ADMIN.user, MINIO_ROOT_PASSWORD: ADMIN.password },
            command: ['server', '/data', '--console-address', ':9001'],
        });
        await waitFor(
            async () =>
                (
                    await rt.exec(ref.id, [
                        'mc',
                        'alias',
                        'set',
                        'probe',
                        'http://127.0.0.1:9000',
                        ADMIN.user,
                        ADMIN.password,
                    ])
                ).code === 0,
        );

        const acme = sliceFor('acme-1a2b3c4d');
        const steps = provisionSteps('minio', ADMIN, acme);
        expect((await runProvisionSteps(rt, ref.id, steps)).ok).toBe(true);

        await rt.exec(ref.id, [
            'sh',
            '-c',
            `echo hello > /tmp/f.txt && mc cp /tmp/f.txt probe/${acme.dnsName}/f.txt`,
        ]);

        // Provisioning runs on EVERY acquire, so the second pass must succeed and
        // must not empty the bucket it created the first time.
        const again = await runProvisionSteps(rt, ref.id, steps);
        expect(again.ok, again.error).toBe(true);
        const listed = await rt.exec(ref.id, ['mc', 'ls', `probe/${acme.dnsName}`]);
        expect(listed.stdout).toContain('f.txt');

        // THE UPGRADE PATH. That object was written by ROOT, which is how every
        // object in an existing install got there — MinIO was a namespace engine
        // and the root credential was what a workspace was handed. The scoped
        // user has to be able to read what root left behind, or switching
        // strategies would strand every existing bucket.
        expect(
            (
                await rt.exec(ref.id, [
                    'mc',
                    'alias',
                    'set',
                    'acme',
                    'http://127.0.0.1:9000',
                    acme.dnsName,
                    acme.password,
                ])
            ).code,
        ).toBe(0);
        const asWorkspace = await rt.exec(ref.id, ['mc', 'cat', `acme/${acme.dnsName}/f.txt`]);
        expect(asWorkspace.code, asWorkspace.stderr).toBe(0);
        expect(asWorkspace.stdout).toContain('hello');
    }, 180_000);
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
});
