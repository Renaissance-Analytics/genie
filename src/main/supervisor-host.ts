import { OutputTail, type ProcessLog } from '../core/output-tail.js';
import type { ProcessSpec, ProcessStatus, ProcessSupervisor } from './process-supervisor.js';

/**
 * THE PROCESS SUPERVISOR, GENIE-HOST'S (the host split, P3.3b: plan §11e, decision 1a). Sites' servers, queue workers,
 * kept processes and the front door run under the host's supervisor, so its restart policy keeps them alive — and its
 * logs keep their output — with the UI closed. A window drives it through `SupervisorReplica`: the statuses, the commands
 * and the log tails are sent when it connects and followed after; start, stop, restart and forget are the host's.
 */

export interface SupervisorDump {
    readonly statuses: readonly ProcessStatus[];
    readonly commands: Readonly<Record<string, string>>;
    readonly logs: Readonly<Record<string, string>>;
}

export type SupervisorEvent =
    | { readonly kind: 'status'; readonly status: ProcessStatus; readonly command: string | null }
    | { readonly kind: 'output'; readonly id: string; readonly data: string }
    | { readonly kind: 'forgotten'; readonly id: string };

/** What a window may ask of the host's supervisor. */
const WINDOW_CALLS = new Set(['start', 'stop', 'restart', 'forget']);

export class SupervisorService {
    readonly #supervisor: ProcessSupervisor;
    readonly #listeners = new Set<(event: SupervisorEvent) => void>();

    constructor(supervisor: ProcessSupervisor) {
        this.#supervisor = supervisor;
        supervisor.onChange((status) => this.#emit({ kind: 'status', status, command: supervisor.command(status.id) ?? null }));
        supervisor.onOutput((id, data) => this.#emit({ kind: 'output', id, data }));
    }

    get supervisor(): ProcessSupervisor {
        return this.#supervisor;
    }

    dump(): SupervisorDump {
        const statuses = this.#supervisor.list();
        return {
            statuses,
            commands: Object.fromEntries(statuses.map((s) => [s.id, this.#supervisor.command(s.id) ?? ''])),
            logs: Object.fromEntries(statuses.map((s) => [s.id, this.#supervisor.log(s.id) ?? ''])),
        };
    }

    onEvent(listener: (event: SupervisorEvent) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    call(method: string, args: readonly unknown[]): unknown {
        if (!WINDOW_CALLS.has(method)) throw new Error(`a window cannot call supervisor.${method}`);
        const s = this.#supervisor;
        switch (method) {
            case 'start': return s.start(args[0] as ProcessSpec);
            case 'stop': return s.stop(String(args[0]));
            case 'restart': return s.restart(String(args[0]));
            default: {
                const id = String(args[0]);
                const forgotten = s.forget(id);
                if (forgotten) this.#emit({ kind: 'forgotten', id });
                return forgotten;
            }
        }
    }

    #emit(event: SupervisorEvent): void {
        for (const l of [...this.#listeners]) {
            try { l(event); } catch { /* one window's listener never costs another's */ }
        }
    }
}

/**
 * THE HOST'S SUPERVISOR, AS A WINDOW DRIVES IT (P3.3b). Synchronous like the supervisor itself — `list`, `status`,
 * `readLog` read the replica; `start`, `stop`, `restart`, `forget` answer from it at once and the host decides, its
 * answer arriving as the next status. A start the host has not answered yet reads `restarting`, never `running`.
 */
export class SupervisorReplica {
    /** Tests-first removal notification seam (#633); the implementation follows measured RED. */
    onForget(_listener: (id: string) => void): () => void { return () => {}; }

    readonly #statuses = new Map<string, ProcessStatus>();
    readonly #commands = new Map<string, string>();
    readonly #logs = new Map<string, OutputTail>();
    readonly #changeListeners = new Set<(status: ProcessStatus) => void>();
    readonly #outputListeners = new Set<(id: string, data: string) => void>();
    readonly #call: (method: string, args: readonly unknown[]) => Promise<unknown>;
    readonly #now: () => number;

    constructor(call: (method: string, args: readonly unknown[]) => Promise<unknown>, now: () => number = Date.now) {
        this.#call = call;
        this.#now = now;
    }

    rebase(dump: SupervisorDump): void {
        this.#statuses.clear();
        this.#commands.clear();
        this.#logs.clear();
        for (const s of dump.statuses) {
            this.#statuses.set(s.id, s);
            this.#commands.set(s.id, dump.commands[s.id] ?? '');
            const tail = new OutputTail();
            const text = dump.logs[s.id] ?? '';
            if (text) tail.append(text);
            this.#logs.set(s.id, tail);
        }
        for (const s of this.#statuses.values()) for (const l of [...this.#changeListeners]) l(s);
    }

    apply(event: SupervisorEvent): void {
        if (event.kind === 'status') {
            this.#statuses.set(event.status.id, event.status);
            if (event.command !== null) this.#commands.set(event.status.id, event.command);
            if (!this.#logs.has(event.status.id)) this.#logs.set(event.status.id, new OutputTail());
            for (const l of [...this.#changeListeners]) l(event.status);
            return;
        }
        if (event.kind === 'output') {
            let tail = this.#logs.get(event.id);
            if (!tail) { tail = new OutputTail(); this.#logs.set(event.id, tail); }
            tail.append(event.data);
            for (const l of [...this.#outputListeners]) l(event.id, event.data);
            return;
        }
        this.#statuses.delete(event.id);
        this.#commands.delete(event.id);
        this.#logs.delete(event.id);
    }

    start(spec: ProcessSpec): ProcessStatus {
        void this.#call('start', [spec]).catch(() => {});
        const known = this.#statuses.get(spec.id);
        if (known && known.state === 'running') return known;
        this.#commands.set(spec.id, spec.command);
        return { id: spec.id, workspaceId: spec.workspaceId, name: spec.name, state: 'restarting', pid: null, exitCode: null, restarts: known?.restarts ?? 0, since: this.#now(), reason: 'starting in genie-host' };
    }

    stop(id: string): boolean {
        if (!this.#statuses.has(id)) return false;
        void this.#call('stop', [id]).catch(() => {});
        return true;
    }

    restart(id: string): ProcessStatus | null {
        const known = this.#statuses.get(id);
        if (!known) return null;
        void this.#call('restart', [id]).catch(() => {});
        return known;
    }

    forget(id: string): boolean {
        if (!this.#statuses.has(id)) return false;
        void this.#call('forget', [id]).catch(() => {});
        return true;
    }

    status(id: string): ProcessStatus | null {
        return this.#statuses.get(id) ?? null;
    }

    list(workspaceId?: string): ProcessStatus[] {
        const all = [...this.#statuses.values()];
        return workspaceId === undefined ? all : all.filter((s) => s.workspaceId === workspaceId);
    }

    command(id: string): string | undefined {
        return this.#commands.get(id);
    }

    log(id: string): string | undefined {
        return this.readLog(id)?.text;
    }

    readLog(id: string, lines?: number): ProcessLog | null {
        const tail = this.#logs.get(id);
        return tail ? tail.read(lines) : null;
    }

    /** Liveness is checked where the processes are: in the host. */
    recheck(): string[] { return []; }
    watchLiveness(): () => void { return () => {}; }

    onChange(listener: (status: ProcessStatus) => void): () => void {
        this.#changeListeners.add(listener);
        return () => { this.#changeListeners.delete(listener); };
    }

    onOutput(listener: (id: string, data: string) => void): () => void {
        this.#outputListeners.add(listener);
        return () => { this.#outputListeners.delete(listener); };
    }
}
