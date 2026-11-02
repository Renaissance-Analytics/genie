import type { CreateProcessInput, HostedProcess, KeptProcess, ProcessBook } from './process-book.js';
import type { ProcessScheduler, RunNowResult } from './process-scheduler.js';
import type { ProcessStatus, RestartPolicy } from './process-supervisor.js';

/**
 * THE PROCESS BOOK AND ITS SCHEDULER, GENIE-HOST'S (the host split, P3.3c: plan §11e). What the person keeps running is
 * written down, restored and started by the host — on the host's supervisor (P3.3b) — and a scheduled task fires on the
 * host's clock with no window. A window lists and manages them through `ProcessBookReplica`: the list is the host's,
 * pushed on every change (the book's or a process's), and every action is the host's, answered in its words.
 */

export interface ProcessesDump {
    readonly list: readonly HostedProcess[];
    readonly kept: readonly KeptProcess[];
}

const WINDOW_CALLS = new Set(['prepare', 'create', 'start', 'restart', 'stop', 'remove', 'enableSchedule', 'pauseSchedule', 'runNow']);

type ProcessesParts = { book: ProcessBook; scheduler?: ProcessScheduler | null; supervisor?: { onChange(listener: (status: ProcessStatus) => void): () => void } };

export class ProcessesService {
    #book: ProcessBook | null = null;
    #scheduler: ProcessScheduler | null = null;
    readonly #listeners = new Set<(dump: ProcessesDump) => void>();

    /** Served at once; the book is attached when it opens (genie-host opens it at the first window's v1 import). */
    constructor(parts?: ProcessesParts) {
        if (parts) this.attach(parts);
    }

    attach(parts: ProcessesParts): void {
        this.#book = parts.book;
        this.#scheduler = parts.scheduler ?? null;
        parts.book.onChange(() => this.#emit());
        // A kept process's state (running, crashed, restarting) is part of its row: pushed as the supervisor changes it.
        parts.supervisor?.onChange((status) => { if (this.#book?.owns(status.id)) this.#emit(); });
        this.#emit();
    }

    dump(): ProcessesDump {
        return this.#book ? { list: this.#book.list(), kept: this.#book.kept() } : { list: [], kept: [] };
    }

    onEvent(listener: (dump: ProcessesDump) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    async call(method: string, args: readonly unknown[]): Promise<unknown> {
        if (!WINDOW_CALLS.has(method)) throw new Error(`a window cannot call processes.${method}`);
        if (!this.#book) throw new Error('the process book is still opening; try again in a moment');
        if (method === 'runNow') {
            if (!this.#scheduler) throw new Error('this Genie runs no scheduled tasks');
            return this.#scheduler.runNow(String(args[0]));
        }
        return (this.#book as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(...args);
    }

    #emit(): void {
        const dump = this.dump();
        for (const l of [...this.#listeners]) {
            try { l(dump); } catch { /* one window's listener never costs another's */ }
        }
    }
}

/**
 * The process book as the window, its Processes view and the `processes` tool use it (P3.3c): genie-host's through the
 * replica, or the book itself on the emergency path. `prepare` answers later from the host.
 */
export type ProcessBookApi = Pick<ProcessBookReplica, 'list' | 'owns' | 'create' | 'start' | 'restart' | 'stop' | 'remove' | 'enableSchedule' | 'pauseSchedule' | 'onChange'> & {
    prepare(input: CreateProcessInput): ReturnType<ProcessBook['prepare']> | Promise<ReturnType<ProcessBook['prepare']>>;
};

/** The host's process book, as a window lists and manages it (P3.3c). Reads synchronous; every action the host's. */
export class ProcessBookReplica {
    #dump: ProcessesDump = { list: [], kept: [] };
    readonly #listeners = new Set<() => void>();
    readonly #call: (method: string, args: readonly unknown[]) => Promise<unknown>;

    constructor(call: (method: string, args: readonly unknown[]) => Promise<unknown>) {
        this.#call = call;
    }

    rebase(dump: ProcessesDump): void {
        this.#dump = dump;
        for (const l of [...this.#listeners]) l();
    }

    list(workspaceId?: string): HostedProcess[] {
        return this.#dump.list.filter((p) => workspaceId === undefined || p.workspaceId === workspaceId);
    }

    kept(): readonly KeptProcess[] { return this.#dump.kept; }
    owns(id: string): boolean { return this.#dump.kept.some((p) => p.id === id); }

    async prepare(input: CreateProcessInput): Promise<{ readonly name: string; readonly command: string; readonly cwd: string; readonly restart: RestartPolicy }> {
        return (await this.#call('prepare', [input])) as { name: string; command: string; cwd: string; restart: RestartPolicy };
    }
    async create(input: CreateProcessInput): Promise<ProcessStatus> { return (await this.#call('create', [input])) as ProcessStatus; }
    async start(id: string): Promise<ProcessStatus> { return (await this.#call('start', [id])) as ProcessStatus; }
    async restart(id: string): Promise<ProcessStatus> { return (await this.#call('restart', [id])) as ProcessStatus; }
    async stop(id: string): Promise<void> { await this.#call('stop', [id]); }
    async remove(id: string): Promise<void> { await this.#call('remove', [id]); }
    async enableSchedule(id: string): Promise<void> { await this.#call('enableSchedule', [id]); }
    async pauseSchedule(id: string): Promise<void> { await this.#call('pauseSchedule', [id]); }
    async runNow(id: string): Promise<RunNowResult> { return (await this.#call('runNow', [id])) as RunNowResult; }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }
}
