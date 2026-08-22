import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SHARED_SERVICES_NETWORK } from '../../argv';
import { createDockerRuntime } from '../../docker-adapter';
import { provisionSteps, runProvisionSteps } from '../provision';
import { workspaceDnsName, workspaceSqlIdentifier } from '../catalog';
import { backupJobsFor } from '../backup';
import { runBackupJob } from '../backup-runner';
import type { ContainerRef, ContainerRuntime } from '../../container-runtime';
import type { BackupHostFs, BackupRunnerDeps } from '../backup-runner';
import type { EngineAdmin } from '../provision';

/**
 * REAL backup (Tynn #250, step 4).
 *
 * A backup is the one feature whose bugs stay invisible until the day it is
 * needed, and every part of this design exists to answer a failure that looks
 * like success: the dump is written by the engine's own tool into a bind mount
 * because a captured one would be its last 8KB, and the file is renamed into
 * place so a partial write cannot be mistaken for a whole one.
 *
 * None of that is worth anything unless the file at the end is a dump a restore
 * can actually read, so that is what this asserts — `pg_restore --list` against
 * the real artifact, not merely that a file appeared.
 */

const PG_IMAGE = 'pgvector/pgvector:pg17';
const LABEL = { 'genie.realtest': '1' };

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
const dirs: string[] = [];
const nonce = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const ADMIN: EngineAdmin = { user: 'postgres', password: 'admin_pw_realtest-01' };
const WS = 'ws-notes-1a2b3c4d';
const SLICE = {
    identifier: workspaceSqlIdentifier(WS),
    dnsName: workspaceDnsName(WS),
    password: 'pw_notes_012345',
};

const hostFs: BackupHostFs = {
    async ensureDir(dir) {
        await fsp.mkdir(dir, { recursive: true });
    },
    async list(dir) {
        return fsp.readdir(dir);
    },
    async remove(target) {
        await fsp.rm(target, { force: true });
    },
    async exists(target) {
        try {
            await fsp.access(target);
            return true;
        } catch {
            return false;
        }
    },
    async size(target) {
        return (await fsp.stat(target)).size;
    },
};

const deps = (): BackupRunnerDeps => ({
    runtime: rt,
    fs: hostFs,
    join: (...parts) => path.join(...parts),
    platform: process.platform,
    nameSuffix: () => nonce(),
    timeoutMs: 120_000,
});

async function waitFor(check: () => Promise<boolean>, budgetMs = 60_000): Promise<void> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
        if (await check().catch(() => false)) return;
        if (Date.now() > deadline) throw new Error('engine never became ready');
        await new Promise((r) => setTimeout(r, 500));
    }
}

/** A real Postgres on the SHARED services network — the surface a dump container
 *  actually reaches an engine through. */
async function engine(): Promise<ContainerRef> {
    const ref = await rt.runContainer({
        workspaceId: null,
        name: `genie-realtest-pgbackup-${nonce()}`,
        image: PG_IMAGE,
        network: SHARED_SERVICES_NETWORK,
        labels: LABEL,
        env: {
            POSTGRES_PASSWORD: ADMIN.password,
            POSTGRES_DB: 'postgres',
            PGDATA: '/var/lib/postgresql/data/pgdata',
        },
    });
    started.push(ref);
    await waitFor(
        async () =>
            (await rt.exec(ref.id, ['pg_isready', '-h', '127.0.0.1', '-U', 'postgres'])).code === 0,
    );
    return ref;
}

const targetOn = (ref: ContainerRef) => ({
    engine: 'postgres',
    version: '17',
    image: PG_IMAGE,
    host: ref.name,
    port: 5432,
    slice: SLICE,
});

beforeAll(async () => {
    if (!hasDocker) return;
    if (!(await rt.imageExists(PG_IMAGE))) await rt.pullImage(PG_IMAGE);
    await rt.networkEnsureNamed(SHARED_SERVICES_NETWORK);
}, 300_000);

