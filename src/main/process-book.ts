import { limitRefusal } from '../core/shell-limits.js';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, normalize } from 'node:path';
import { confinePathSync, OutsideWorkspaceError } from './workspace-confine.js';
import type { ProcessLog } from '../core/output-tail.js';
import { runtimeDir } from './paths.js';
import type { ProcessStatus, ProcessSupervisor, RestartPolicy } from './process-supervisor.js';
import { readJson, writeJsonAtomic } from './store.js';
import { planV1ProcessImport } from '../core/v1-processes.js';
import { readV1Processes } from './v1-processes.js';
import { nextCronAfter } from '../core/cron.js';
import { scheduleProblem, type LastRunStatus, type ProcessSchedule, type ScheduleKind } from '../core/scheduled-task.js';
import { planV1ScheduleImport } from '../core/v1-schedules.js';
import { readV1Schedules } from './v1-schedules.js';
import { scheduledTaskFromFlow } from './scheduled-tasks-move.js';

/**
 * THE BACKGROUND PROCESSES THE PERSON KEEPS (§6.6) — written down, and brought back on launch.
 *
 * The supervisor runs processes; it remembers nothing past a restart, and that is right for what
 * it runs on behalf of others (a site's server is restarted by its site, the front door by the
 * composition root). A process the PERSON added — a queue worker, a watcher, a dev server — is
 * different: Genie 1 kept these (terminal_specs of type 'process') and started them on every
 * launch, and Genie 2 had nowhere to add one and nothing to bring it back.
 *
 * ## One flag is the person's intent
 *
 * `wanted` is set by add / start / restart and cleared by the person's stop. Genie's own quit
 * stops the supervisor's processes directly and never touches this book, so a quit is not a stop:
 * what was running comes back. What the person stopped stays stopped — through restarts and
 * upgrades — and is still LISTED as stopped, never silently dropped. Remove forgets it.
 *
 * ## Nothing starts in a hibernated workspace
 *
 * The restore skips a hibernated workspace's processes and says so on the row; a start there is
 * refused with the same reason.
 *
 * The env is read at every start (`envFor`), so an engine added since the process was written
 * down reaches it on the next launch. No agent field exists here, as in `ProcessSpec`.
 *
 * ## A scheduled task is a kept process with a schedule (genie#1204)
 *
 * Genie 1's model (main/terminal/process-scheduler.ts at v0.7.0-beta.342; the owner, 2026-10-26: "a scheduled command is a
 * BG Process in a workspace, just with a schedule"): `schedule` holds the cron and what a fire does — run the command, or
 * nudge an agent. Such a process is never started at launch and never restarted: the schedule decides (process-scheduler.ts
 * runs it, one-shot). For it `wanted` is whether the schedule is ENABLED (Genie 1's "Scheduled") or PAUSED ("Paused — not
 * firing"); Genie 1's scheduled tasks are imported here, paused.
 */

export interface KeptProcess {
    readonly id: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly command: string;
    readonly cwd: string;
    readonly restart: RestartPolicy;
    /** The person's intent: true after add/start/restart, false after their stop. */
    readonly wanted: boolean;
    /** When `wanted` last changed (ms since epoch) — the `since` of a row that is not running. */
    readonly changedAt: number;
    /** A SCHEDULED TASK (genie#1204): its schedule; `wanted` is then whether the schedule is enabled. */
    readonly schedule?: ProcessSchedule;
}

/** A scheduled task as Hosting → Processes and the agents' `processes list` show it. */
export type ScheduleView = ProcessSchedule & { readonly enabled: boolean; readonly nextRunAt: number | null };

/**
 * A row of Hosting → Processes: the supervisor's status, plus what the book knows when it is one the person keeps, plus
 * the last lines of its output when the supervisor has any (feature-ipc.ts adds them; kept after an exit or a crash).
 */
export type HostedProcess = ProcessStatus & { readonly durable?: true; readonly command?: string; readonly log?: ProcessLog; readonly schedule?: ScheduleView };

export interface CreateProcessInput {
    readonly workspaceId: string;
    /** The workspace's folder; the process runs here, or in `folder` inside it. */
    readonly workspacePath: string;
    readonly name: string;
    readonly command: string;
    /** Relative to the workspace (e.g. `repos/app`); empty or absent runs at the workspace root. */
    readonly folder?: string | undefined;
    readonly restart: RestartPolicy;
    /** A scheduled task (genie#1204): kept, not started; its schedule fires it. An agent-nudge needs no command. */
    readonly schedule?: { readonly cron: string; readonly kind: ScheduleKind; readonly prompt?: string | undefined; readonly agent?: string | undefined } | undefined;
    /** A scheduled task's schedule starts enabled unless this is false. */
    readonly enabled?: boolean | undefined;
}

