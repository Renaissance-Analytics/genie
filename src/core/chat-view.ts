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

/** `system`: the agent's AgentInbox mail with another agent — one line in its thread, `atlas → wren · <subject>`. */
export type ChatWho = 'you' | 'agent' | 'peer' | 'system';

export interface ChatMessage {
    id: string;
    who: ChatWho;
    /** `you`, the agent's name, or `peer → agent`. */
    from: string;
    text: string;
    delivered: boolean;
    /** Epoch ms, or `null` when the event carried none — never synthesised. */
    at: number | null;
    /**
     * Your inbox mail to an observed agent only: when it read it (epoch ms), or `null` = not read yet. Absent on
     * every other message — a session prompt has no read receipt, and claiming one would be a guess.
     */
    read?: number | null;
}

export interface ChatChip {
    agentId: string;
    name: string;
    /** `null` for genie, the OS agent: its tab carries Genie's mark, not a state Genie would be guessing. */
    state: AgentState | null;
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
    /** The agent's AgentInbox mail (both directions); absent or `null` = not read, which adds no rows. */
    comms?: readonly MailLike[] | null | undefined;
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
        messages: detail ? byTime(chatMessages(detail), commsRows(detail, rows)) : [],
        context: detail ? chatContext(detail) : null,
        chips: chatChips(rows, subjectId),
    };
}

/** The OS agent's address in a route (`chat=genie`); its minted id resolves from the name. */
const GENIE = 'genie';
const isOsAgent = (r: AgentRow): boolean => r.workspaceId === '__genie__' && r.name === GENIE;
/** How many conversations the tabs remember. */
const KEPT = 8;

/**
 * THE CHAT'S TABS, across workspaces (the board's flyout: `atlas · lark · rook · genie`): the conversations you
 * opened, newest first; then any agent waiting on you that is not already there; genie, the OS agent, always last.
 * An agent no longer on the board drops out rather than showing a name that opens nothing.
 */
export function chatThreads(agents: readonly AgentRow[], opened: readonly string[], subjectId: string | null): ChatChip[] {
    const os = agents.find(isOsAgent) ?? null;
    const onBoard = agents.filter((r) => !isOsAgent(r));
    const tab = (r: AgentRow): ChatChip => ({ agentId: r.id, name: r.name, state: r.state, fidelity: r.fidelity, active: r.id === subjectId, unread: null });
    const first = opened.flatMap((id) => onBoard.filter((r) => r.id === id)).map(tab);
    const waiting = onBoard.filter((r) => r.state === 'waiting' && !opened.includes(r.id)).map(tab);
    const genie: ChatChip = { agentId: GENIE, name: GENIE, state: null, fidelity: 'declared', active: subjectId === GENIE || (os !== null && subjectId === os.id), unread: null };
    return [...first, ...waiting, genie];
}

/** A conversation opened: first in the tabs, once; the tabs keep eight. genie is never remembered — it is always there. */
export function rememberThread(opened: readonly string[], id: string): string[] {
    if (id === GENIE) return [...opened];
    return [id, ...opened.filter((x) => x !== id)].slice(0, KEPT);
}

