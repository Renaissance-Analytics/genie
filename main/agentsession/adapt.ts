/**
 * The decisions inside the production port bindings.
 *
 * `./bindings.ts` is delegation — it reaches a database, the AgentInbox broker and
 * the filesystem, and there is nothing to check in a one-line forward. These three
 * are not delegation, and each has a known-expensive way to be wrong, so they live
 * here where a test can reach them without any of that.
 */

import type { FloorMessage } from './project-floor';

/** The subset of `terminal_specs.meta` this reads. */
export interface SpecMetaish {
    /** The AgentInbox identity minted PER TERMINAL — not the spec id, and not
     *  `workspace_agents.id`. */
    agent_id?: string;
}

/**
 * The agent's **AgentInbox** id, which is the only key the broker answers to.
 *
 * ★ THE TWO IDS. An AMS agent has a `workspace_agents.id`; the terminal it runs in
 * carries a SEPARATE `meta.agent_id`. The broker and the harness-transport registry
 * are keyed on the second; `ready_at`, `transport_verified_at` and `transport_error`
 * live on the first. `host-tools.ts` states the cost of mixing them: *"Reading one
 * id for both is not a subtle bug — it reports every healthy agent on the machine as
 * unreachable, which is exactly the kind of confident wrongness a triage tool must
 * not have."*
 *
 * So there is **no fallback**. Null means "no mail readable for this agent", which is
 * true and harmless; guessing would be neither.
 */
export function inboxAgentIdOf(meta: SpecMetaish | undefined | null): string | null {
    const raw = meta?.agent_id;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
}

/** The fields of an `AgentInboxMessage` this maps. */
export interface InboxMessageish {
    id: string;
    from: string;
    fromLabel: string;
    text: string;
    ts: number;
}

/**
 * Map the agent's DM log into transcript messages.
 *
 * Three senders, and the one that matters is the third: a message from a SIBLING
 * agent must be named. Without the name a peer's words render exactly as the owner's
 * would, which is how somebody ends up answering their own agent.
 *
 * When the agent's own inbox id is unknown, everything is a peer. Attributing
 * nothing to the agent is better than attributing somebody else's words to it.
 */
export function mailFrom(
    messages: readonly InboxMessageish[],
    ownInboxId: string | null,
): FloorMessage[] {
    const out: FloorMessage[] = [];
    for (const m of messages) {
        const body = (m.text ?? '').trim();
        // A blank row is worse than a missing one: it looks like a message that
        // failed to render rather than one that was never sent.
        if (body === '') continue;

        if (m.from === 'human') {
            out.push({ id: m.id, from: 'human', author: null, body, at: m.ts });
        } else if (ownInboxId !== null && m.from === ownInboxId) {
            out.push({ id: m.id, from: 'agent', author: null, body, at: m.ts });
        } else {
            out.push({
                id: m.id,
                from: 'peer',
                author: (m.fromLabel ?? '').trim() || m.from,
                body,
                at: m.ts,
            });
        }
    }
    return out;
}

/**
 * When a handoff was written.
 *
 * The note's own timestamp if it has one; otherwise the file's mtime, which is a
 * real fact about the file. Deliberately NOT `Date.now()` — that would date a
 * month-old note to this second and float it to the top of a transcript, telling
 * somebody their agent just finished when it finished last week.
 *
 * Null when neither is known, so the caller can decline the note rather than place
 * it at a time it invented.
 */
export function handoffAt(stated: number | null, mtime: number | null): number | null {
    return stated ?? mtime ?? null;
}
