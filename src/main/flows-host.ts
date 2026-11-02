import type { Actor, ArmResult, FlowRecord, FlowRun, FlowStore } from './flow-store.js';
import type { FlowScheduler } from './flow-scheduler.js';
import { schedulesIn } from './flow-store.js';

/**
 * FLOWS, GENIE-HOST'S (the host split, P3.3d: plan §11e). The flows file, the scheduler, the runner and the file triggers
 * live in the host, so an armed flow fires on the host's clock — its prompts reach the host's sessions, its commands the
 * host's supervisor, its tool steps the host's tools — with no window. A window (the canvas editor, the Flows tab, the
 * Deck's "flows running") reads every flow from a replica and edits, arms and runs them through the host.
 */

export interface FlowsDump {
    readonly flows: readonly FlowRecord[];
    readonly inFlight: number;
}

export type FlowsEvent = { readonly kind: 'dump'; readonly dump: FlowsDump } | { readonly kind: 'run'; readonly flowId: string; readonly run: FlowRun };

const WINDOW_CALLS = new Set(['create', 'update', 'arm', 'disarm', 'remove', 'runNow']);

/** The flows as a window, compose and the `flows` tool use them: the store itself, or the host's through the replica. */
export type FlowsApi = Pick<FlowsReplica, 'get' | 'list' | 'schedules' | 'create' | 'update' | 'arm' | 'disarm' | 'remove' | 'onChange' | 'onRun'>;
/** The scheduler as a window uses it: run one now, and how many are running (the Deck's signal). */
export type FlowSchedulerApi = Pick<FlowsReplica, 'runNow' | 'inFlightCount'>;

export class FlowsService {
    #store: FlowStore | null = null;
    #scheduler: FlowScheduler | null = null;
    readonly #listeners = new Set<(event: FlowsEvent) => void>();

    /** Served at once; the flows are attached when they open (genie-host opens them at the first window's v1 import). */
    constructor(parts?: { store: FlowStore; scheduler: FlowScheduler }) {
        if (parts) this.attach(parts);
    }

    attach(parts: { store: FlowStore; scheduler: FlowScheduler }): void {
        this.#store = parts.store;
        this.#scheduler = parts.scheduler;
        parts.store.onChange(() => this.#emit({ kind: 'dump', dump: this.dump() }));
        parts.store.onRun((flowId, run) => this.#emit({ kind: 'run', flowId, run }));
        this.#emit({ kind: 'dump', dump: this.dump() });
    }

    dump(): FlowsDump {
        return { flows: this.#store?.list() ?? [], inFlight: this.#scheduler?.inFlightCount() ?? 0 };
    }

    onEvent(listener: (event: FlowsEvent) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    async call(method: string, args: readonly unknown[]): Promise<unknown> {
        if (!WINDOW_CALLS.has(method)) throw new Error(`a window cannot call flows.${method}`);
        if (!this.#store || !this.#scheduler) throw new Error('the flows are still opening; try again in a moment');
        if (method === 'runNow') return this.#scheduler.runNow(String(args[0]));
        if (method === 'arm' || method === 'disarm' || method === 'remove') {
            if (!this.#store.get(String(args[0]))) throw new Error(`no flow ${String(args[0])}`);
        }
        return (this.#store as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(...args);
    }

    #emit(event: FlowsEvent): void {
        for (const l of [...this.#listeners]) {
            try { l(event); } catch { /* one window's listener never costs another's */ }
        }
    }
}

/** genie-host's flows, as a window reads and drives them (P3.3d). Reads synchronous; every change the host's. */
export class FlowsReplica {
    #dump: FlowsDump = { flows: [], inFlight: 0 };
    readonly #changeListeners = new Set<() => void>();
    readonly #runListeners = new Set<(flowId: string, run: FlowRun) => void>();
    readonly #call: (method: string, args: readonly unknown[]) => Promise<unknown>;

    constructor(call: (method: string, args: readonly unknown[]) => Promise<unknown>) {
        this.#call = call;
    }

    apply(event: FlowsEvent): void {
        if (event.kind === 'dump') {
            this.#dump = event.dump;
            for (const l of [...this.#changeListeners]) l();
            return;
        }
        for (const l of [...this.#runListeners]) l(event.flowId, event.run);
    }

    get(id: string): FlowRecord | null { return this.#dump.flows.find((f) => f.id === id) ?? null; }
    list(workspaceId?: string): FlowRecord[] { return this.#dump.flows.filter((f) => workspaceId === undefined || f.workspaceId === workspaceId); }
    inFlightCount(): number { return this.#dump.inFlight; }
    /** A flow's schedules, read from its document as the store reads them. */
    schedules(id: string): ReturnType<FlowStore['schedules']> { const flow = this.get(id); return flow ? schedulesIn(flow.document) : []; }

    async create(input: { workspaceId: string; name: string; document: unknown; by: Actor; armed?: boolean }): Promise<FlowRecord> { return (await this.#call('create', [input])) as FlowRecord; }
    async update(id: string, patch: { name?: string; document?: unknown }, by: Actor): Promise<FlowRecord> { return (await this.#call('update', [id, patch, by])) as FlowRecord; }
    async arm(id: string, by: Actor): Promise<ArmResult> { return (await this.#call('arm', [id, by])) as ArmResult; }
    async disarm(id: string, by: Actor): Promise<FlowRecord> { return (await this.#call('disarm', [id, by])) as FlowRecord; }
    async remove(id: string): Promise<boolean> { return (await this.#call('remove', [id])) as boolean; }
    async runNow(id: string): Promise<FlowRun> { return (await this.#call('runNow', [id])) as FlowRun; }

    onChange(listener: () => void): () => void {
        this.#changeListeners.add(listener);
        return () => { this.#changeListeners.delete(listener); };
    }

    onRun(listener: (flowId: string, run: FlowRun) => void): () => void {
        this.#runListeners.add(listener);
        return () => { this.#runListeners.delete(listener); };
    }
}
