import { limitRefusal } from '../core/shell-limits.js';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { ProcessLog } from '../core/output-tail.js';
import { runtimeDir } from './paths.js';
import type { ProcessStatus, ProcessSupervisor, RestartPolicy } from './process-supervisor.js';
import { readJson, writeJsonAtomic } from './store.js';
import { planV1ProcessImport } from '../core/v1-processes.js';
import { readV1Processes } from './v1-processes.js';

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
}

/**
 * A row of Hosting → Processes: the supervisor's status, plus what the book knows when it is one the person keeps, plus
 * the last lines of its output when the supervisor has any (feature-ipc.ts adds them; kept after an exit or a crash).
 */
export type HostedProcess = ProcessStatus & { readonly durable?: true; readonly command?: string; readonly log?: ProcessLog };

export interface CreateProcessInput {
    readonly workspaceId: string;
    /** The workspace's folder; the process runs here, or in `folder` inside it. */
    readonly workspacePath: string;
    readonly name: string;
    readonly command: string;
    /** Relative to the workspace (e.g. `repos/app`); empty or absent runs at the workspace root. */
    readonly folder?: string | undefined;
    readonly restart: RestartPolicy;
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

interface BookFile {
    processes: KeptProcess[];
    v1Import?: V1ProcessImportRecord;
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

    private constructor(file: string, deps: ProcessBookDeps, data: BookFile) {
        this.#file = file;
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
        this.#data = data;
    }

    static async open(userData: string, deps: ProcessBookDeps): Promise<ProcessBook> {
        const file = join(runtimeDir(userData), 'processes.json');
        const data = await readJson<BookFile>(file, { processes: [] });
        const v1Import = data.v1Import !== null && typeof data.v1Import === 'object' ? data.v1Import : undefined;
        const book = new ProcessBook(file, deps, { processes: Array.isArray(data.processes) ? data.processes : [], ...(v1Import ? { v1Import } : {}) });
        if (deps.v1) await book.#importFromV1(deps.v1);
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
        const rows: HostedProcess[] = live.map((s) => ({ ...s, durable: true, command: byId.get(s.id)!.command }));
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
            });
        }
        return rows;
    }

    /** At launch: start every process the person wants, except in a hibernated workspace. */
    restore(): { started: string[]; heldBack: string[] } {
        const started: string[] = [];
        const heldBack: string[] = [];
        for (const p of this.#data.processes) {
            if (!p.wanted) continue;
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
        const kept: KeptProcess = { id: `proc_${randomUUID()}`, workspaceId: input.workspaceId, name, command, cwd, restart: input.restart, wanted: true, changedAt: this.#now() };
        this.#data = { ...this.#data, processes: [...this.#data.processes, kept] };
        await this.#flush();
        return this.#run(kept);
    }

    async start(id: string): Promise<ProcessStatus> {
        const p = this.#find(id);
        if (this.#deps.asleep(p.workspaceId)) throw new Error(`cannot start ${p.name}: ${ASLEEP_REASON}`);
        const wanted = await this.#setWanted(id, true);
        return this.#run(wanted);
    }

    /** By hand: stop the current run (if any) and start a new one; the failure count starts over. */
    async restart(id: string): Promise<ProcessStatus> {
        const p = this.#find(id);
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
    }
}

/** The process's folder: the workspace, or a RELATIVE folder that stays inside it. Anything else is refused. */
function folderInside(workspacePath: string, folder: string | undefined): string {
    const f = (folder ?? '').trim();
    if (!f) return workspacePath;
    const refuse = (): never => { throw new Error(`the folder must be inside the workspace (${workspacePath}); "${f}" is not`); };
    if (isAbsolute(f) || /^[a-zA-Z]:/.test(f) || f.startsWith('/') || f.startsWith('\\')) refuse();
    const cwd = normalize(join(workspacePath, f));
    const rel = relative(workspacePath, cwd);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) refuse();
    return cwd;
}