afterEach(async () => {
    for (const ref of started.splice(0)) {
        await rt.stop(ref.id).catch(() => {});
        await rt.remove(ref.id).catch(() => {});
    }
    for (const dir of dirs.splice(0)) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
});

afterAll(() => {
    /* the shared services network is Genie's own, and is left in place */
});

describe('REAL backup — the file at the end is a dump a restore can read', () => {
    it.skipIf(!hasDocker)(
        'dumps a workspace slice, and pg_restore can list what came out',
        async () => {
            const ref = await engine();
            const provisioned = await runProvisionSteps(
                rt,
                ref.id,
                provisionSteps('postgres', ADMIN, SLICE),
            );
            expect(provisioned.ok, provisioned.error).toBe(true);

            // Real rows, written as the WORKSPACE — the credential the dump uses.
            const uri = `postgresql://${SLICE.identifier}:${SLICE.password}@127.0.0.1:5432/${SLICE.identifier}`;
            const seeded = await rt.exec(ref.id, [
                'psql',
                uri,
                '-v',
                'ON_ERROR_STOP=1',
                '-c',
                'CREATE TABLE notes (id int primary key, body text); ' +
                    "INSERT INTO notes VALUES (1, 'a genie app note');",
            ]);
            expect(seeded.code, seeded.stderr).toBe(0);

            const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'genie-backup-real-'));
            dirs.push(root);

            const job = backupJobsFor({
                appSlug: 'notes',
                machine: 'realtest',
                at: new Date('2026-08-22T01:02:03.000Z'),
                targets: [targetOn(ref)],
            })[0]!;

            const result = await runBackupJob(job, root, deps(), 3);
            expect(result.ok, result.error).toBe(true);
            expect(result.bytes ?? 0).toBeGreaterThan(0);

            // THE assertion. A file existing proves a file exists; only a restore
            // tool reading it back proves a backup.
            const listing = await rt.runContainer({
                workspaceId: null,
                name: `genie-realtest-pgrestore-${nonce()}`,
                image: PG_IMAGE,
                network: SHARED_SERVICES_NETWORK,
                labels: LABEL,
                mounts: [
                    { source: path.join(root, ...job.dir.split('/')), target: '/genie-backup' },
                ],
                command: ['sh', '-c', `pg_restore --list /genie-backup/${job.fileName}`],
            });
            started.push(listing);
            let log = '';
            await rt.followLogs(listing.id, (chunk) => {
                log += chunk;
            }).exited;
            expect(log).toContain('notes');
        },
        300_000,
    );

    it.skipIf(!hasDocker)(
        'keeps only the newest N dumps, and only the ones it wrote',
        async () => {
            const ref = await engine();
            expect(
                (await runProvisionSteps(rt, ref.id, provisionSteps('postgres', ADMIN, SLICE))).ok,
            ).toBe(true);

            const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'genie-backup-real-'));
            dirs.push(root);

            const at = (iso: string) =>
                backupJobsFor({
                    appSlug: 'notes',
                    machine: 'realtest',
                    at: new Date(iso),
                    targets: [targetOn(ref)],
                })[0]!;

            const first = at('2026-08-20T01:02:03.000Z');
            const dir = path.join(root, ...first.dir.split('/'));
            expect((await runBackupJob(first, root, deps(), 1)).ok).toBe(true);

            // Something this module did not write, in the folder someone SHARES.
            await fsp.writeFile(path.join(dir, 'do-not-delete.txt'), 'mine');

            const second = await runBackupJob(at('2026-08-21T01:02:03.000Z'), root, deps(), 1);
            expect(second.ok, second.error).toBe(true);
            expect(second.pruned).toEqual([first.fileName]);

            const left = await fsp.readdir(dir);
            expect(left).toContain('do-not-delete.txt');
            expect(left).not.toContain(first.fileName);
        },
        300_000,
    );
});
