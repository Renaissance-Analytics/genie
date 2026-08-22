import { assertSliceIdentifier, assertSlicePassword } from './provision';

/**
 * PURE. Backing up a GApp's data (Tynn #250, step 4) — what runs, and where it
 * lands.
 *
 * The owner's ask, in his words, is a configurable backup "settable at the
 * workstation level with a per-GApp override (where db dumps land, etc)",
 * pointable at a shared folder. So the two decisions this module makes are
 * exactly those: which settings win, and what path a dump gets.
 *
 * ## Why the dump never passes through Genie
 *
 * The obvious implementation is `exec` into the engine and capture stdout. It is
 * wrong twice over. `CommandResult.stdout` is built as
 * `(stdout + chunk).slice(-OUTPUT_TAIL_LIMIT)` (`seams.ts`), so a captured dump
 * is silently TRUNCATED TO ITS LAST 8KB — a backup that reports success and
 * cannot be restored, which is the worst failure shape there is. And the string
 * conversion is lossy for `pg_dump`'s custom format, which is binary.
 *
 * So a backup runs in a ONE-SHOT container with the destination folder
 * BIND-MOUNTED, and the engine's own tool writes the file directly. No dump byte
 * ever reaches Node, there is no size ceiling, and the format stays binary-exact.
 *
 * ## Why the file is renamed into place
 *
 * Every job writes `<name>.part` and `mv`s it on success. A dump interrupted by
 * a killed container, a full disk or a network share going away leaves a `.part`
 * that no restore will ever pick up, instead of a truncated file that looks
 * exactly like a good one. That matters most in the case the owner asked for —
 * a shared folder — where the write can fail for reasons nothing here can see.
 *
 * ## Why the machine is the first path segment
 *
 * Because "point it at a shared folder" means two workstations may write to one
 * place. Separate roots keep their dumps apart, and — the part that would
 * actually lose data — keep RETENTION from pruning dumps this machine did not
 * write. {@link prunableDumps} adds the second guard: it only ever proposes
 * files matching Genie's own dump name.
 *
 * ## What is NOT backed up, said plainly
 *
 * Postgres and MySQL, and nothing else yet. Redis is a cache with no per-user
 * dump; Mailpit holds caught mail; Meilisearch dumps are engine-wide rather than
 * per-index. MinIO is the real gap and the obvious next step — the workspace's
 * own credential can already `mc mirror` its bucket into a mount — but a mirror
 * is not a snapshot, so it needs a retention story that is not "keep the last N
 * copies of every object". Better to name the gap than to ship a half-backup
 * someone counts on.
 */

// --- settings ---------------------------------------------------------------

/** The WORKSTATION default — one setting for the machine. */
export interface BackupSettings {
    enabled: boolean;
    /** Absolute host path. A network share or a synced folder is the point. */
    dir: string;
    /** How many dumps to keep per app, per engine version. */
    keep: number;
}

/**
 * One GApp's override. Every field optional, and resolved PER FIELD: an app that
 * wants a different folder should not have to restate retention to get one.
 */
export interface BackupOverride {
    enabled?: boolean;
    dir?: string;
    keep?: number;
}

/** Which level decided a field — so a settings page can say "workstation default"
 *  instead of showing a value with no provenance. */
export type BackupSource = 'workstation' | 'app';

export interface ResolvedBackup {
    enabled: boolean;
    dir: string;
    keep: number;
    from: { enabled: BackupSource; dir: BackupSource; keep: BackupSource };
    /** Set when `enabled` came out false for a reason worth showing. */
    reason?: string;
}

/** Fewest dumps that can be kept. Zero means "delete the one you just wrote". */
const MIN_KEEP = 1;

/** An absolute POSIX path, or an absolute Windows one. A relative path lands
 *  wherever the process happened to be, which for a desktop app is nowhere
 *  anybody will look again. */
function isAbsolute(dir: string): boolean {
    return dir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(dir) || dir.startsWith('\\\\');
}

