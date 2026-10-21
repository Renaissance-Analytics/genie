import { limitWords } from './limit-words.js';
import type { AgentRow, Fidelity } from './dashboard-view.js';
import type { LiveSession } from './roster.js';
import type { TimedEvent } from './stream-view.js';
import type { Attachment } from './prompt-content.js';

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
 *  - **no thought ever appears in chat**: only `message` events become rows — and a stopped turn's one line;
 *  - **thread chips**: the agents sharing the subject's workspace, the subject marked active, each with its state.
 *    `unread` is `null` — nothing reads it yet, and `0` would claim you are up to date (§5).
 *
 * A time rides along only when the event had one. `delivered` is true for anything on the wire; the renderer
 * marks its OWN undelivered drafts separately (that is the next row).
 */

/**
 * `system`: one line Genie says about the thread (`Compacted the context`).
 * `mail`: a piece of the agent's AgentInbox mail — with the person or another agent, either way — `you → atlas`, its
 * whole text, opening that message in the AgentInbox (beta.33 items 7 + 18: an FTQ answer is one).
 * `delivery`: Genie's notice turn — the messages it told the agent about, each by who wrote it and what it says.
 * `stopped`: a turn that was stopped — one line where its reply ends, `Stopped by you`, so a reply cut short reads as
 * stopped and not as the agent's last word.
 */
export type ChatWho = 'you' | 'agent' | 'peer' | 'system' | 'mail' | 'delivery' | 'stopped' | 'thinking';

/** One message a delivery told about: its inbox id (to open it), who wrote it, and one line of what it says. */
export interface ChatMailRef {
    readonly id: string;
    readonly from: string;
    readonly subject: string;
}

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
    /** The names of the files sent with it (your message only); absent when there were none. */
    attachments?: readonly string[];
    /** Why an undelivered draft was not sent, when the host said; absent = the agent is not running. */
    reason?: string;
    /** An undelivered draft only: how it is sent now — `send` while its agent runs again, else `restart` (start it, then send). */
    resend?: 'send' | 'restart';
    /** A `mail` row: the inbox message it is, which a press opens in the AgentInbox. */
    mailId?: string;
    /** A `delivery` row: the messages Genie told the agent about. */
    mail?: readonly ChatMailRef[];
    /**
     * Your message, sent while the agent was in a step that has not ended (beta.33 item 21): the step it waits behind and
     * when that step started. Claude reads a message at its next tool boundary; absent = not waiting.
     */
    waiting?: ChatWaitingOn;
}

/** The step a message waits behind: its title (the command, or the tool), and when it started. */
export interface ChatWaitingOn {
    readonly step: string;
    readonly since: number | null;
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
    /** The subject's own conversation is loaded (the flyout's `data-chat-loaded`). `false` = nothing read for it yet. */
    loaded: boolean;
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
    if (s.accountPaused) return { text: `Account paused · ${s.accountPaused.words}`, tone: 'bad' };
    if (s.signedOut) return { text: 'Signed out · log in to continue', tone: 'warn' };
    if (s.pendingApproval !== null) return { text: 'Parked · waiting on you', tone: 'warn' };
    // Held for its provider's limit (Tynn #794): until when, never Idle.
    const held = limitWords(s.limit);
    if (held) return { text: `Paused · ${held}`, tone: 'warn' };
    if (s.failure !== null) return { text: `Broken · ${s.failure.reason}`, tone: 'bad' };
    if (s.running && s.turnState === 'working') {
        return { text: s.plan ? `Working · Plan ${s.plan.step}/${s.plan.of} · ${s.plan.doing}` : 'Working', tone: 'ok' };
    }
    // Waiting on the Claude Design login (#1081): the line's `Log in to Claude Design` fixes it.
    if (s.designLogin) return { text: 'Claude Design login needed', tone: 'warn' };
    // ITS TURN ENDED, ITS WORK DID NOT (the owner, 2026-10-21).
    if (s.running && (s.background ?? 0) > 0) return { text: `Working · ${s.background} in the background`, tone: 'ok' };
    return { text: 'Idle', tone: 'muted' };
}

