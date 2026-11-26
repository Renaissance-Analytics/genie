import { compareVersions } from './drone-version.js';
import type { ProviderHealth } from './provider-health.js';
import type { RepairOutcome } from './toolchain.js';

/**
 * DUE UPDATES AT HOST START, BEFORE ANYTHING ELSE (Tynn #1067; the owner, 2026-11-26: "the genie should be handling cli
 * upgrades automatically on startup before any other processes start happening"). Pure; genie-host supplies the ports.
 *
 * At boot no agent is running yet, so a provider CLI's update replaces nothing in use — the one moment it can be applied
 * with no drain at all. genie-host runs these before it composes hosting (sites), opens its process book (kept processes,
 * schedules) and its flows, and before it serves a window (which starts agents). Each step is said through `progress` (a
 * file any waiting window reads) and the lifecycle log.
 *
 * THE LIMIT: the host is never held forever. Finding what is due counts against it too (an offline check). At the limit the
 * host starts as usual and the log says so; the step that was running is left to its own limit, and its end is logged.
 */

export const STARTUP_UPDATES_LIMIT_MS = 180_000;

export interface StartupProgress {
    readonly step: string;
    readonly startedAt: number;
    readonly limitMs: number;
}

export interface StartupUpdateTask {
    readonly label: string;
    /** Resolves to what it did, in words; throws with why it did not. `say` is the task's own step. */
    run(say: (step: string) => void): Promise<string>;
}

export interface StartupUpdatePorts {
    readonly tasks: () => Promise<readonly StartupUpdateTask[]>;
    readonly progress: (state: StartupProgress | null) => void;
    readonly log: (line: string) => void;
    readonly now: () => number;
}

export interface StartupUpdatesReport {
    readonly ran: readonly { readonly label: string; readonly words: string }[];
    readonly failed: readonly { readonly label: string; readonly reason: string }[];
    /** The step that was running when the limit was reached; `null` = everything finished in time. */
    readonly timedOut: string | null;
    readonly ms: number;
}

/** The x.y.z a CLI's `--version` printed (`2.1.0 (Claude Code)`, `codex-cli 0.40.0`); `null` when there is none. */
export function cliVersion(text: string | null): string | null {
    return text?.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0] ?? null;
}

/** Due = it runs, its version is known, and the latest is newer. Anything unknown is not due: a start never guesses. */
export function cliUpdateDue(health: ProviderHealth | null, latest: string | null): boolean {
    if (!health?.installed || latest === null) return false;
    const installed = cliVersion(health.version);
    const newest = cliVersion(latest);
    return installed !== null && newest !== null && compareVersions(installed, newest) < 0;
}

export interface StartupTaskPorts {
    readonly providers: readonly { readonly provider: string; readonly label: string; readonly npmPackage: string }[];
    readonly check: (provider: string) => Promise<ProviderHealth | null>;
    /** The newest published version of the CLI's npm package (the vendor publishes each release there). */
    readonly latest: (npmPackage: string) => Promise<string | null>;
    readonly update: (provider: string, progress: (step: string | null) => void) => Promise<RepairOutcome | { readonly kind: 'refused'; readonly reason: string }>;
    /** PHP's live patch source (php-live): applies the security patches due within each installed line. Absent = not in this build. */
    readonly php?: (progress: (step: string | null) => void) => Promise<{ readonly updated: readonly string[]; readonly failed: readonly { readonly version: string; readonly reason: string }[] }>;
}