export function resolveBackupSettings(
    workstation: BackupSettings,
    override: BackupOverride | null,
): ResolvedBackup {
    const appDir = override?.dir?.trim();
    const useAppDir = Boolean(appDir && isAbsolute(appDir));
    const dir = useAppDir ? appDir! : workstation.dir.trim();

    const appKeep = override?.keep;
    const useAppKeep = typeof appKeep === 'number' && Number.isFinite(appKeep);
    const keep = Math.max(MIN_KEEP, Math.floor(useAppKeep ? appKeep! : workstation.keep));

    const useAppEnabled = typeof override?.enabled === 'boolean';
    const enabled = useAppEnabled ? override!.enabled! : workstation.enabled;

    const from = {
        enabled: (useAppEnabled ? 'app' : 'workstation') as BackupSource,
        dir: (useAppDir ? 'app' : 'workstation') as BackupSource,
        keep: (useAppKeep ? 'app' : 'workstation') as BackupSource,
    };

    // No folder anywhere ⇒ OFF, and say so. Inventing a location would put the
    // dumps somewhere the owner never asked for and would never think to look.
    if (!dir) {
        return {
            enabled: false,
            dir: '',
            keep,
            from,
            reason: 'No backup folder is set, so there is nowhere for a dump to land.',
        };
    }

    return { enabled, dir, keep, from };
}

// --- reading what was stored ------------------------------------------------

/**
 * A week of dumps by default. Long enough that a problem noticed on Monday can
 * be rolled back to Friday, short enough that a database nobody thought about
 * does not quietly fill a disk.
 */
export const DEFAULT_KEEP = 7;