/** One scheduled task to keep as given (the move out of Flows, genie#1204) — upserted by id. */
export interface AdoptedSchedule {
    readonly id: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly command: string;
    readonly cwd: string;
    readonly wanted: boolean;
    readonly schedule: ProcessSchedule;
}

export interface ProcessBookDeps {
    readonly supervisor: Pick<ProcessSupervisor, 'start' | 'stop' | 'forget' | 'list'>;
    /** The workspace's service env (its engines plus the shared ones), read at every start. */
    readonly envFor: (workspaceId: string) => Readonly<Record<string, string>>;
    /** Hibernated (§6.1): nothing may start there. */
    readonly asleep: (workspaceId: string) => boolean;
    /** The workspace's background-process limit (core/shell-limits.ts), read live; absent = no limit. */
    readonly limit?: (workspaceId: string) => number;
    readonly now?: () => number;
    /** Genie 1's database and Genie 2's workspaces: the book imports v1's background processes ONCE when it opens. */
    readonly v1?: {
        readonly database: string;
        readonly workspaces: () => readonly { readonly id: string; readonly path: string }[];
        /** Genie 2's roster: whom a Genie 1 agent-nudge task prompts (core/v1-schedules.ts). Absent = none. */
        readonly roster?: () => readonly { readonly workspaceId: string; readonly provider: string; readonly name: string }[];
    };
}

/** What the v1 import did, kept IN processes.json — the store it filled — so "once" and the processes cannot disagree. */
export interface V1ProcessImportRecord {
    readonly at: string;
    /** false = the boot could not see v1's database: provisional, a later boot that can see it still imports. */
    readonly sawV1: boolean;
    readonly imported?: number;
    readonly wanted?: number;
    /** v1 processes whose id was already kept here — left exactly as they were. */
    readonly alreadyHere?: number;
    /** What was not imported, or could not be carried, and why (core/v1-processes.ts). */
    readonly notes?: readonly string[];
}

/** What the import of Genie 1's SCHEDULED TASKS did (genie#1204), kept in processes.json like the processes' own. */
export interface V1ScheduleImportRecord {
    readonly at: string;
    readonly sawV1: boolean;
    readonly imported?: number;
    readonly alreadyHere?: number;
    readonly notes?: readonly string[];
}

/** The marker of the one move of earlier betas' scheduled tasks out of Flows (scheduled-tasks-move.ts). */
export interface ScheduledTasksMovedRecord {
    readonly at: string;
    readonly moved: number;
    readonly kept: readonly string[];
}

interface BookFile {
    processes: KeptProcess[];
    v1Import?: V1ProcessImportRecord;
    v1ScheduleImport?: V1ScheduleImportRecord;
    scheduledTasksMoved?: ScheduledTasksMovedRecord;
}

const RESTART_POLICIES: readonly RestartPolicy[] = ['never', 'on-failure', 'always'];
const ASLEEP_REASON = 'its workspace is hibernated; nothing starts there until it is woken';

export class ProcessBook {
    readonly #file: string;
    readonly #deps: ProcessBookDeps;
    readonly #now: () => number;
    #data: BookFile;
    /** Rows held back by the restore, with why. Cleared when the row next starts. */
    readonly #heldBack = new Map<string, string>();
    /** Told after every write — the process scheduler re-plans (genie#1204). */
    readonly #listeners = new Set<() => void>();

    private constructor(file: string, deps: ProcessBookDeps, data: BookFile) {
        this.#file = file;
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
        this.#data = data;
    }

    static async open(userData: string, deps: ProcessBookDeps): Promise<ProcessBook> {
        const file = join(runtimeDir(userData), 'processes.json');
        const data = await readJson<BookFile>(file, { processes: [] });
        const object = <T>(v: T | undefined): T | undefined => (v !== null && typeof v === 'object' ? v : undefined);
        const v1Import = object(data.v1Import);
        const v1ScheduleImport = object(data.v1ScheduleImport);
        const scheduledTasksMoved = object(data.scheduledTasksMoved);
        const book = new ProcessBook(file, deps, {
            processes: Array.isArray(data.processes) ? data.processes : [],
            ...(v1Import ? { v1Import } : {}),
            ...(v1ScheduleImport ? { v1ScheduleImport } : {}),
            ...(scheduledTasksMoved ? { scheduledTasksMoved } : {}),
        });
        if (deps.v1) {
            await book.#importFromV1(deps.v1);
            await book.#importSchedulesFromV1(deps.v1);
        }
        return book;
    }

