import { FileSessionStore, Thread, type SessionStore } from '@particle-academy/prism-harness';
import { threadKeyFor, type AgentId } from './identity.js';
import type { StreamEvent } from './stream-event.js';

/**
 * WHERE AN AGENT'S CONVERSATION LIVES BETWEEN RUNS.
 *
 * ## Why `prism-harness`, and only half of it
 *
 * Durability is a solved problem in the kit and hand-rolling it would be strictly worse. A
 * `SessionStore` **declares its own `durability()`** rather than having it inferred, because
 * only the application knows whether its backing store is persistent or a disposable cache —
 * and the difference decides whether losing the contents is a shrug or a half-executed agent
 * action that was waiting on a human. `withLock` is on the store interface for the real race:
 * a run finishing while the user sends another message is ordinary, not exotic.
 *
 * We use that half and **not** `AgentRuntime`. Confirmed with the package's own author
 * (2026-10-10, read from source at `prism-harness-ts` 0.6.0 c35ddd9): the package contains
 * **zero** references to ACP, and `AgentRuntime` takes `LlmClient = (request) => Promise<
 * LlmResponse>` — a request/response call, i.e. **Prism itself is the agent**. Genie's agent
 * is an external CLI that owns its own thread on the provider side over a streaming
 * protocol. The two cannot both own the loop.
 *
 * Taking durability without the runtime is therefore the **intended seam**, not a
 * workaround: nothing in the store path knows who runs the loop. There is **no ACP-backed
 * thread adapter planned**, so the ACP-update → message mapping is ours permanently.
 */

/**
 * The durable store for one workstation.
 *
 * `FileSessionStore` reports `durable`, which is what lets it hold a thread and a pending
 * approval. Never pass an ephemeral store here — the manager would refuse it, and that
 * refusal is a guard we are relying on rather than a formality.
 */
export function openDurableStore(directory: string): SessionStore {
    return new FileSessionStore(directory);
}

/**
 * This agent's thread.
 *
 * **The key comes from `threadKeyFor` and from nowhere else.** That is the entire point of
 * this function existing rather than callers constructing a `Thread` themselves: the
 * previous build wrote under one id and read under another, and because an identity split
 * throws nothing, its Conversation tab was empty for four releases while every surface
 * downstream got blamed first.
 */
/** The field a recorded row names the run that wrote it in (stripped when the row is read back). */
export const RUN_FIELD = 'writtenByRun';

export function openAgentThread(store: SessionStore, agentId: AgentId): Thread {
    return new Thread(store, threadKeyFor(agentId));
}

/**
 * AN AGENT'S RECORDED HISTORY — every row the session wrote to its thread, with the time it was written. Claude does
 * not replay a resumed conversation to its client (prism-acp: `transcriptReplay: false`), so this record is the only
 * way the Agent view and the chat can show what came before this run; without it an agent remembered hundreds of
 * thousands of tokens of context while the UI showed one turn (the owner, beta.21).
 *
 * A running agent's CURRENT run is kept out — its rows are already live — by `run`: every row a run writes carries
 * that run's id ({@link RUN_FIELD}), so a row is this run's exactly when it says so. NOT by when it was written: a row
 * the previous run emitted but wrote in the same millisecond the next run started, or after it (a write still landing
 * on a quick restart), read as this run's and was shown by neither (main's CI, 2026-10-21: turn 1's `finished` row
 * gone). `before` (epoch ms) is that old rule, kept only for rows recorded before runs were named. `limit` keeps the
 * most recent rows; `earlier` says how many older ones were left out. A row written unserialisable is skipped.
 */
export async function readHistory(store: SessionStore, agentId: AgentId, options: { before?: number; run?: string; limit?: number } = {}): Promise<{ rows: { event: StreamEvent; at: number | null; position: number }[]; earlier: number; earlierTurns: number }> {
    const messages = await openAgentThread(store, agentId).messages();
    const rows: { event: StreamEvent; at: number | null; position: number }[] = [];
    for (const m of messages) {
        const at = Date.parse(m.recordedAt);
        const { [RUN_FIELD]: writtenBy, ...message } = m.message as Record<string, unknown>;
        if (typeof writtenBy === 'string') {
            if (options.run !== undefined && writtenBy === options.run) continue;
        } else if (options.before !== undefined && Number.isFinite(at) && at >= options.before) continue;
        if (typeof message.kind !== 'string' || message.unserialisable === true) continue;
        rows.push({ event: message as unknown as StreamEvent, at: Number.isFinite(at) ? at : null, position: m.position });
    }
    const limit = options.limit ?? rows.length;
    const earlier = Math.max(0, rows.length - limit);
    // The turns the window cut off: the turns shown number on from them.
    const earlierTurns = rows.slice(0, earlier).filter((r) => r.event.kind === 'turn').length;
    return { rows: rows.slice(earlier), earlier, earlierTurns };
}

/** The highest turn number in an agent's record (0 when none) — where its next run's turns continue from. */
export function lastTurnOf(rows: readonly { event: StreamEvent }[]): number {
    let n = 0;
    for (const r of rows) if (r.event.kind === 'turn' && r.event.n > n) n = r.event.n;
    return n;
}
