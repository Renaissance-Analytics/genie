import type { AgentRow, AgentState, Fidelity } from './dashboard-view.js';
import type { LiveSession } from './roster.js';
import type { TimedEvent } from './stream-view.js';

/**
 * THE CHAT FLYOUT'S THREAD, derived — no React in sight.
 *
 * The board audit of 2026-10-12 found the renderer hard-coding `messages: []` with "AgentInbox lands with P4"
 * beside it: the only place a human types to an agent showed nothing the agent said back. The transcript was on
 * the wire all along — an agent's stream carries `message` events with a speaker — so the thread is derived from
 * the same detail the Agent view reads, and the two can never disagree.
 *
 * The board (`Chat Flyout.dc.html`):
 *  - a **context line** under the thread chips: `Working · Plan 4/7 · <target>` / `Parked · waiting on you`
 *    (amber) / `Broken · <reason>` (red) / `Observed · <provider> runs in a terminal` / `Idle`; a registered agent
 *    that never started reads `Not started`, which is not "Idle" (that would claim a session exists);
 *  - **message shapes**: you (right-aligned), the agent BY NAME (violet), a peer as `wren → atlas`. Rendering `role`
 *    alone once labelled a sibling agent's message `user` — the same word as the owner's;
 *  - **no thought ever appears in chat**: only `message` events become rows;
 *  - **thread chips**: the agents sharing the subject's workspace, the subject marked active, each with its state.
 *    `unread` is `null` — nothing reads it yet, and `0` would claim you are up to date (§5).
 *
 * A time rides along only when the event had one. `delivered` is true for anything on the wire; the renderer
 * marks its OWN undelivered drafts separately (that is the next row).
 */

export type ChatWho = 'you' | 'agent' | 'peer';

export interface ChatMessage {
    id: string;
    who: ChatWho;
    /** `you`, the agent's name, or `peer → agent`. */
    from: string;
    text: string;
    delivered: boolean;
    /** Epoch ms, or `null` when the event carried none — never synthesised. */
    at: number | null;
}

export interface ChatChip {
    agentId: string;
    name: string;
    state: AgentState;
    fidelity: Fidelity;
    active: boolean;
    unread: number | null;
}

export interface ChatContext {
    text: string;
    tone: 'ok' | 'warn' | 'bad' | 'muted';
}

export interface ChatThreadView {
    agentId: string;
    name: string;
    fidelity: Fidelity;
    unread: number | null;
    messages: readonly ChatMessage[];
    /** `null` until the agent's detail has been read — not "Idle". */
    context: ChatContext | null;
    chips: readonly ChatChip[];
}

/** The slice of an agent's detail the thread reads (structurally `AgentDetail`, without binding core to the bridge). */
export interface ChatDetail {
    agent: { id: string; name: string; provider: string; fidelity: Fidelity };
    session: LiveSession | null;
    rows: readonly TimedEvent[];
}

export function chatContext(detail: ChatDetail): ChatContext {
    if (detail.agent.fidelity === 'observed') return { text: `Observed · ${detail.agent.provider} runs in a terminal`, tone: 'muted' };
    const s = detail.session;
    if (!s) return { text: 'Not started', tone: 'muted' };
    if (s.pendingApproval !== null) return { text: 'Parked · waiting on you', tone: 'warn' };
    if (s.failure !== null) return { text: `Broken · ${s.failure.reason}`, tone: 'bad' };
    if (s.running && s.turnState === 'working') {
        return { text: s.plan ? `Working · Plan ${s.plan.step}/${s.plan.of} · ${s.plan.doing}` : 'Working', tone: 'ok' };
    }
    return { text: 'Idle', tone: 'muted' };
}

export function chatMessages(detail: ChatDetail): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const row of detail.rows) {
        const e = row.event;
        if (e.kind !== 'message') continue;
        const who: ChatWho = e.speaker;
        const from = who === 'you' ? 'you' : who === 'peer' ? `${e.peerName ?? 'peer'} → ${detail.agent.name}` : detail.agent.name;
        out.push({ id: row.id, who, from, text: e.text, delivered: true, at: row.at });
    }
    return out;
}

export function chatChips(rows: readonly AgentRow[], subjectId: string): ChatChip[] {
    const subject = rows.find((r) => r.id === subjectId);
    if (!subject) return [];
    return rows
        .filter((r) => r.workspaceId === subject.workspaceId)
        .map((r) => ({ agentId: r.id, name: r.name, state: r.state, fidelity: r.fidelity, active: r.id === subjectId, unread: null }));
}

export function chatThreadFrom(detail: ChatDetail | null, subjectId: string, rows: readonly AgentRow[], _now: () => number): ChatThreadView {
    const row = rows.find((r) => r.id === subjectId);
    return {
        agentId: subjectId,
        name: detail?.agent.name ?? row?.name ?? subjectId,
        fidelity: detail?.agent.fidelity ?? row?.fidelity ?? 'declared',
        unread: null,
        messages: detail ? chatMessages(detail) : [],
        context: detail ? chatContext(detail) : null,
        chips: chatChips(rows, subjectId),
    };
}