export function chatMessages(detail: ChatDetail, rows: readonly AgentRow[] = []): ChatMessage[] {
    const out: ChatMessage[] = [];
    const waiting = waitingMessages(detail.rows);
    // Whether the row before was a thought: a reply (or any other row) between two thoughts splits them.
    let lastWasThink = false;
    for (const row of detail.rows) {
        const e = row.event;
        if (e.kind === 'stopped') {
            const text = e.by === null ? 'Stopped' : `Stopped by ${e.by}`;
            out.push({ id: row.id, who: 'stopped', from: e.by ?? '', text, delivered: true, at: row.at });
            continue;
        }
        if (e.kind === 'divider' && e.variant === 'compaction') {
            // `/compact`, said in one line where it happened (the owner, 2026-10-19) — the sizes only when reported.
            const sizes = e.before !== null && e.after !== null ? ` from ${e.before.toLocaleString('en-US')} to ${e.after.toLocaleString('en-US')} tokens` : '';
            out.push({ id: row.id, who: 'system', from: '', text: `Compacted the context${sizes}`, delivered: true, at: row.at });
            continue;
        }
        // THE AGENT'S THINKING, IN THE CHAT (the owner, 2026-10-20: "the thinking content should be posting in the chat
        // stream, not the work stream"): in its order with the replies; thoughts in a row are one; a wordless one is none.
        if (e.kind === 'think') {
            const text = e.text.trim();
            if (text === '') continue;
            const last = out[out.length - 1];
            if (last?.who === 'thinking' && lastWasThink) last.text = `${last.text}\n\n${text}`;
            else out.push({ id: row.id, who: 'thinking', from: detail.agent.name, text, delivered: true, at: row.at });
            lastWasThink = true;
            continue;
        }
        lastWasThink = false;
        if (e.kind !== 'message') continue;
        // GENIE'S NOTICE, WITH ITS CONTEXT (beta.33 item 18): not its instruction to the agent ("collect it with
        // agentinbox receive") but the messages it told about — who wrote each and what it says. A notice recorded
        // before notices carried their mail has nothing to list, and stays Genie's message as it was.
        if (e.speaker === 'peer' && e.mail && e.mail.length > 0) {
            const n = e.mail.length;
            out.push({
                id: row.id, who: 'delivery', from: `${e.peerName ?? 'genie'} → ${detail.agent.name}`,
                text: `told ${detail.agent.name} about ${n} AgentInbox message${n === 1 ? '' : 's'}`,
                delivered: true, at: row.at,
                mail: e.mail.map((m) => ({ id: m.id, from: m.from === 'human' ? 'you' : rows.find((r) => r.id === m.from)?.name ?? m.fromName ?? m.from, subject: mailSubject(m.text) })),
            });
            continue;
        }
        const who: ChatWho = e.speaker;
        const from = who === 'you' ? 'you' : who === 'peer' ? `${e.peerName ?? 'peer'} → ${detail.agent.name}` : detail.agent.name;
        const waits = who === 'you' ? waiting.get(row.id) : undefined;
        out.push({ id: row.id, who, from, text: e.text, delivered: true, at: row.at, ...(e.attachments && e.attachments.length > 0 ? { attachments: e.attachments } : {}), ...(waits ? { waiting: waits } : {}) });
    }
    return out;
}

/**
 * WHICH OF YOUR MESSAGES WAIT, and behind what (beta.33 item 21; the owner's moic, inside one shell command from 14:31,
 * three messages unanswered and nothing saying why). Read from the ledger: a message of yours sent while a step of the
 * running turn had started and not ended waits behind that step, until it completes or fails (the boundary Claude reads
 * queued messages at), or the turn ends or is stopped. A message sent between steps does not wait.
 */