function asRecord(raw: string | null | undefined): Record<string, unknown> | null {
    if (!raw?.trim()) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/**
 * The workstation setting, from the blob `db.ts` persisted.
 *
 * Anything unreadable — hand-edited, half-written, from a newer Genie — lands on
 * the DEFAULTS rather than on "off". The failure mode of a bad parse must be
 * "backs up to the usual place", never "silently stopped backing up".
 *
 * `defaults.dir` is Genie's own data folder, supplied by the shell because only
 * the shell knows it. Configuring this setting is how the owner points it
 * somewhere else — a shared folder being the case that motivated it.
 */
export function parseBackupSettings(
    raw: string | null | undefined,
    defaults: { dir: string },
): BackupSettings {
    const parsed = asRecord(raw);
    const dir = typeof parsed?.dir === 'string' && parsed.dir.trim() ? parsed.dir.trim() : defaults.dir;
    const keep =
        typeof parsed?.keep === 'number' && Number.isFinite(parsed.keep)
            ? Math.max(MIN_KEEP, Math.floor(parsed.keep))
            : DEFAULT_KEEP;
    const enabled = typeof parsed?.enabled === 'boolean' ? parsed.enabled : true;
    return { enabled, dir, keep };
}

/**
 * One app's override, or `null` when it has none.
 *
 * A field that is absent stays ABSENT — never coerced to `false` or to a number.
 * `resolveBackupSettings` reads presence to decide which level won, so an app
 * that set only a folder would otherwise have its backups turned off by the act
 * of choosing where they go.
 */
export function parseBackupOverride(raw: string | null | undefined): BackupOverride | null {
    const parsed = asRecord(raw);
    if (!parsed) return null;
    const override: BackupOverride = {};
    if (typeof parsed.enabled === 'boolean') override.enabled = parsed.enabled;
    if (typeof parsed.dir === 'string' && parsed.dir.trim()) override.dir = parsed.dir.trim();
    if (typeof parsed.keep === 'number' && Number.isFinite(parsed.keep)) {
        override.keep = Math.floor(parsed.keep);
    }
    return Object.keys(override).length ? override : null;
}

// --- jobs -------------------------------------------------------------------

/** One live engine holding a slice of this app's data. */
export interface DumpTarget {
    engine: string;
    version: string;
    /** The engine's own image — see {@link backupJobsFor} for why it matters. */
    image: string;
    /** The engine's CONTAINER name. A dump container on the services network
     *  reaches it by that, never by a published loopback port. */
    host: string;
    port: number;
    slice: { identifier: string; password: string };
}

export interface BackupJob {
    engine: string;
    version: string;
    image: string;
    /** Relative to the configured backup root. */
    dir: string;
    fileName: string;
    /** Literal argv for the one-shot dump container. */
    command: string[];
    /** Where the destination directory is bind-mounted inside that container. */
    mountTarget: string;
}

/** Where the destination folder appears inside the dump container. */
const MOUNT_TARGET = '/genie-backup';

/** `20260822T010203Z` — sortable as text, which is what makes retention a sort. */
function stampOf(at: Date): string {
    return `${at.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

/** A path segment safe on every filesystem, from a name that is not. */
function segment(value: string): string {
    return (
        value
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60) || 'unnamed'
    );
}

/** Dumps THIS module wrote. Retention proposes nothing else — see the header. */
const DUMP_NAME = /^\d{8}T\d{6}Z\.(dump|sql)$/;

function postgresCommand(target: DumpTarget, fileName: string): string[] {
    const user = assertSliceIdentifier(target.slice.identifier);
    const password = assertSlicePassword(target.slice.password);
    const out = `${MOUNT_TARGET}/${fileName}`;
    // `--format=custom` because it is what `pg_restore` takes selectively, and it
    // compresses. `--no-owner`/`--no-acl` so a restore into a differently-named
    // role (a reinstalled app gets a new workspace id) is not a fight.
    return [
        'sh',
        '-c',
        `pg_dump --format=custom --no-owner --no-acl --file=${out}.part ` +
            `"postgresql://${user}:${password}@${target.host}:${target.port}/${user}" ` +
            `&& mv ${out}.part ${out}`,
    ];
}

function mysqlCommand(target: DumpTarget, fileName: string): string[] {
    const user = assertSliceIdentifier(target.slice.identifier);
    const password = assertSlicePassword(target.slice.password);
    const out = `${MOUNT_TARGET}/${fileName}`;
    // `--single-transaction` so the dump is consistent without locking a database
    // the app is still serving from; `--result-file` so no shell redirection is
    // involved in the part that carries the data.
    return [
        'sh',
        '-c',
        `mysqldump --host=${target.host} --port=${target.port} --user=${user} ` +
            `--password=${password} --single-transaction --routines --events ` +
            `--result-file=${out}.part ${user} && mv ${out}.part ${out}`,
    ];
}

/**
 * The dump jobs for one app's live engines.
 *
 * Each job runs the ENGINE'S OWN image rather than a generic client, because
 * `pg_dump` refuses a server newer than itself: the version that wrote the data
 * is the only version guaranteed able to dump it, and it is already on the
 * machine. `mysqldump` is laxer but gets the same treatment for the same reason.
 *
 * An engine with no dump story produces NO job rather than a job that quietly
 * does nothing — a backup set that silently omits an engine is how someone finds
 * out during a restore.
 */
export function backupJobsFor(input: {
    appSlug: string;
    machine: string;
    /** Injected, never read from the clock in here — this stays pure. */
    at: Date;
    targets: readonly DumpTarget[];
}): BackupJob[] {
    const stamp = stampOf(input.at);
    const root = `${segment(input.machine)}/${segment(input.appSlug)}`;
    const jobs: BackupJob[] = [];

    for (const target of input.targets) {
        const dir = `${root}/${segment(target.engine)}-${target.version}`;
        if (target.engine === 'postgres') {
            const fileName = `${stamp}.dump`;
            jobs.push({
                engine: target.engine,
                version: target.version,
                image: target.image,
                dir,
                fileName,
                command: postgresCommand(target, fileName),
                mountTarget: MOUNT_TARGET,
            });
        } else if (target.engine === 'mysql') {
            const fileName = `${stamp}.sql`;
            jobs.push({
                engine: target.engine,
                version: target.version,
                image: target.image,
                dir,
                fileName,
                command: mysqlCommand(target, fileName),
                mountTarget: MOUNT_TARGET,
            });
        }
    }

    return jobs;
}

// --- retention --------------------------------------------------------------

/**
 * Which dumps in one folder to delete, oldest first.
 *
 * Two guards, and both matter because this folder is meant to be a SHARED one.
 * Only names matching {@link DUMP_NAME} are ever proposed, so someone else's
 * file — a manual export, a note, a `.DS_Store` — is not counted and not
 * deleted. And a `.part` is left alone: those belong to a job in flight, or to
 * one that died, and the runner is what decides their fate.
 *
 * The names sort as text because {@link stampOf} is fixed-width and big-endian,
 * which is the entire reason for that format.
 */
export function prunableDumps(names: readonly string[], keep: number): string[] {
    const mine = names.filter((name) => DUMP_NAME.test(name)).sort();
    const surplus = mine.length - Math.max(MIN_KEEP, Math.floor(keep));
    return surplus > 0 ? mine.slice(0, surplus) : [];
}