/** A line of a message as a row's subject: the first line, trimmed, capped. */
function subjectOf(text: string): string {
    const line = text.split('\n')[0]!.trim();
    return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/**
 * The agent's mail with ANOTHER agent, as system rows (the board: `atlas → wren · drop challenges table from
 * migration`). Mail with the person is the conversation itself, not a row about it; mail between two other agents
 * is not this agent's.
 */
function commsRows(detail: ChatDetail, rows: readonly AgentRow[]): ChatMessage[] {
    if (!detail.comms) return [];
    const self = detail.agent.id;
    const name = (id: string): string => (id === self ? detail.agent.name : rows.find((r) => r.id === id)?.name ?? id);
    return detail.comms
        .filter((m) => m.from !== 'human' && m.to !== 'human' && (m.from === self || m.to === self))
        .map((m) => {
            const at = Date.parse(m.sentAt);
            const line = `${name(m.from)} → ${name(m.to)}`;
            return { id: m.id, who: 'system' as const, from: line, text: `${line} · ${subjectOf(m.text)}`, delivered: true, at: Number.isNaN(at) ? null : at };
        });
}

/** The system rows placed among the messages by when they were sent; a message with no time keeps its place. */
function byTime(messages: readonly ChatMessage[], system: readonly ChatMessage[]): ChatMessage[] {
    if (system.length === 0) return [...messages];
    const pending = [...system].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
    const out: ChatMessage[] = [];
    for (const m of messages) {
        if (m.at !== null) while (pending.length > 0 && (pending[0]!.at ?? Infinity) <= m.at) out.push(pending.shift()!);
        out.push(m);
    }
    return [...out, ...pending];
}

/** The fields of an inbox message the observed thread reads (`main/inbox-store.ts`'s `InboxMessage`). */
export interface MailLike {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly text: string;
    readonly sentAt: string;
    readonly readAt: string | null;
}

/**
 * AN OBSERVED AGENT'S CHAT IS ITS INBOX THREAD (§4.4). Your mail to it, with whether it has read each one, and its
 * mail to you by name, oldest first; `unread` counts its mail you have not read. A Take Over window's replies in its
 * terminal are not here — that TUI does not report them. `recent === null` (the inbox not read yet) gives `unread:
 * null`, never `0`, which would claim you are up to date.
 */
export function observedMail(recent: readonly MailLike[] | null, agentId: string, name: string): { messages: ChatMessage[]; unread: number | null } {
    if (recent === null) return { messages: [], unread: null };
    const messages: ChatMessage[] = [];
    let unread = 0;
    for (const m of recent) {
        if (m.from === 'human' && m.to === agentId) {
            messages.push({ id: m.id, who: 'you', from: 'you', text: m.text, delivered: true, at: Date.parse(m.sentAt), read: m.readAt === null ? null : Date.parse(m.readAt) });
        } else if (m.from === agentId && m.to === 'human') {
            messages.push({ id: m.id, who: 'agent', from: name, text: m.text, delivered: true, at: Date.parse(m.sentAt) });
            if (m.readAt === null) unread++;
        }
    }
    return { messages, unread };
}

/**
 * Where the composer sends. A declared agent is prompted in its session; an observed one has no session — its mail
 * goes to its inbox by full address (`{workspace}:{provider}:{name}`, core/inbox.ts), which its TUI reads over MCP.
 */
export function chatSendFor(agent: { fidelity: Fidelity; workspaceId: string; provider: string; name: string }): { kind: 'prompt' } | { kind: 'inbox'; to: string } {
    return agent.fidelity === 'observed' ? { kind: 'inbox', to: `${agent.workspaceId}:${agent.provider}:${agent.name}` } : { kind: 'prompt' };
}

/** A message the renderer could not deliver: the agent was not running. Kept, never dropped (§4.4). */
export interface Draft {
    id: string;
    agentId: string;
    text: string;
    /** When you sent it — a real time, the renderer's own clock. */
    at: number;
}

/**
 * The thread with THIS agent's undelivered drafts appended after the wire messages, as `you`, not delivered. The
 * flyout marks them and offers `Restart <agent> and send`; showing them as sent would have someone wait for an answer
 * that cannot come, and dropping them loses what they wrote.
 */
export function withDrafts<T extends { agentId: string; messages: readonly ChatMessage[] }>(thread: T, drafts: readonly Draft[]): T {
    const mine = drafts.filter((d) => d.agentId === thread.agentId);
    if (mine.length === 0) return thread;
    return {
        ...thread,
        messages: [...thread.messages, ...mine.map((d): ChatMessage => ({ id: d.id, who: 'you', from: 'you', text: d.text, delivered: false, at: d.at }))],
    };
}
