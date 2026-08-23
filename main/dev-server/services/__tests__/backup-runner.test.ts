import { describe, expect, it } from 'vitest';
import { SHARED_SERVICES_NETWORK } from '../../argv';
import { backupJobsFor } from '../backup';
import { runBackupJob } from '../backup-runner';
import type { BackupHostFs, BackupRunnerDeps } from '../backup-runner';
import type { DumpTarget } from '../backup';
import type { ContainerRuntime, ContainerSpec, StreamHandle } from '../../container-runtime';

/**
 * RUNNING a backup (Tynn #250, step 4).
 *
 * The dump is written by the engine's own tool into a BIND-MOUNTED host folder,
 * so no dump byte passes through Genie — `exec` keeps only the last 8KB of
 * stdout, which would make every backup a silently truncated one. These tests
 * pin the parts of that arrangement which are easy to get subtly wrong and
 * impossible to notice until a restore.
 */

const PG: DumpTarget = {
    engine: 'postgres',
    version: '17',
    image: 'pgvector/pgvector:pg17',
    host: 'genie-svc-postgres-17',
    port: 5432,
    slice: { identifier: 'ws_notes_1a2b3c4d', password: 'pw-Abc_123' },
};

const JOB = backupJobsFor({
    appSlug: 'notes',
    machine: 'workstation',
    at: new Date('2026-08-22T01:02:03.000Z'),
    targets: [PG],
})[0]!;

const ROOT = '/Volumes/Shared/genie-backups';
const DEST = `${ROOT}/workstation/notes/postgres-17`;

interface Fake {
    runtime: ContainerRuntime;
    ran: ContainerSpec[];
    removed: string[];
    files: Set<string>;
    fsRemoved: string[];
    made: string[];
}

function fake(
    opts: {
        /** The dump container leaves no finished file — a failed dump. */
        failsToWrite?: boolean;
        /** `ensureDir` throws, standing in for an offline share. */
        unreachableDir?: boolean;
        /** Dumps already sitting in the destination. */
        existing?: string[];
        log?: string;
        /** The container never exits within the budget. */
        hangs?: boolean;
    } = {},
): Fake {
    const ran: ContainerSpec[] = [];
    const removed: string[] = [];
    const fsRemoved: string[] = [];
    const made: string[] = [];
    const files = new Set<string>((opts.existing ?? []).map((n) => `${DEST}/${n}`));

    const runtime = {
        kind: 'docker',
        async runContainer(spec: ContainerSpec) {
            ran.push(spec);
            // The real dump container writes through the mount; the fake stands in
            // for that by creating the finished file the rename would have left.
            if (!opts.failsToWrite && !opts.hangs) files.add(`${DEST}/${JOB.fileName}`);
            return { id: `id-${spec.name}`, name: spec.name };
        },
        followLogs(_id: string, onData: (chunk: string) => void): StreamHandle {
            if (opts.log) onData(opts.log);
            return {
                exited: opts.hangs ? new Promise<number | null>(() => {}) : Promise.resolve(0),
                stop() {},
            };
        },
        async stop() {},
        async remove(id: string) {
            removed.push(id);
        },
        async logs() {
            return opts.log ?? '';
        },
    } as unknown as ContainerRuntime;

    return { runtime, ran, removed, files, fsRemoved, made };
}

function deps(f: Fake, over: Partial<BackupRunnerDeps> = {}): BackupRunnerDeps {
    const fs: BackupHostFs = {
        async ensureDir(p) {
            f.made.push(p);
        },
        async list(p) {
            return [...f.files]
                .filter((full) => full.startsWith(`${p}/`))
                .map((full) => full.slice(p.length + 1));
        },
        async remove(p) {
            f.fsRemoved.push(p);
            f.files.delete(p);
        },
        async exists(p) {
            return f.files.has(p);
        },
        async size() {
            return 4096;
        },
    };
    return {
        runtime: f.runtime,
        fs,
        join: (...parts) => parts.join('/'),
        platform: 'linux',
        nameSuffix: () => 'abc123',
        timeoutMs: 50,
        ...over,
    };
}