export function waitingMessages(ledger: readonly TimedEvent[]): Map<string, ChatWaitingOn> {
    /** Steps started and not ended, in the turn now running: id → what it is and when it started. */
    const open = new Map<string, ChatWaitingOn>();
    /** Messages waiting, and the step each waits behind. */
    const waits = new Map<string, { on: string; waiting: ChatWaitingOn }>();
    for (const { id, event: e, at } of ledger) {
        if (e.kind === 'turn' || e.kind === 'stopped' || e.kind === 'run') {
            open.clear();
            waits.clear();
            continue;
        }
        if (e.kind === 'tool') {
            if (e.toolCallId === '') continue;
            if (e.status === 'completed' || e.status === 'failed') {
                open.delete(e.toolCallId);
                for (const [m, w] of waits) if (w.on === e.toolCallId) waits.delete(m);
                continue;
            }
            const known = open.get(e.toolCallId);
            const step = e.title ?? e.name ?? known?.step ?? 'a step';
            open.set(e.toolCallId, { step: known && (e.title === null || e.title === '') ? known.step : step, since: known?.since ?? at });
            continue;
        }
        if (e.kind === 'message' && e.speaker === 'you' && open.size > 0) {
            // Behind the step started last: the one running now.
            const [on, waiting] = [...open.entries()].at(-1)!;
            waits.set(id, { on, waiting });
        }
    }
    return new Map([...waits].map(([m, w]) => [m, w.waiting]));
}

/**
 * WHAT THE CHAT FOLLOWS (beta.33 item 6): a person at the end of the thread stays at its end while this changes — a new
 * message, AND the last message growing as the agent writes it. Keyed on the count alone, a reply streamed below the
 * fold of a chat that did not move, and was seen only when the next message arrived ("when the message closes").
 */
export function chatFollowKey(agentId: string | null, messages: readonly { readonly id: string; readonly text: string }[]): string {
    const last = messages[messages.length - 1];
    return `${agentId ?? ''}:${messages.length}:${last ? `${last.id}:${last.text.length}` : ''}`;
}

export function chatThreadFrom(detail: ChatDetail | null, subjectId: string, rows: readonly AgentRow[], _now: () => number): ChatThreadView {
    const row = rows.find((r) => r.id === subjectId || r.name === subjectId) ?? null;
    // Only the SUBJECT's detail is its conversation (a route may name it by id or, for genie, by name). A detail still
    // loaded for another agent is never drawn under this one's name.
    const own = detail !== null && (detail.agent.id === subjectId || detail.agent.id === row?.id || detail.agent.name === subjectId);
    if (!own) detail = null;
    return {
        agentId: subjectId,
        name: detail?.agent.name ?? row?.name ?? subjectId,
        fidelity: detail?.agent.fidelity ?? row?.fidelity ?? 'declared',
        unread: null,
        messages: detail ? byTime(chatMessages(detail, rows), commsRows(detail, rows)) : [],
        context: detail ? chatContext(detail) : null,
        loaded: detail !== null,
    };
}

/** The OS agent's address in a route (`chat=genie`); its minted id resolves from the name. */
const GENIE = 'genie';
/** How many conversations the tabs remember. */
const KEPT = 8;

/** A conversation opened: first in the list a workspace's chat is chosen from, once; eight are kept. genie is never remembered — it is every other view's. */
export function rememberThread(opened: readonly string[], id: string): string[] {
    if (id === GENIE) return [...opened];
    return [id, ...opened.filter((x) => x !== id)].slice(0, KEPT);
}

/** How long a subject line runs before it is cut. */
const SUBJECT_CHARS = 160;

/**
 * ONE LINE OF WHAT A MESSAGE SAYS — a delivery's entry. The whole message, not its first line: an FTQ answer's first line
 * is `Answer to your question q_…:`, which says nothing, and what matters (the question's header, the option chosen, the
 * note) is on the lines under it. Markdown marks and list bullets go, lines join, a `Note:` is set off with `·`; capped.
 */
