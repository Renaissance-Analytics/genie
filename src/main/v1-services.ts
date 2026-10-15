import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { planV1ServicesAdoption, V1_LABELS, type InspectedContainer, type V1EngineRow, type V1ServiceRows } from '../core/v1-services.js';
import type { DockerRunner } from './service-driver.js';
import type { ServiceRegistry, V1ServicesImportRecord } from './service-registry.js';
import { writeJsonAtomic } from './store.js';
import { V1_OPEN_OPTIONS } from './v1-settings.js';

/**
 * TAKING OVER GENIE 1's SERVICE ENGINES, AND STOPPING ITS SANDBOXES — the effects. The decisions are
 * core/v1-services.ts's; this reads, asks Docker, applies, and REPORTS.
 *
 * The owner, after the first real upgrade: "the upgrade should have shut down everything that was
 * genie 1 so that everything running was genie 2 and what needed to be migrated, was migrated."
 *
 * - Genie 1's database is read read-only through `node:sqlite`, exactly like `readV1Processes`.
 * - Docker is asked through the same `DockerRunner` the service driver uses (execFile in production,
 *   a fake in tests): `docker ps -a` by Genie 1's labels, then one `docker container inspect`.
 * - Once: recorded in services.json beside the instances (`ServiceRegistry.adoptFromV1`). A boot that
 *   cannot read Genie 1, or whose Docker does not answer, records that PROVISIONALLY and a later boot
 *   still takes over — nothing observed is nothing decided. A pass where a `docker start`/`stop` failed
 *   is not done either: every step is idempotent (an adopted id is not added twice; stopping a stopped
 *   container is a no-op), so the next boot repeats it rather than leaving Genie 1 half running.
 * - Effects: an adopted container that is not running is started; a sandbox or site container has its
 *   restart policy cleared (`unless-stopped` would bring it back with Docker) and is stopped — never
 *   removed, so nothing of Genie 1's is destroyed. Never `create`, `pull`, or `rm`.
 * - The report (`~/.genie/v1-services.json`, beside `v1-reap.json`) says what was adopted, started,
 *   stopped and skipped, and why — and carries no credential.
 */

/** Cannot-see is `null` (no file, not a database, no `dev_service_engines`); the tables with no rows is "measured none". */
export function readV1ServiceRows(dbFile: string): V1ServiceRows | null {
    if (!existsSync(dbFile)) return null;
    let db: DatabaseSync | null = null;
    try {
        db = new DatabaseSync(dbFile, V1_OPEN_OPTIONS);
        const has = (table: string) => db!.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
        if (!has('dev_service_engines') || !has('workspaces')) return null;
        const text = (v: unknown) => (typeof v === 'string' ? v : '');
        const engines: V1EngineRow[] = [];
        for (const row of db.prepare('SELECT key, engine, version, workspace_id, admin_user, admin_password FROM dev_service_engines ORDER BY created_at, rowid').all() as Record<string, unknown>[]) {
            if (typeof row.key !== 'string' || typeof row.engine !== 'string') continue;
            engines.push({ key: row.key, engine: row.engine, version: text(row.version), workspaceId: typeof row.workspace_id === 'string' && row.workspace_id ? row.workspace_id : null, adminUser: text(row.admin_user), adminPassword: text(row.admin_password) });
        }
        const columns = new Set((db.prepare("SELECT name FROM pragma_table_info('workspaces')").all() as { name: unknown }[]).map((c) => c.name));
        const workspaces: { id: string; devServices: string | null }[] = [];
        if (columns.has('dev_services')) {
            for (const row of db.prepare('SELECT id, dev_services FROM workspaces ORDER BY rowid').all() as Record<string, unknown>[]) {
                if (typeof row.id !== 'string') continue;
                workspaces.push({ id: row.id, devServices: typeof row.dev_services === 'string' ? row.dev_services : null });
            }
        }
        const ports: { recordKey: string; portName: string; hostPort: number }[] = [];
        if (has('dev_service_ports')) {
            for (const row of db.prepare('SELECT record_key, port_name, host_port FROM dev_service_ports').all() as Record<string, unknown>[]) {
                const hostPort = Number(row.host_port);
                if (typeof row.record_key !== 'string' || typeof row.port_name !== 'string' || !Number.isInteger(hostPort)) continue;
                ports.push({ recordKey: row.record_key, portName: row.port_name, hostPort });
            }
        }
        return { engines, workspaces, ports };
    } catch {
        return null;
    } finally {
        try { db?.close(); } catch { /* already closed or never opened */ }
    }
}

/** Every container Genie 1 labelled, inspected. `null` = Docker did not answer (absent, daemon down): cannot see. */
export async function observeV1Containers(docker: DockerRunner): Promise<InspectedContainer[] | null> {
    const names = new Set<string>();
    for (const label of [V1_LABELS.service, V1_LABELS.workspace, V1_LABELS.site]) {
        let r: { stdout: string; exitCode: number };
        try { r = await docker(['ps', '-a', '--filter', `label=${label}`, '--format', '{{.Names}}']); } catch { return null; }
        if (r.exitCode !== 0) return null;
        for (const line of r.stdout.split(/\r?\n/)) if (line.trim()) names.add(line.trim());
    }
    if (names.size === 0) return [];
    let r: { stdout: string; exitCode: number };
    try { r = await docker(['container', 'inspect', ...names]); } catch { return null; }
    // A container removed between `ps` and `inspect` makes the exit non-zero while the rest still print: read what printed.
    try {
        const parsed: unknown = JSON.parse(r.stdout);
        return Array.isArray(parsed) ? (parsed as InspectedContainer[]) : null;
    } catch {
        return null;
    }
}