describe('runBackupJob', () => {
    it('mounts the destination and runs the engine’s own image there', async () => {
        const f = fake();
        const result = await runBackupJob(JOB, ROOT, deps(f), 3);

        expect(result.ok, result.error).toBe(true);
        expect(result.path).toBe(`${DEST}/${JOB.fileName}`);
        const spec = f.ran[0]!;
        expect(spec.image).toBe('pgvector/pgvector:pg17');
        expect(spec.mounts).toEqual([{ source: DEST, target: JOB.mountTarget }]);
        expect(spec.command).toEqual(JOB.command);
        expect(f.made).toContain(DEST);
    });

    it('joins the SHARED services network, which is how it reaches the engine', async () => {
        const f = fake();
        await runBackupJob(JOB, ROOT, deps(f), 3);
        const spec = f.ran[0]!;
        expect(spec.network).toBe(SHARED_SERVICES_NETWORK);
        // Machine-scoped, like the engines: a workspace label would put it in
        // reach of `teardownWorkspaceSandbox`.
        expect(spec.workspaceId).toBeNull();
        // A dump container must never come back by itself after a reboot.
        expect(spec.restart ?? 'no').toBe('no');
    });

    it('removes the dump container whether it worked or not', async () => {
        const good = fake();
        await runBackupJob(JOB, ROOT, deps(good), 3);
        expect(good.removed.length).toBe(1);

        const bad = fake({ failsToWrite: true });
        await runBackupJob(JOB, ROOT, deps(bad), 3);
        expect(bad.removed.length).toBe(1);
    });

    it('calls a dump that left no finished file a FAILURE, and says what the engine said', async () => {
        // The finished file only exists because the job renamed `.part` onto it,
        // so its absence is the one reliable signal that the dump did not complete.
        const f = fake({ failsToWrite: true, log: 'pg_dump: error: connection refused' });
        const result = await runBackupJob(JOB, ROOT, deps(f), 3);

        expect(result.ok).toBe(false);
        expect(result.error).toContain('connection refused');
        expect(result.path).toBeUndefined();
    });

    it('clears a half-written .part behind a failed dump', async () => {
        const f = fake({ failsToWrite: true });
        f.files.add(`${DEST}/${JOB.fileName}.part`);
        await runBackupJob(JOB, ROOT, deps(f), 3);
        expect(f.fsRemoved).toContain(`${DEST}/${JOB.fileName}.part`);
    });

    it('reports an unreachable folder instead of writing somewhere else', async () => {
        const f = fake();
        const result = await runBackupJob(
            JOB,
            ROOT,
            deps(f, {
                fs: {
                    ...deps(f).fs,
                    async ensureDir() {
                        throw new Error('ENOENT: no such file or directory');
                    },
                },
            }),
            3,
        );
        expect(result.ok).toBe(false);
        expect(result.error).toContain(DEST);
        // Nothing was started — a backup that silently lands elsewhere is worse
        // than one that did not happen.
        expect(f.ran).toEqual([]);
    });

    it('refuses a UNC path and says to map it as a drive', async () => {
        // `--mount source=\\\\server\\share` is not something Docker Desktop takes,
        // and "point it at a shared folder" is exactly when someone will try.
        const f = fake();
        const result = await runBackupJob(JOB, '\\\\nas\\backups', deps(f, { platform: 'win32' }), 3);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/drive letter/i);
        expect(f.ran).toEqual([]);
    });

    it('prunes only its OWN old dumps, oldest first', async () => {
        const f = fake({
            existing: [
                '20260819T010203Z.dump',
                '20260820T010203Z.dump',
                '20260821T010203Z.dump',
                'someone-elses-notes.txt',
            ],
        });
        const result = await runBackupJob(JOB, ROOT, deps(f), 2);

        // 3 old + the one just written = 4; keep 2, so the two oldest go.
        expect(result.pruned).toEqual(['20260819T010203Z.dump', '20260820T010203Z.dump']);
        expect(f.fsRemoved).not.toContain(`${DEST}/someone-elses-notes.txt`);
    });

    it('does not prune when the dump FAILED — that would spend a good backup on a bad one', async () => {
        const f = fake({
            failsToWrite: true,
            existing: ['20260819T010203Z.dump', '20260820T010203Z.dump'],
        });
        const result = await runBackupJob(JOB, ROOT, deps(f), 1);
        expect(result.pruned).toEqual([]);
        expect(f.fsRemoved.filter((p) => p.endsWith('.dump'))).toEqual([]);
    });

    it('stops a dump that hangs, and reports it rather than waiting forever', async () => {
        const f = fake({ hangs: true });
        const result = await runBackupJob(JOB, ROOT, deps(f), 3);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/did not finish/i);
        expect(f.removed.length).toBe(1);
    });
});