    /**
     * GENIE 1's BACKGROUND PROCESSES, ONCE (core/v1-processes.ts plans them). "Once" is recorded in this
     * file, in the same write as the processes, so an import that saw v1 is never repeated: a process the
     * person removed, stopped or changed in Genie 2 stays as they left it. A boot that could not see v1
     * records that provisionally and a later boot that can see it imports. An id already kept is left
     * alone. Nothing is started here — `restore()` does that, holding back hibernated workspaces.
     */
    async #importFromV1(v1: NonNullable<ProcessBookDeps['v1']>): Promise<void> {
        const prior = this.#data.v1Import;
        if (prior?.sawV1 === true) return;
        const plan = planV1ProcessImport(readV1Processes(v1.database), v1.workspaces());
        if (plan === null) {
            if (prior) return; // already provisional: keep the first blind boot's record
            this.#data = { ...this.#data, v1Import: { at: new Date(this.#now()).toISOString(), sawV1: false } };
            await this.#flush();
            return;
        }
        const have = new Set(this.#data.processes.map((p) => p.id));
        const changedAt = this.#now();
        const fresh: KeptProcess[] = plan.processes.filter((p) => !have.has(p.id)).map((p) => ({ ...p, changedAt }));
        const record: V1ProcessImportRecord = {
            at: new Date(changedAt).toISOString(),
            sawV1: true,
            imported: fresh.length,
            wanted: fresh.filter((p) => p.wanted).length,
            alreadyHere: plan.processes.length - fresh.length,
            notes: plan.notes,
        };
        this.#data = { ...this.#data, processes: [...this.#data.processes, ...fresh], v1Import: record };
        await this.#flush();
        console.log(`[genie] v1 background processes: ${record.imported} imported (${record.wanted} to start), ${record.alreadyHere} already here${plan.notes.length ? `; ${plan.notes.length} noted: ${plan.notes.join(' | ')}` : ''}`);
    }