export function mailSubject(text: string): string {
    const lines = text
        .split('\n')
        .map((l) => l.trim().replace(/^[-*]\s+/, '').replace(/\*\*|__|`/g, '').trim())
        .filter((l) => l.length > 0);
    const line = lines.reduce((acc, l) => (acc === '' ? l : /^note:/i.test(l) ? `${acc} · ${l}` : `${acc} ${l}`), '');
    return line.length > SUBJECT_CHARS ? `${line.slice(0, SUBJECT_CHARS - 1)}…` : line;
}

/**
 * WHAT MAIN HANDS THE CHAT of an agent's AgentInbox mail: every message it sent or received — the person's included. It
 * used to drop the person's, on the reading that mail with the person "is the conversation itself"; for a declared agent
 * it is not (the session sees it only when the agent calls `receive`), so the person's FTQ answer never reached the chat
 * at all (the owner, beta.33: "I did not see the msg post from answering the FTQ appear").
 */
export function chatCommsOf(messages: readonly MailLike[]): MailLike[] {
    return messages.map((m) => ({ id: m.id, from: m.from, to: m.to, text: m.text, sentAt: m.sentAt, readAt: m.readAt }));
}

/**
 * The agent's AgentInbox mail as MAIL rows — with the person and with other agents, either way (beta.33 items 7 + 18):
 * `you → atlas`, `atlas → wren`, with the whole text, each opening its message in the AgentInbox. Mail between two other
 * agents is not this agent's.
 */
function commsRows(detail: ChatDetail, rows: readonly AgentRow[]): ChatMessage[] {
    if (!detail.comms) return [];
    const self = detail.agent.id;
    const name = (id: string): string => (id === 'human' ? 'you' : id === self ? detail.agent.name : rows.find((r) => r.id === id)?.name ?? id);
    return detail.comms
        .filter((m) => m.from === self || m.to === self)
        .map((m) => {
            const at = Date.parse(m.sentAt);
            return { id: m.id, who: 'mail' as const, from: `${name(m.from)} → ${name(m.to)}`, text: m.text, delivered: true, at: Number.isNaN(at) ? null : at, mailId: m.id };
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

/**
 * How an undelivered message reaches its agent: a session that BROKE restarts on its thread; an agent that is not running
 * (never started, or stopped) is STARTED — a graceful restart would refuse it when there is no thread yet, which is how a
 * fresh install's genie could never be reached.
 */
export function draftSendVia(session: { failure: unknown } | null): 'start' | 'restart' {
    return session !== null && session.failure !== null && session.failure !== undefined ? 'restart' : 'start';
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
    /** The files you attached: KEPT with the draft, so sending it again sends them too. */
    attachments?: readonly Attachment[];
    /** Why the host did not send it; absent = the agent is not running. */
    reason?: string;
}

/**
 * The thread with THIS agent's undelivered drafts, as `you`, not delivered, each WHERE IT WAS WRITTEN — before any later
 * message (the owner, 2026-10-20: a draft appended after everything sat under the newer messages, "stuck on my screen").
 * `running`: the agent runs now, so a draft is sent as it is (`Send now`); otherwise it is started first (`Restart <agent>
 * and send`). Showing a draft as sent would have someone wait for an answer that cannot come; dropping it loses what
 * they wrote — so it stays until it is sent or discarded.
 */
export function withDrafts<T extends { agentId: string; messages: readonly ChatMessage[] }>(thread: T, drafts: readonly Draft[], opts: { running?: boolean } = {}): T {
    const mine = drafts.filter((d) => d.agentId === thread.agentId).sort((a, b) => a.at - b.at);
    if (mine.length === 0) return thread;
    const pending = mine.map((d): ChatMessage => ({
        id: d.id, who: 'you', from: 'you', text: d.text, delivered: false, at: d.at, resend: opts.running === true ? 'send' : 'restart',
        ...(d.attachments && d.attachments.length > 0 ? { attachments: d.attachments.map((a) => a.name) } : {}),
        ...(d.reason ? { reason: d.reason } : {}),
    }));
    const messages: ChatMessage[] = [];
    for (const m of thread.messages) {
        // A wire message with no time keeps its place; it never pulls a draft past it.
        if (m.at !== null) while (pending.length > 0 && pending[0]!.at! < m.at) messages.push(pending.shift()!);
        messages.push(m);
    }
    return { ...thread, messages: [...messages, ...pending] };
}
