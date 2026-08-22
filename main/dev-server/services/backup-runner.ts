import { ROLE_LABEL, SHARED_SERVICES_NETWORK } from '../argv';
import { toMountSource } from '../mount-path';
import { prunableDumps } from './backup';
import type { BackupJob } from './backup';
import type { ContainerRuntime } from '../container-runtime';

/**
 * Running one backup job (Tynn #250, step 4).
 *
 * The arrangement, and why it is this shape rather than the obvious one: the
 * ENGINE'S OWN TOOL writes the dump straight into a BIND-MOUNTED host folder, in
 * a one-shot container on the shared services network. No dump byte passes
 * through Genie.
 *
 * The obvious implementation — `exec` into the engine and capture stdout — is
 * unusable, and quietly so. `seams.ts` builds captured output as
 * `(stdout + chunk).slice(-OUTPUT_TAIL_LIMIT)`, so the result is the LAST 8KB of
 * the dump. That produces a file of plausible shape, a success report, and
 * nothing restorable. `pg_dump --format=custom` is binary as well, which the
 * string conversion would corrupt even under the limit.
 *
 * ## How success is decided
 *
 * By the FINISHED FILE existing — not by an exit code. Every job writes
 * `<name>.part` and renames it (`backup.ts`), so the final name appears only
 * when the dump ran to completion. A killed container, a full disk or a share
 * that went away all leave a `.part`, which this deletes; none of them can leave
 * something a restore would pick up. That is a stronger signal than an exit
 * status, and it is the one that survives the container being torn down.
 *
 * ## Nothing throws
 *
 * The same house rule as the rest of this module: a failure is a RESULT. A
 * backup is often driven by a schedule or an agent, and an exception there is a
 * stack trace where the reason should be.
 */

export interface BackupHostFs {
    ensureDir(path: string): Promise<void>;
    list(path: string): Promise<string[]>;
    remove(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    size(path: string): Promise<number>;
}

export interface BackupRunnerDeps {
    runtime: ContainerRuntime;
    fs: BackupHostFs;
    /** Host path join — `node:path.join` in production, a seam for tests. */
    join: (...parts: string[]) => string;
    platform: NodeJS.Platform | string;
    /** Makes the container name unique. Injected so this module reads no clock. */
    nameSuffix: () => string;
    /** How long one dump gets before it is stopped. */
    timeoutMs?: number;
}

export interface BackupResult {
    engine: string;
    version: string;
    /** Absolute host path of the finished dump. Absent unless `ok`. */
    path?: string;
    bytes?: number;
    ok: boolean;
    error?: string;
    /** Old dumps retention removed. Empty when the dump failed — see below. */
    pruned: string[];
}

/**
 * A dump gets a long time on purpose. A first backup of a real database over a
 * network share legitimately runs for many minutes, and a backup killed halfway
 * is the thing this whole design is arranged to make harmless — but it is still
 * a backup that did not happen, so the ceiling is generous rather than tight.
 */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The tail of the engine's own output — the whole diagnosis when a dump fails. */
function lastLines(log: string, count = 4): string {
    return log
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-count)
        .join(' / ');
}

export async function runBackupJob(
    job: BackupJob,
    root: string,
    deps: BackupRunnerDeps,
    keep: number,
): Promise<BackupResult> {
    const { runtime, fs } = deps;
    const base: Pick<BackupResult, 'engine' | 'version'> = {
        engine: job.engine,
        version: job.version,
    };
    const destDir = deps.join(root, ...job.dir.split('/'));
    const finalPath = deps.join(destDir, job.fileName);
    const partPath = `${finalPath}.part`;

    // MOUNTABILITY FIRST, because it is a pure check and because the answer is
    // most often "no" for exactly the folder the owner wanted: a Windows UNC
    // share. `--mount source=\\nas\backups` is not something the runtime takes,
    // and the fix is a mapped drive rather than anything Genie can do.
    const source = toMountSource(destDir, { platform: deps.platform, kind: runtime.kind });
    if (!source) {
        return {
            ...base,
            ok: false,
            pruned: [],
            error:
                `The backup folder ${destDir} cannot be mounted into a container. ` +
                'A network path has to be mapped to a drive letter (or mounted locally) ' +
                'before a dump can be written to it.',
        };
    }

    try {
        await fs.ensureDir(destDir);
    } catch (e) {
        // Never fall back to another location. A dump that lands somewhere the
        // owner did not choose is a dump nobody finds when it matters.
        return {
            ...base,
            ok: false,
            pruned: [],
            error: `The backup folder ${destDir} could not be created or reached: ${messageOf(e)}`,
        };
    }

    const name = `genie-backup-${job.engine}-${deps.nameSuffix()}`;
    let containerId: string | null = null;
    let log = '';
    try {
        const ref = await runtime.runContainer({
            // MACHINE-scoped, like the engines themselves: a workspace label would
            // put this in reach of `teardownWorkspaceSandbox`.
            workspaceId: null,
            name,
            image: job.image,
            command: job.command,
            // Its HOME is the services network, which is how it reaches the engine
            // by container name — the same surface a workspace's site uses.
            network: SHARED_SERVICES_NETWORK,
            mounts: [{ source, target: job.mountTarget }],
            labels: { [ROLE_LABEL]: 'backup' },
            // Never come back by itself. A dump container that restarted after a
            // reboot would re-run a dump nobody asked for, against whatever the
            // database looks like then.
            restart: 'no',
        });
        containerId = ref.id;

        const handle = runtime.followLogs(ref.id, (chunk) => {
            log += chunk;
        });
        const budget = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([
            handle.exited.then(() => false),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(true), budget);
                timer.unref?.();
            }),
        ]);
        clearTimeout(timer);
        handle.stop();

        if (timedOut) {
            await runtime.stop(ref.id).catch(() => {});
            return {
                ...base,
                ok: false,
                pruned: [],
                error: `The ${job.engine} dump did not finish within ${Math.round(
                    budget / 1000,
                )}s and was stopped.`,
            };
        }
    } catch (e) {
        return { ...base, ok: false, pruned: [], error: `The dump could not run: ${messageOf(e)}` };
    } finally {
        if (containerId) await runtime.remove(containerId).catch(() => {});
    }

    // THE finished file. It exists only because the job renamed `.part` onto it,
    // so this is what "the dump completed" actually means.
    const done = await fs.exists(finalPath).catch(() => false);
    if (!done) {
        // Whatever is left is a partial dump. Take it away rather than leaving
        // something in the folder that looks like a backup from a distance.
        await fs.remove(partPath).catch(() => {});
        const said = lastLines(log || (await runtime.logs(name).catch(() => '')));
        return {
            ...base,
            ok: false,
            pruned: [],
            error: `The ${job.engine} dump wrote no file${said ? `: ${said}` : '.'}`,
        };
    }

    const bytes = await fs.size(finalPath).catch(() => undefined);

    // RETENTION, and only now. Pruning before the dump — or after a failed one —
    // would spend a good backup to make room for one that does not exist.
    const pruned: string[] = [];
    try {
        const names = await fs.list(destDir);
        for (const stale of prunableDumps(names, keep)) {
            await fs.remove(deps.join(destDir, stale));
            pruned.push(stale);
        }
    } catch {
        // A dump that landed is worth more than tidy retention; report the dump.
    }

    return { ...base, ok: true, path: finalPath, ...(bytes ? { bytes } : {}), pruned };
}