    /**
     * GENIE 1's SCHEDULED TASKS, ONCE (genie#1204), as scheduled processes, PAUSED: an import is not the person deciding
     * to run something on a clock. Planned by core/v1-schedules.ts (which notes what was firing and everything it left
     * behind, with why); "once" is recorded here in the same write, provisional while v1 cannot be seen; an id already kept
     * is left exactly as it is.
     */
    async #importSchedulesFromV1(v1: NonNullable<ProcessBookDeps['v1']>): Promise<void> {
        const prior = this.#data.v1ScheduleImport;
        if (prior?.sawV1 === true) return;
        const workspaces = v1.workspaces();
        const plan = planV1ScheduleImport(readV1Schedules(v1.database), { workspaces, roster: v1.roster?.() ?? [] });
        const at = new Date(this.#now()).toISOString();
        if (plan === null) {
            if (prior) return;
            this.#data = { ...this.#data, v1ScheduleImport: { at, sawV1: false } };
            await this.#flush();
            return;
        }
        const have = new Set(this.#data.processes.map((p) => p.id));
        const notes = [...plan.notes];
        const fresh: KeptProcess[] = [];
        let alreadyHere = 0;
        for (const planned of plan.flows) {
            const id = `proc_v1_${planned.v1SpecId}`;
            if (have.has(id)) { alreadyHere += 1; continue; }
            const path = workspaces.find((w) => w.id === planned.workspaceId)?.path ?? null;
            const task = path === null ? null : scheduledTaskFromFlow(planned.document, planned.workspaceId, path);
            if (task === null || !task.ok) {
                notes.push(`"${planned.name}" (v1 task ${planned.v1SpecId}): ${task && !task.ok ? task.why : 'its workspace is not in Genie 2'}; not imported`);
                continue;
            }
            fresh.push({ id, workspaceId: planned.workspaceId, name: planned.name, command: task.command, cwd: task.cwd, restart: 'never', wanted: false, changedAt: this.#now(), schedule: task.schedule });
        }
        this.#data = { ...this.#data, processes: [...this.#data.processes, ...fresh], v1ScheduleImport: { at, sawV1: true, imported: fresh.length, alreadyHere, notes } };
        await this.#flush();
        console.log(`[genie] v1 scheduled tasks: ${fresh.length} imported as paused scheduled processes, ${alreadyHere} already here${notes.length ? `; ${notes.length} noted: ${notes.join(' | ')}` : ''}`);
    }

    /** Told after every change — the process scheduler re-plans on it. */
    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    /** Every kept scheduled task (genie#1204). */
    scheduledTasks(): readonly KeptProcess[] {
        return this.#data.processes.filter((p) => p.schedule !== undefined);
    }

    /** The person's (or an agent's approved) Enable schedule: it fires from its next due. */
    async enableSchedule(id: string): Promise<void> {
        this.#scheduled(id);
        await this.#setWanted(id, true);
    }

    /** Pause schedule: it stops firing; it is still kept, and Run now still runs it. */
    async pauseSchedule(id: string): Promise<void> {
        this.#scheduled(id);
        await this.#setWanted(id, false);
    }

    /** What one fire (or Run now) of a scheduled task came to. */
    async recordScheduledRun(id: string, at: number, status: LastRunStatus): Promise<void> {
        const p = this.#data.processes.find((x) => x.id === id);
        if (!p?.schedule) return;
        const next: KeptProcess = { ...p, schedule: { ...p.schedule, lastRunAt: at, lastRunStatus: status } };
        this.#data = { ...this.#data, processes: this.#data.processes.map((x) => (x.id === id ? next : x)) };
        await this.#flush();
    }

    /** Keep these scheduled tasks as given, replacing one already kept under the same id (the move out of Flows). */
    async adoptScheduled(entries: readonly AdoptedSchedule[]): Promise<void> {
        if (entries.length === 0) return;
        const byId = new Map(entries.map((e) => [e.id, e]));
        const changedAt = this.#now();
        const kept = (e: AdoptedSchedule): KeptProcess => ({ id: e.id, workspaceId: e.workspaceId, name: e.name, command: e.command, cwd: e.cwd, restart: 'never', wanted: e.wanted, changedAt, schedule: e.schedule });
        const replaced = this.#data.processes.map((p) => (byId.has(p.id) ? kept(byId.get(p.id)!) : p));
        const added = entries.filter((e) => !this.#data.processes.some((p) => p.id === e.id)).map(kept);
        this.#data = { ...this.#data, processes: [...replaced, ...added] };
        await this.#flush();
    }

    /** The move out of Flows' marker, or undefined before it ran. */
    scheduledTasksMoved(): ScheduledTasksMovedRecord | undefined {
        return this.#data.scheduledTasksMoved;
    }

    async markScheduledTasksMoved(record: ScheduledTasksMovedRecord): Promise<void> {
        this.#data = { ...this.#data, scheduledTasksMoved: record };
        await this.#flush();
    }

    #scheduled(id: string): KeptProcess {
        const p = this.#find(id);
        if (!p.schedule) throw new Error(`${p.name} has no schedule — it runs as a service (start / stop)`);
        return p;
    }

    #scheduleView(p: KeptProcess): ScheduleView | undefined {
        if (!p.schedule) return undefined;
        const live = p.wanted && !this.#deps.asleep(p.workspaceId);
        return { ...p.schedule, enabled: p.wanted, nextRunAt: live ? nextCronAfter(p.schedule.cron, this.#now(), undefined) : null };
    }

    owns(id: string): boolean {
        return this.#data.processes.some((p) => p.id === id);
    }

    kept(): readonly KeptProcess[] {
        return this.#data.processes;
    }

    /**
     * Every supervised process, with the kept ones marked; a kept process the supervisor is not
     * running (stopped by the person, or held back) is listed as `stopped` rather than dropped.
     */
    list(workspaceId?: string): HostedProcess[] {
        const byId = new Map(this.#data.processes.map((p) => [p.id, p]));
        // THE BOOK'S OWN, ONLY (the owner, 2026-10-21: sites showing in the background-process list — "they are two
        // different things"). The supervisor also runs every site's server, worker and dev server and the front door; those
        // are listed and controlled as SITES, never here, where a Stop or Restart would act on a site behind its back.
        const live = this.#deps.supervisor.list(workspaceId).filter((s) => byId.has(s.id));
        const withSchedule = (p: KeptProcess) => { const v = this.#scheduleView(p); return v ? { schedule: v } : {}; };
        const rows: HostedProcess[] = live.map((s) => ({ ...s, durable: true, command: byId.get(s.id)!.command, ...withSchedule(byId.get(s.id)!) }));
        const seen = new Set(live.map((s) => s.id));
        for (const p of this.#data.processes) {
            if (seen.has(p.id) || (workspaceId !== undefined && p.workspaceId !== workspaceId)) continue;
            const reason = this.#heldBack.get(p.id);
            rows.push({
                id: p.id,
                workspaceId: p.workspaceId,
                name: p.name,
                state: 'stopped',
                pid: null,
                exitCode: null,
                restarts: 0,
                since: p.changedAt,
                ...(reason === undefined ? {} : { reason }),
                durable: true,
                command: p.command,
                ...withSchedule(p),
            });
        }
        return rows;
    }

    /** At launch: start every process the person wants, except in a hibernated workspace. */
    restore(): { started: string[]; heldBack: string[] } {
        const started: string[] = [];
        const heldBack: string[] = [];
        for (const p of this.#data.processes) {
            // A scheduled task is never brought back as a running process: its schedule fires it (process-scheduler.ts).
            if (!p.wanted || p.schedule) continue;
            if (this.#deps.asleep(p.workspaceId)) {
                this.#heldBack.set(p.id, ASLEEP_REASON);
                heldBack.push(p.id);
                continue;
            }
            // Past the workspace's limit (it may have been lowered since): held back, with the limit's own words.
            const refused = this.#refusal(p.workspaceId, p.id);
            if (refused) {
                this.#heldBack.set(p.id, refused);
                heldBack.push(p.id);
                continue;
            }
            this.#run(p);
            started.push(p.id);
        }
        return { started, heldBack };
    }

    /**
     * What `create` would keep, or the refusal it would throw — checked WITHOUT keeping or starting anything, so an agent's
     * `processes add` that Genie would refuse is never put to the person for approval (mcp-tools-processes.ts).
     */
    prepare(input: CreateProcessInput): { readonly name: string; readonly command: string; readonly cwd: string; readonly restart: RestartPolicy } {
        const name = input.name.trim();
        const command = input.command.trim();
        if (!name) throw new Error('a background process needs a name');
        if (input.schedule) {
            // A scheduled task (genie#1204): what could never fire is refused before anything is kept — or asked.
            const problem = scheduleProblem(input.schedule, command);
            if (problem) throw new Error(problem);
            return { name, command, cwd: folderInside(input.workspacePath, input.folder), restart: 'never' };
        }
        if (!command) throw new Error('a background process needs a command to run');
        if (!RESTART_POLICIES.includes(input.restart)) throw new Error(`restart must be one of ${RESTART_POLICIES.join(', ')}`);
        const cwd = folderInside(input.workspacePath, input.folder);
        if (this.#deps.asleep(input.workspaceId)) throw new Error(`cannot start ${name}: ${ASLEEP_REASON}`);
        const refused = this.#refusal(input.workspaceId, null);
        if (refused) throw new Error(refused);
        return { name, command, cwd, restart: input.restart };
    }

    /** Validate, write it down as wanted, then start it. A refusal throws with the reason and keeps nothing. */
    async create(input: CreateProcessInput): Promise<ProcessStatus> {
        const { name, command, cwd } = this.prepare(input);
        if (input.schedule) {
            const s = input.schedule;
            const schedule: ProcessSchedule = { cron: s.cron.trim(), kind: s.kind, ...(s.kind === 'agent-nudge' ? { prompt: s.prompt!.trim(), agent: s.agent!.trim() } : {}) };
            const kept: KeptProcess = { id: `proc_${randomUUID()}`, workspaceId: input.workspaceId, name, command, cwd, restart: 'never', wanted: input.enabled !== false, changedAt: this.#now(), schedule };
            this.#data = { ...this.#data, processes: [...this.#data.processes, kept] };
            await this.#flush();
            // Kept, not started: its schedule fires it.
            return { id: kept.id, workspaceId: kept.workspaceId, name, state: 'stopped', pid: null, exitCode: null, restarts: 0, since: kept.changedAt };
        }
        const kept: KeptProcess = { id: `proc_${randomUUID()}`, workspaceId: input.workspaceId, name, command, cwd, restart: input.restart, wanted: true, changedAt: this.#now() };
        this.#data = { ...this.#data, processes: [...this.#data.processes, kept] };
        await this.#flush();
        return this.#run(kept);
    }

    async start(id: string): Promise<ProcessStatus> {
        const p = this.#find(id);
        if (p.schedule) throw new Error(`${p.name} is a scheduled task: it runs on its schedule (Run now runs it once)`);
        if (this.#deps.asleep(p.workspaceId)) throw new Error(`cannot start ${p.name}: ${ASLEEP_REASON}`);
        const wanted = await this.#setWanted(id, true);
        return this.#run(wanted);
    }

    /** By hand: stop the current run (if any) and start a new one; the failure count starts over. */
    async restart(id: string): Promise<ProcessStatus> {
        const p = this.#find(id);
        if (p.schedule) throw new Error(`${p.name} is a scheduled task: it runs on its schedule (Run now runs it once)`);
        if (this.#deps.asleep(p.workspaceId)) throw new Error(`cannot restart ${p.name}: ${ASLEEP_REASON}`);
        const wanted = await this.#setWanted(id, true);
        this.#deps.supervisor.stop(id);
        return this.#run(wanted);
    }

    /** The person's stop: written down first, so it holds through a restart even if the kill is the last thing that happens. */
    async stop(id: string): Promise<void> {
        await this.#setWanted(id, false);
        this.#heldBack.delete(id);
        this.#deps.supervisor.stop(id);
    }

    async remove(id: string): Promise<void> {
        this.#find(id);
        this.#deps.supervisor.forget(id);
        this.#heldBack.delete(id);
        this.#data = { ...this.#data, processes: this.#data.processes.filter((p) => p.id !== id) };
        await this.#flush();
    }

    /**
     * THE WORKSPACE'S LIMIT (beta.33; the owner: "we have too many running shells"): why one more would be refused — the
     * limit and what is running — or `null`. `self` is the process being started again, which is not counted against itself.
     */
    #refusal(workspaceId: string, self: string | null): string | null {
        if (!this.#deps.limit) return null;
        const running = this.#deps.supervisor.list(workspaceId).filter((s) => s.id !== self && (s.state === 'running' || s.state === 'restarting'));
        return limitRefusal('processes', this.#deps.limit(workspaceId), running.map((s) => s.name));
    }

    #run(p: KeptProcess): ProcessStatus {
        const refused = this.#refusal(p.workspaceId, p.id);
        if (refused) throw new Error(refused);
        this.#heldBack.delete(p.id);
        const env = this.#deps.envFor(p.workspaceId);
        return this.#deps.supervisor.start({
            id: p.id,
            workspaceId: p.workspaceId,
            name: p.name,
            command: p.command,
            cwd: p.cwd,
            restart: p.restart,
            ...(Object.keys(env).length > 0 ? { env: { ...env } } : {}),
        });
    }

    #find(id: string): KeptProcess {
        const p = this.#data.processes.find((x) => x.id === id);
        if (!p) throw new Error(`no background process ${id}`);
        return p;
    }

    async #setWanted(id: string, wanted: boolean): Promise<KeptProcess> {
        const p = this.#find(id);
        const next: KeptProcess = { ...p, wanted, changedAt: this.#now() };
        this.#data = { ...this.#data, processes: this.#data.processes.map((x) => (x.id === id ? next : x)) };
        await this.#flush();
        return next;
    }

    async #flush(): Promise<void> {
        await writeJsonAtomic(this.#file, this.#data);
        for (const l of this.#listeners) l();
    }
}

/** The process's folder: the workspace, or a RELATIVE folder that stays inside it. Anything else is refused. */
function folderInside(workspacePath: string, folder: string | undefined): string {
    const f = (folder ?? '').trim();
    if (!f) return workspacePath;
    const refuse = (): never => { throw new Error(`the folder must be inside the workspace (${workspacePath}); "${f}" is not`); };
    if (isAbsolute(f) || /^[a-zA-Z]:/.test(f) || f.startsWith('/') || f.startsWith('\\')) refuse();
    // The SHARED check (genie#1354, workspace-confine.ts): lexical, then after links — a symlink or junction inside the
    // workspace that leads out of it is refused, not started in.
    try {
        confinePathSync(workspacePath, f, 'nothing was started', { allowRoot: true });
    } catch (error) {
        if (error instanceof OutsideWorkspaceError) refuse();
        throw error;
    }
    // The folder as the workspace's path names it (kept and shown as written, not resolved onto a drive).
    return normalize(join(workspacePath, f));
}
