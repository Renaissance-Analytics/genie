import { serviceContainerNameFor } from '../argv';
import { engineKeyFor, engineSpecFor, workspaceSqlIdentifier } from './catalog';
import { backupJobsFor, resolveBackupSettings } from './backup';
import type { BackupJob, BackupOverride, BackupSettings, DumpTarget } from './backup';
import type { BackupResult } from './backup-runner';
import type { DevServices } from './services-config';

/**
 * One GApp's backup (Tynn #250, step 4) — settings and stored services in,
 * dumps out.
 *
 * PURE apart from the injected `run`, so the decisions can be read without a
 * container runtime: which engines are dumpable, where the dumps go, and what
 * the app is told afterwards.
 *
 * ## Two ways a backup lies, and what is done about each
 *
 * **Dumping an engine that is not up.** The connection fails, and the report is
 * a database error rather than "that engine was not running". So only engines
 * the manager currently reports as live become targets — a stopped engine is a
 * gap in the backup set, and it is named as one.
 *
 * **Omitting an engine nothing can dump.** A GApp keeping real state in Redis
 * gets a backup set with no Redis in it, and nobody finds out until a restore.
 * So {@link AppBackupRun.notCovered} names every live engine no dump exists for,
 * every time, rather than leaving the absence to be inferred from a list.
 */

export interface AppBackupInput {
    app: { slug: string; workspaceId: string };
    /** This workstation, for the first path segment — see `backup.ts`. */
    machine: string;
    /** Injected, so nothing here reads a clock. */
    at: Date;
    settings: BackupSettings;
    override: BackupOverride | null;
    /** The app workspace's STORED service definitions — where the credential is. */
    services: DevServices;
    /** Service ids the manager reports as live right now. */
    running: ReadonlySet<string>;
}

export interface AppBackupRun {
    ok: boolean;
    /** Set when nothing ran at all, with the reason a person can act on. */
    skipped?: string;
    /** The folder the dumps went to. */
    dir?: string;
    results: BackupResult[];
    /** Live engines this app uses that no dump covers — `redis 7`, `minio latest`. */
    notCovered: string[];
}

/** The port a connection is made on — the catalog marks exactly one per engine. */
function primaryPortOf(spec: ReturnType<typeof engineSpecFor>): number {
    return (spec.ports.find((p) => p.primary) ?? spec.ports[0])?.container ?? 0;
}

/**
 * The engines holding this app's data, as dump targets.
 *
 * Built from the STORED definition rather than the live status because that is
 * where the workspace's credential lives, and from the same derivations the
 * manager uses — `serviceContainerNameFor`, `workspaceSqlIdentifier` — so a
 * dump can never address a container the manager did not create.
 */
export function dumpTargetsFor(input: AppBackupInput): DumpTarget[] {
    const targets: DumpTarget[] = [];
    for (const [serviceId, config] of Object.entries(input.services)) {
        if (!config.enabled || !input.running.has(serviceId)) continue;
        const spec = engineSpecFor(config.engine);
        const dedicated = config.dedicated || Boolean(spec.alwaysDedicated);
        const engineKey = engineKeyFor(config.engine, config.version);
        targets.push({
            engine: config.engine,
            version: config.version,
            image: config.engine === 'custom' ? config.image ?? '' : spec.image(config.version),
            host: serviceContainerNameFor(engineKey, dedicated ? input.app.workspaceId : undefined),
            port: primaryPortOf(spec),
            slice: {
                identifier: workspaceSqlIdentifier(input.app.workspaceId),
                password: config.password,
            },
        });
    }
    return targets;
}

export type RunJob = (job: BackupJob, root: string, keep: number) => Promise<BackupResult>;

/** Never throws — a backup is driven by a schedule or an agent, and an exception
 *  there is a stack trace where the reason should be. */
export async function backupApp(input: AppBackupInput, run: RunJob): Promise<AppBackupRun> {
    const resolved = resolveBackupSettings(input.settings, input.override);
    const targets = dumpTargetsFor(input);
    const jobs = backupJobsFor({
        appSlug: input.app.slug,
        machine: input.machine,
        at: input.at,
        targets,
    });

    // Live engines with no job — the gap that must be stated rather than inferred.
    const covered = new Set(jobs.map((j) => `${j.engine} ${j.version}`));
    const notCovered = targets
        .map((t) => `${t.engine} ${t.version}`)
        .filter((name) => !covered.has(name));

    if (!resolved.enabled) {
        return {
            ok: true,
            skipped:
                resolved.reason ??
                'Backups are turned off for this app (or for this workstation).',
            notCovered,
            results: [],
        };
    }

    if (!jobs.length) {
        return {
            ok: true,
            skipped: targets.length
                ? `Nothing to back up: this app's live engines (${notCovered.join(', ')}) have no dump yet.`
                : 'Nothing to back up: this app has no live database engine.',
            dir: resolved.dir,
            notCovered,
            results: [],
        };
    }

    const results: BackupResult[] = [];
    for (const job of jobs) {
        try {
            results.push(await run(job, resolved.dir, resolved.keep));
        } catch (e) {
            results.push({
                engine: job.engine,
                version: job.version,
                ok: false,
                pruned: [],
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }

    // One failed dump means the SET is not a backup of this app. Reporting `ok`
    // because most of it worked is how a partial restore gets discovered late.
    return {
        ok: results.every((r) => r.ok),
        dir: resolved.dir,
        notCovered,
        results,
    };
}
