import { heldRows, rowsPatch, type AgentPushPayload, type HeldRows } from '../core/agent-push-wire.js';
import { Coalescer } from '../core/coalesce.js';

export interface AgentPushPorts<D extends { readonly rows: readonly R[] }, R> {
    /** The agent's detail now; `null` = no such agent. */
    detailFor(agentId: string): D | null;
    /** To the window, on the agent's own channel. */
    send(agentId: string, payload: AgentPushPayload<Omit<D, 'rows'>, R>): void;
    schedule(ms: number, fn: () => void): () => void;
    now(): number;
}

/** At most this often per agent: twenty a second still reads as live text, and costs a fraction of a core. */
export const AGENT_PUSH_INTERVAL_MS = 50;

/**
 * WHAT MAIN PUSHES TO THE WINDOW WHEN AN AGENT CHANGES (the owner, 2026-10-20: "severe UI lag like 3 seconds to show any
 * text at all and a whole minute plus to render an FTQ").
 *
 * It used to build the agent's whole detail — its ledger of thousands of rows included — and send it, on EVERY event of
 * EVERY agent, whether or not the window was showing that agent. Now:
 *
 *  - **only what the window watches** — the preload says which agents it shows (`watch`); nothing is built or sent for
 *    the others. A new watcher is sent the whole ledger at once;
 *  - **coalesced** — at most one push per agent per `AGENT_PUSH_INTERVAL_MS`, the first at once and the last carrying the
 *    latest state (core/coalesce.ts);
 *  - **only the rows that changed** — a patch against the window's last push (core/agent-push-wire.ts), which the
 *    preload applies before the renderer sees a whole detail as it always has.
 */
export class AgentPush<D extends { readonly rows: readonly R[] }, R> {
    readonly #ports: AgentPushPorts<D, R>;
    readonly #watched = new Set<string>();
    /** What the window holds per agent: the push it applied last. */
    readonly #held = new Map<string, HeldRows<R>>();
    #seq = 0;
    readonly #coalescer: Coalescer<string>;

    constructor(ports: AgentPushPorts<D, R>) {
        this.#ports = ports;
        this.#coalescer = new Coalescer<string>({ intervalMs: AGENT_PUSH_INTERVAL_MS, flush: (id) => this.#push(id), schedule: ports.schedule, now: ports.now });
    }

    /** The window shows this agent (`true`) or no longer does (`false`). Watching starts with the whole ledger. */
    watch(agentId: string, on: boolean): void {
        // Either way the window holds nothing for it now: a patch would have nothing to apply to.
        this.#held.delete(agentId);
        this.#coalescer.forget(agentId);
        if (!on) {
            this.#watched.delete(agentId);
            return;
        }
        this.#watched.add(agentId);
        this.#coalescer.request(agentId);
    }

    /** The agent changed. */
    changed(agentId: string): void {
        if (this.#watched.has(agentId)) this.#coalescer.request(agentId);
    }

    /** Stop: nothing waiting is sent (a quit). */
    stop(): void {
        this.#coalescer.stop();
    }

    #push(agentId: string): void {
        if (!this.#watched.has(agentId)) return;
        const detail = this.#ports.detailFor(agentId);
        const rows = detail?.rows ?? [];
        const seq = ++this.#seq;
        const patch = rowsPatch(this.#held.get(agentId) ?? null, rows);
        this.#held.set(agentId, heldRows(seq, rows));
        let rest: Omit<D, 'rows'> | null = null;
        if (detail !== null) {
            const { rows: _rows, ...others } = detail;
            rest = others;
        }
        this.#ports.send(agentId, { seq, detail: rest, rows: patch });
    }
}
