import { randomUUID } from 'node:crypto';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { runtimeDir } from './paths.js';
import type { ProcessStatus, ProcessSupervisor, RestartPolicy } from './process-supervisor.js';
import { readJson, writeJsonAtomic } from './store.js';

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

/** A row of Hosting → Processes: the supervisor's status, plus what the book knows when it is one the person keeps. */
export type HostedProcess = ProcessStatus & { readonly durable?: true; readonly command?: string };

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
    readonly now?: () => number;
}

interface BookFile {
    processes: KeptProcess[];
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
        return new ProcessBook(file, deps, { processes: Array.isArray(data.processes) ? data.processes : [] });
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
        const live = this.#deps.supervisor.list(workspaceId);
        const rows: HostedProcess[] = live.map((s) => {
            const kept = byId.get(s.id);
            return kept ? { ...s, durable: true, command: kept.command } : s;
        });
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
            this.#run(p);
            started.push(p.id);
        }
        return { started, heldBack };
    }

    /** Validate, write it down as wanted, then start it. A refusal throws with the reason and keeps nothing. */
    async create(input: CreateProcessInput): Promise<ProcessStatus> {
        const name = input.name.trim();
        const command = input.command.trim();
        if (!name) throw new Error('a background process needs a name');
        if (!command) throw new Error('a background process needs a command to run');
        if (!RESTART_POLICIES.includes(input.restart)) throw new Error(`restart must be one of ${RESTART_POLICIES.join(', ')}`);
        const cwd = folderInside(input.workspacePath, input.folder);
        if (this.#deps.asleep(input.workspaceId)) throw new Error(`cannot start ${name}: ${ASLEEP_REASON}`);
        const kept: KeptProcess = { id: `proc_${randomUUID()}`, workspaceId: input.workspaceId, name, command, cwd, restart: input.restart, wanted: true, changedAt: this.#now() };
        this.#data = { processes: [...this.#data.processes, kept] };
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
        this.#data = { processes: this.#data.processes.filter((p) => p.id !== id) };
        await this.#flush();
    }

    #run(p: KeptProcess): ProcessStatus {
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
        this.#data = { processes: this.#data.processes.map((x) => (x.id === id ? next : x)) };
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