/** The start's tasks: one per CLI whose update is due (checked side by side), then PHP's patches when the hook is there. */
export async function startupTasks(ports: StartupTaskPorts): Promise<StartupUpdateTask[]> {
    const due = await Promise.all(ports.providers.map(async (p) => {
        try {
            const [health, latest] = await Promise.all([ports.check(p.provider), ports.latest(p.npmPackage)]);
            return cliUpdateDue(health, latest) ? { ...p, from: cliVersion(health!.version)!, to: cliVersion(latest)! } : null;
        } catch {
            return null;
        }
    }));
    const tasks: StartupUpdateTask[] = [];
    for (const d of due) {
        if (d === null) continue;
        tasks.push({
            label: `Updating ${d.label} ${d.from} → ${d.to}`,
            run: async (say) => {
                const outcome = await ports.update(d.provider, (step) => { if (step) say(step); });
                if (outcome.kind !== 'repaired') throw new Error(outcome.reason);
                return `${d.label} ${outcome.from ?? d.from} → ${outcome.to}`;
            },
        });
    }
    const php = ports.php;
    if (php) {
        tasks.push({
            label: 'Applying PHP security updates',
            run: async (say) => {
                const r = await php((step) => { if (step) say(step); });
                if (r.failed.length > 0) throw new Error(`${r.failed.map((f) => `${f.version}: ${f.reason}`).join('; ')}${r.updated.length > 0 ? ` (updated: ${r.updated.join(', ')})` : ''}`);
                return r.updated.length > 0 ? `PHP updated: ${r.updated.join(', ')}` : 'PHP: nothing due';
            },
        });
    }
    return tasks;
}

const why = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Run the start's updates within `limitMs`. Never throws; resolves at the latest at the limit. */
export function runStartupUpdates(ports: StartupUpdatePorts, limitMs: number = STARTUP_UPDATES_LIMIT_MS): Promise<StartupUpdatesReport> {
    const startedAt = ports.now();
    let closed = false;
    let current = 'Checking for tool updates';
    // What the limit names: the task, never its sub-step (`Updating Claude Code …`, not the installer's line).
    let task = current;
    const ran: { label: string; words: string }[] = [];
    const failed: { label: string; reason: string }[] = [];
    const say = (step: string): void => {
        current = step;
        if (closed) return;
        try { ports.progress({ step, startedAt, limitMs }); } catch { /* a window that cannot be told never holds the start */ }
    };
    const clear = (): void => { try { ports.progress(null); } catch { /* as above */ } };
    const log = (line: string): void => { try { ports.log(line); } catch { /* as above */ } };
    log(`startup updates: begin limit=${Math.round(limitMs / 1000)}s`);

    return new Promise<StartupUpdatesReport>((resolve) => {
        const finish = (timedOut: string | null): void => {
            if (closed) return;
            closed = true;
            clearTimeout(timer);
            clear();
            const report = { ran: [...ran], failed: [...failed], timedOut, ms: ports.now() - startedAt };
            if (timedOut === null) log(`startup updates: done ms=${report.ms} ran=${ran.length} failed=${failed.length}`);
            else log(`startup updates: time limit ${Math.round(limitMs / 1000)}s reached during "${timedOut}"; starting as usual`);
            resolve(report);
        };
        // An elapsed timer, as the host-update drain's bound: a wall-clock correction cannot lengthen the wait.
        const timer = setTimeout(() => finish(task), limitMs);
        void (async () => {
            say(current);
            let tasks: readonly StartupUpdateTask[] = [];
            try { tasks = await ports.tasks(); } catch (error) { log(`startup updates: what is due could not be read: ${why(error)}`); }
            for (const t of tasks) {
                task = t.label;
                say(t.label);
                try {
                    // A step that only repeats the task's own words (`Updating Claude Code`) adds nothing to it.
                    const words = await t.run((step) => say(t.label.startsWith(step) ? t.label : `${t.label}: ${step}`));
                    ran.push({ label: t.label, words });
                    log(closed ? `startup updates: after the limit: ${t.label}: ${words}` : `startup update: ${t.label}: ${words}`);
                } catch (error) {
                    failed.push({ label: t.label, reason: why(error) });
                    log(closed ? `startup updates: after the limit: ${t.label} failed: ${why(error)}` : `startup update failed: ${t.label}: ${why(error)}`);
                }
            }
            finish(null);
        })();
    });
}
