import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createDockerRuntime } from '../../docker-adapter';
import { engineSpecFor } from '../catalog';
import { POSTGRES_EXTENSIONS } from '../extensions';
import type { ContainerRef, ContainerRuntime } from '../../container-runtime';

/**
 * REAL image test for the Postgres engine: **every extension Genie whitelists
 * is actually installable in the image Genie runs.**
 *
 * ## Why this test has to run a real engine
 *
 * `extensions.ts` decides what a workspace may ASK for; the IMAGE decides what
 * exists. Nothing in the codebase connected those two, and the gap was not
 * theoretical — `postgis` was whitelisted, named in `manageService`'s own tool
 * description, and answered `could not open extension control file` because the
 * image Genie pinned had never carried it. That failure is invisible to every
 * string-matching test that could be written about it: the whitelist reads
 * correctly, the SQL reads correctly, the argv reads correctly, and
 * `CREATE EXTENSION` still fails. Only Postgres can answer this question, so
 * only Postgres is asked.
 *
 * ## Why it builds the image rather than pulling the published one
 *
 * The subject is the image **this repository defines**, not whatever is on a
 * registry today. Building from `postgres-image/Dockerfile` means the assertion
 * covers the commit under review — a PR that adds an extension to the whitelist
 * and forgets the Dockerfile fails HERE, before anything is published, rather
 * than after a tag has gone out. It also needs no registry credential, which is
 * what lets it run on an ordinary PR.
 *
 * One major is built (the catalog's default). The publish workflow
 * (`.github/workflows/postgres-image.yml`) runs the same assertions across
 * every major in `POSTGRES.versions` on both architectures before it pushes;
 * this lane is the per-commit guard, not the release gate.
 */

const CONTEXT = path.resolve(process.cwd(), 'main/dev-server/postgres-image');
const PG_MAJOR = engineSpecFor('postgres').versions[0]!;
const TAG = 'genie-postgres:realtest';
const ADMIN_PASSWORD = 'admin_pw_realtest-01';
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

function buildImage(): void {
    const built = spawnSync(
        'docker',
        ['build', '--build-arg', `PG_MAJOR=${PG_MAJOR}`, '-t', TAG, CONTEXT],
        { encoding: 'utf8', timeout: 900_000 },
    );
    if (built.status !== 0) {
        throw new Error(
            `docker build of ${CONTEXT} failed (${built.status}):\n${built.stderr ?? ''}`,
        );
    }
}

async function waitFor(check: () => Promise<boolean>, budgetMs = 90_000): Promise<void> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
        if (await check().catch(() => false)) return;
        if (Date.now() > deadline) throw new Error('engine never became ready');
        await new Promise((r) => setTimeout(r, 500));
    }
}

/**
 * The engine started EXACTLY the way `service-manager` starts one — the same
 * admin env and the same PGDATA subdirectory. A container that only comes up
 * under different settings would prove nothing about the drop-in claim.
 *
 * `--network none` and no published port: everything here runs through `exec`,
 * over the container's own loopback. So this cannot collide with an engine the
 * machine is already running, and it creates no network to clean up.
 */
async function engine(): Promise<ContainerRef> {
    const spec = engineSpecFor('postgres');
    const ref = await rt.runContainer({
        workspaceId: null,
        name: `genie-realtest-pgimage-${nonce()}`,
        image: TAG,
        network: 'none',
        labels: LABEL,
        env: spec.adminEnv?.(ADMIN_PASSWORD) ?? {},
    });
    started.push(ref);
    await waitFor(async () => (await rt.exec(ref.id, spec.readyExec!(ADMIN_PASSWORD))).code === 0);
    return ref;
}

afterEach(async () => {
    for (const ref of started.splice(0)) {
        await rt.stop(ref.id).catch(() => {});
        await rt.remove(ref.id).catch(() => {});
    }
});

describe('REAL Postgres image — what the whitelist promises, the image delivers', () => {
    it.skipIf(!hasDocker)(
        'installs every extension in POSTGRES_EXTENSIONS',
        async () => {
            buildImage();
            const ref = await engine();

            // Each one separately, so a failure names the extension rather than
            // reporting that "a statement" failed.
            const failures: string[] = [];
            for (const extension of POSTGRES_EXTENSIONS) {
                const created = await rt.exec(ref.id, [
                    'psql',
                    '-U',
                    'postgres',
                    '-d',
                    'postgres',
                    '-v',
                    'ON_ERROR_STOP=1',
                    '-c',
                    `CREATE EXTENSION IF NOT EXISTS "${extension}"`,
                ]);
                if (created.code !== 0) {
                    failures.push(`${extension}: ${created.stderr.trim()}`);
                }
            }
            expect(failures, failures.join('\n')).toEqual([]);
        },
        1_200_000,
    );

    it.skipIf(!hasDocker)(
        'keeps the provisioning surface the catalog depends on',
        async () => {
            buildImage();
            const ref = await engine();

            // `readyExec` and every provisioning step shell out to these two by
            // bare name. An image that moved them would break provisioning in a
            // way no unit test can see — the argv would still read correctly.
            for (const tool of ['psql', 'pg_isready', 'pg_dump', 'createdb']) {
                const found = await rt.exec(ref.id, ['sh', '-c', `command -v ${tool}`]);
                expect(found.code, `${tool} is not on PATH in the image`).toBe(0);
            }

            // PGDATA is a SUBDIRECTORY of the volume mount (see catalog.ts). The
            // engine above was started with exactly that env, so a cluster living
            // there is the proof the layout survived.
            const dataDir = await rt.exec(ref.id, [
                'psql',
                '-U',
                'postgres',
                '-t',
                '-A',
                '-c',
                'SHOW data_directory',
            ]);
            expect(dataDir.code, dataDir.stderr).toBe(0);
            expect(dataDir.stdout.trim()).toBe('/var/lib/postgresql/data/pgdata');
        },
        1_200_000,
    );
});