export interface V1ServicesDeps {
    readonly database: string;
    readonly docker: DockerRunner;
    /** Where the report goes: `~/.genie/v1-services.json`. */
    readonly reportFile: string;
    readonly now: () => number;
    /** Genie 2's workspaces: a dedicated engine whose workspace did not come over is left alone. */
    readonly workspaces?: () => readonly { readonly id: string }[];
}

export async function runV1ServicesAdoption(registry: ServiceRegistry, deps: V1ServicesDeps): Promise<void> {
    const prior = registry.v1Import();
    if (prior?.sawV1 === true && prior.sawDocker === true && !prior.failed) return;
    const at = () => new Date(deps.now()).toISOString();
    const provisional = async (record: V1ServicesImportRecord) => {
        // Keep the first blind boot's record: a boot that still cannot see has nothing new to say.
        if (prior && prior.sawV1 === record.sawV1 && prior.sawDocker === record.sawDocker) return;
        await registry.adoptFromV1({ instances: [], record });
    };

    const rows = readV1ServiceRows(deps.database);
    // No Genie 1 to read: Docker is not asked at all.
    if (rows === null) return provisional({ at: at(), sawV1: false, sawDocker: false });
    const observed = await observeV1Containers(deps.docker);
    if (observed === null) {
        console.log("[genie] Genie 1's service engines: Docker did not answer; a later boot takes them over");
        return provisional({ at: at(), sawV1: true, sawDocker: false });
    }
    // An empty list is "not known yet", never "Genie 2 has no workspaces": it must not leave every dedicated engine behind.
    const workspaces = (deps.workspaces?.() ?? []).map((w) => w.id);
    const plan = planV1ServicesAdoption(rows, observed, workspaces.length > 0 ? { workspaces } : {})!;

    const started: { name: string; ok: boolean; output?: string }[] = [];
    for (const name of plan.start) {
        const r = await deps.docker(['start', name]).catch((e: unknown) => ({ stdout: String(e), exitCode: 1 }));
        started.push({ name, ok: r.exitCode === 0, ...(r.exitCode === 0 ? {} : { output: r.stdout.trim() }) });
    }
    const stopped: { name: string; why: string; ok: boolean; output?: string }[] = [];
    for (const { name, why } of plan.stop) {
        // Restart policy FIRST: Genie 1 ran these `unless-stopped`, and a Docker restart between the two calls would revive them.
        const update = await deps.docker(['update', '--restart=no', name]).catch((e: unknown) => ({ stdout: String(e), exitCode: 1 }));
        const r = await deps.docker(['stop', name]).catch((e: unknown) => ({ stdout: String(e), exitCode: 1 }));
        const ok = update.exitCode === 0 && r.exitCode === 0;
        stopped.push({ name, why, ok, ...(ok ? {} : { output: [update.stdout, r.stdout].map((s) => s.trim()).filter(Boolean).join(' | ') }) });
    }

    const have = new Set(registry.list().map((i) => i.id));
    const alreadyHere = plan.adopt.filter((i) => have.has(i.id)).length;
    const failed = started.filter((s) => !s.ok).length + stopped.filter((s) => !s.ok).length;
    const done = await registry.adoptFromV1({
        instances: plan.adopt,
        record: {
            at: at(),
            sawV1: true,
            sawDocker: true,
            adopted: plan.adopt.length - alreadyHere,
            alreadyHere,
            started: started.filter((s) => s.ok).length,
            stopped: stopped.filter((s) => s.ok).length,
            skipped: plan.skipped.length,
            // Not done while a Genie 1 container is still up that should not be: the next boot tries again (every step is idempotent).
            ...(failed > 0 ? { failed } : {}),
        },
    });

    const report = {
        at: at(),
        // Names, ports, volumes and workspaces — never a password.
        adopted: plan.adopt.map((i) => ({ id: i.id, engine: i.engine, version: i.version, container: i.containerName, image: i.image ?? null, volume: i.volume ?? null, scope: i.scope, ports: i.publishedPorts ?? {}, workspaces: Object.keys(i.slices ?? {}) })),
        alreadyHere: done.alreadyHere,
        started,
        stopped,
        skipped: plan.skipped,
    };
    await writeJsonAtomic(deps.reportFile, report);
    console.log(`[genie] Genie 1's service engines: ${done.adopted} taken over (${done.alreadyHere} already here), ${started.filter((s) => s.ok).length} started, ${stopped.filter((s) => s.ok).length} of Genie 1's sandbox/site containers stopped, ${plan.skipped.length} skipped${failed ? `; ${failed} docker call(s) FAILED — see ${deps.reportFile}` : ''}`);
}
