import { FileSessionStore, Thread, type SessionStore } from '@particle-academy/prism-harness';
import { threadKeyFor, type AgentId } from './identity.js';

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
export function openAgentThread(store: SessionStore, agentId: AgentId): Thread {
    return new Thread(store, threadKeyFor(agentId));
}
