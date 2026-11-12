import { limitTitle, limitWords } from './limit-words.js';
import { isSleeping } from './agent-status.js';
import type { AgentRow, Fidelity } from './dashboard-view.js';
import type { LiveSession } from './roster.js';
import { repeatsCompaction, type TimedEvent } from './stream-view.js';
import type { AttachmentRef, StreamEvent, ToolKind } from './stream-event.js';
import type { Attachment } from './prompt-content.js';
import { promptDeliveries } from './prompt-delivery.js';
import { messageLines } from './chat-window.js';
import { UNNAMED_AGENT } from './inbox.js';

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
 * `delivery`: a legacy thread payload; its row is ignored now that the mail card is the notification.
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
    /** Genie holds this message until the provider's current turn ends. */
    queued?: boolean;
    /** The turn has ended, but the provider is still paused. */
    queuedForProvider?: boolean;
    /** The agent is still starting (q_04ce323c: its first message started it); it goes the moment it is up. */
    queuedForStart?: boolean;
    /**
     * Queued behind a turn: when the agent last showed anything (Tynn #699) — after two minutes of nothing the message
     * offers "Send now (stop the current turn)". `null`: nothing from the agent in this thread.
     */
    silentSince?: number | null;
    /** Its durable queue id, for restarting/sending or discarding an unsent draft. */
    promptId?: string;
    /** A failed Send/Discard press, kept beside the draft so it can be tried again. */
    draftProblem?: string;
    /** Epoch ms, or `null` when the event carried none — never synthesised. */
    at: number | null;
    /**
     * Legacy observed-chat bubble receipt. Current mail cards use `delivered`, from the existing inbox readAt.
     */
    read?: number | null;
    /**
     * A PROVIDER SWITCH'S CARRY-OVER (Tynn story #380): the exact text the turn carried above the person's words, drawn
     * as a collapsed marker that opens to it. Absent on every other message.
     */
    carried?: string;
    /** The names of the files sent with it (your message only); absent when there were none. */
    attachments?: readonly string[];
    /** The images among them the host kept (Tynn #642): what a pill asks for to show its image. Absent when none was kept. */
    attachmentRefs?: readonly AttachmentRef[];
    /** Why an undelivered draft was not sent, when the host said; absent = the agent is not running. */
    reason?: string;
    /** An undelivered draft only: how it is sent now — `send` while its agent runs again, else `restart` (start it, then send). */
    resend?: 'send' | 'restart';
    /** A `mail` row: the inbox message it is, which a press opens in the AgentInbox. */
    mailId?: string;
    /** A `delivery` row: the messages Genie told the agent about. */
    mail?: readonly ChatMailRef[];
    /**
     * Your message, sent while the agent was in a step of its own that has not ended (beta.33 item 21): the step it waits
     * behind and when that step started. Claude reads a message at its next tool boundary; absent = not waiting
     * ({@link waitingMessages}).
     */
    waiting?: ChatWaitingOn;
}

/** The step a message waits behind: its title (the command, or the tool), when it started, and its kind (the Stream's icon). */
export interface ChatWaitingOn {
    readonly step: string;
    readonly since: number | null;
    readonly kind: ToolKind | null;
}

/**
 * THE STEP, IN WORDS A PERSON READS (the owner, 2026-11-01: "I know the agent is busy, why is it showing me the tool call
 * like that"). Claude titles an MCP call with its raw id, `mcp__<server>__<tool>`; that reads as its server — the name the
 * server was configured under (`playwright`, `tynn`, `genie`), with a plugin's `plugin_<plugin>_` prefix and claude.ai's
 * `claude_ai_` dropped. Anything else (a shell command's description, a tool's name) is kept as the provider titled it.
 * The raw step stays in the queued message's hover, for debugging.
 */
export function waitingStepLabel(step: string): string {
    const mcp = /^mcp__(.+?)__.+$/.exec(step);
    if (!mcp) return step;
    let server = mcp[1]!;
    const plugin = /^plugin_[^_]+_(.+)$/.exec(server);
    if (plugin) server = plugin[1]!;
    else if (server.startsWith('claude_ai_')) server = server.slice('claude_ai_'.length);
    return server.replace(/_/g, ' ');
}


export interface ChatContext {
    text: string;
    tone: 'ok' | 'warn' | 'bad' | 'muted' | 'cool';
    /** The hover: the full date and time a rate-limit hold resumes. Absent = no hover. */
    title?: string;
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
    /** Rows of the ledger lie before these messages ({@link chatTailStart}): earlier history, which pages in on request. */
    earlier: boolean;
    /** The message still arriving ({@link arrivingMessageId}), drawn progressively; `null` = every message is finished. */
    arriving: string | null;
}

/** The slice of an agent's detail the thread reads (structurally `AgentDetail`, without binding core to the bridge). */
export interface ChatDetail {
    agent: { id: string; name: string; provider: string; fidelity: Fidelity };
    session: LiveSession | null;
    rows: readonly TimedEvent[];
    /** The agent's AgentInbox mail (both directions); absent or `null` = not read, which adds no rows. */
    comms?: readonly MailLike[] | null | undefined;
    /** `rows` are not yet its conversation (Tynn #659, `AgentDetail.rowsPending`): the thread is not loaded, and shows no mail alone. */
    rowsPending?: boolean | undefined;
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
    if (held) { const title = limitTitle(s.limit); return { text: `Paused · ${held}`, tone: 'warn', ...(title ? { title } : {}) }; }
    if (s.failure !== null) return { text: `Broken · ${s.failure.reason}`, tone: 'bad' };
    // COMING UP (q_04ce323c): its first message waits for the start, and the line says why.
    if (s.running && s.starting === true && s.turnState !== 'working') return { text: 'Starting', tone: 'muted' };
    if (s.running && s.turnState === 'working') {
        return { text: s.plan ? `Working · Plan ${s.plan.step}/${s.plan.of} · ${s.plan.doing}` : 'Working', tone: 'ok' };
    }
    // Waiting on the Claude Design login (#1081): the line's `Log in to Claude Design` fixes it.
    if (s.designLogin) return { text: 'Claude Design login needed', tone: 'warn' };
    // ITS TURN ENDED, ITS WORK DID NOT (the owner, 2026-10-21).
    if (s.running && (s.background ?? 0) > 0) return { text: `Working · ${s.background} in the background`, tone: 'ok' };
    // COOLING (core/session.ts COOLING_MS): the 15 s after a turn that replied.
    if (s.running && s.cooling === true) return { text: 'Cooling', tone: 'cool' };
    if (isSleeping(s, Date.now())) return { text: 'Sleeping', tone: 'muted' };
    return { text: 'Idle', tone: 'muted' };
}

/** Provider bookkeeping is not another chat message: the actual mail card is the notification. */
function inboxNotice(event: StreamEvent): boolean {
    return event.kind === 'message' && event.speaker === 'peer' && (
        (event.mail?.length ?? 0) > 0
        || (event.peerName === 'genie' && /^You have \d+ unread AgentInbox messages?; collect (?:it|them) with agentinbox receive\.$/.test(event.text))
    );
}

export function chatMessages(detail: ChatDetail, _rows: readonly AgentRow[] = []): ChatMessage[] {
    const out: ChatMessage[] = [];
    const waiting = waitingMessages(detail.rows);
    const deliveries = promptDeliveries(detail.rows);
    // Whether the row before was a thought: a reply (or any other row) between two thoughts splits them.
    let lastWasThink = false;
    // The row before, debug notices aside: a compaction repeating it is the same compaction (genie#1249).
    let previous: StreamEvent | undefined;
    // The agent's last sign of life: any row that is not the person's own message (Tynn #699).
    let lastOutputAt: number | null = null;
    for (const row of detail.rows) if (!(row.event.kind === 'message' && row.event.speaker === 'you') && row.at !== null && (lastOutputAt === null || row.at > lastOutputAt)) lastOutputAt = row.at;
    for (const row of detail.rows) {
        const e = row.event;
        if (repeatsCompaction(previous, e)) continue;
        if (!(e.kind === 'notice' && e.level === 'debug')) previous = e;
        if (e.kind === 'stopped') {
            const text = e.by === null ? 'Stopped' : `Stopped by ${e.by}`;
            out.push({ id: row.id, who: 'stopped', from: e.by ?? '', text, delivered: true, at: row.at });
            continue;
        }
        // What a provider switch carried into this turn: a marker, never the person's words (Tynn story #380).
        if (e.kind === 'notice' && e.carried) {
            out.push({ id: row.id, who: 'system', from: '', text: e.message, delivered: true, at: row.at, carried: e.carried.text });
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
        const delivery = e.pending ? deliveries.get(e.pending.id) : undefined;
        if (delivery === 'discarded') continue;
        if (inboxNotice(e)) continue;
        const who: ChatWho = e.speaker;
        const from = who === 'you' ? 'you' : who === 'peer' ? `${e.peerName ?? 'peer'} → ${detail.agent.name}` : detail.agent.name;
        const delivered = delivery === undefined || delivery === 'sent';
        // `carried` (Tynn #702): kept across the restart an unconfirmed interrupt made, waiting for the new run like a queued one.
        const queued = (delivery === 'queued' || delivery === 'carried') && detail.session?.running === true;
        const waits = who === 'you' && delivered ? waiting.get(row.id) : undefined;
        out.push({ id: row.id, who, from, text: e.text, delivered, at: row.at,
            ...(e.pending ? { promptId: e.pending.id, queued, resend: detail.session?.running && detail.session.turnState !== 'failed' ? 'send' as const : 'restart' as const } : {}),
            ...(queued && detail.session?.starting === true ? { queuedForStart: true }
                : queued && detail.session?.turnState === 'idle' && detail.session.inTurn !== true ? { queuedForProvider: true } : {}),
            ...(queued ? { silentSince: lastOutputAt } : {}),
            ...(e.attachments && e.attachments.length > 0 ? { attachments: e.attachments } : {}),
            ...(e.attachmentRefs && e.attachmentRefs.length > 0 ? { attachmentRefs: e.attachmentRefs } : {}), ...(waits ? { waiting: waits } : {}) });
    }
    return out;
}

/**
 * WHICH OF YOUR MESSAGES WAIT, and behind what (beta.33 item 21; the owner's moic, inside one shell command from 14:31,
 * three messages unanswered and nothing saying why). Read from the ledger: a message of yours sent while a step OF THE
 * AGENT'S OWN had started and not ended waits, until the agent can read it or has shown it did (genie#1473, measured in the
 * ledgers; test/waiting-answered-1473.test.tsx has the rows):
 *  - its own steps have all ended: the boundary Claude reads queued messages at. One ending while another of the batch runs
 *    leaves the message waiting, behind that one;
 *  - it says something, a reply or a thought: it is past those steps, so whatever still reads open is a step whose end was
 *    never recorded, and holds nothing, this message or a later one. A later step of its own proves nothing: Claude starts
 *    a batch's calls while still writing them;
 *  - the turn ends or is stopped.
 * A SUBAGENT's steps are neither: the agent runs beside them and reads your message straight away, and their rows say
 * nothing about it having read anything. A message sent between steps does not wait.
 */
export function waitingMessages(ledger: readonly TimedEvent[]): Map<string, ChatWaitingOn> {
    /** The agent's own steps started and not ended, in the turn now running: id → what it is and when it started. */
    const open = new Map<string, ChatWaitingOn>();
    /** Messages waiting, and the step each waits behind. */
    const waits = new Map<string, { on: string; waiting: ChatWaitingOn }>();
    for (const { id, event: e, at } of ledger) {
        if (e.kind === 'turn' || e.kind === 'stopped' || e.kind === 'run') {
            open.clear();
            waits.clear();
            continue;
        }
        if ((e.kind === 'think' || (e.kind === 'message' && e.speaker === 'agent')) && e.text.trim() !== '') {
            open.clear();
            waits.clear();
            continue;
        }
        if (e.kind === 'tool') {
            if (e.toolCallId === '' || e.parentToolCallId !== undefined) continue;
            if (e.status === 'completed' || e.status === 'failed') {
                open.delete(e.toolCallId);
                const running = [...open.entries()].at(-1);
                for (const [m, w] of waits) {
                    if (w.on !== e.toolCallId) continue;
                    if (running) waits.set(m, { on: running[0], waiting: running[1] });
                    else waits.delete(m);
                }
                continue;
            }
            const known = open.get(e.toolCallId);
            // A row of a call often has no title: the name it started under stands, and one that started before the agent last spoke has none to stand on.
            const step = (known && !e.title ? known.step : e.title || e.name) || 'a step';
            open.set(e.toolCallId, { step, since: known?.since ?? at, kind: e.toolKind ?? known?.kind ?? null });
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

/** Rows after which nothing earlier changes a chat message: each resets the waiting state, and starts a fresh run of thoughts. */
const BOUNDARY = new Set(['turn', 'stopped', 'run']);

/**
 * WHERE AN UPDATE STARTS READING THE LEDGER (the owner, 2026-10-22: never recompute the whole thread per update).
 *
 * Everything a chat message depends on comes from rows at or after the last turn/stopped/run boundary before it: whether
 * it waits behind a step (`waitingMessages` clears at each boundary), whether thoughts merge (a boundary is not a
 * thought), and a queued prompt's delivery (it always follows its message). So the chat's last `lines` lines are derived
 * exactly from the boundary at or before where those lines begin — `0` when the ledger holds fewer, or has no boundary
 * there. Walks back only as far as it needs: the window, and the turn it starts in.
 */
export function chatTailStart(ledger: readonly TimedEvent[], lines: number): number {
    let seen = 0;
    let i = ledger.length - 1;
    for (; i >= 0; i -= 1) {
        const e = ledger[i]!.event;
        if (inboxNotice(e)) continue;
        if (e.kind === 'message' || e.kind === 'think') seen += messageLines(e);
        else if (e.kind === 'stopped' || e.kind === 'divider') seen += 1;
        if (seen >= lines) break;
    }
    for (; i > 0; i -= 1) if (BOUNDARY.has(ledger[i]!.event.kind)) return i;
    return 0;
}

/**
 * The chat thread for a subject. `lines`: derive only the last `lines` lines' worth of the ledger (from
 * {@link chatTailStart}) — what an update while Following Live needs; absent = the whole history.
 */
export function chatThreadFrom(detail: ChatDetail | null, subjectId: string, rows: readonly AgentRow[], _now: () => number, lines?: number): ChatThreadView {
    const row = rows.find((r) => r.id === subjectId || r.name === subjectId) ?? null;
    // Only the SUBJECT's detail is its conversation (a route may name it by id or, for genie, by name). A detail still
    // loaded for another agent is never drawn under this one's name.
    const own = detail !== null && (detail.agent.id === subjectId || detail.agent.id === row?.id || detail.agent.name === subjectId);
    if (!own) detail = null;
    // ROWS STILL COMING (Tynn #659): the mail is there at once and the replies are not, so drawing it would be a chat of
    // mail cards alone — the switch the owner saw. Not loaded: the chat draws loading until the conversation is whole.
    const conversation = detail !== null && detail.rowsPending !== true ? detail : null;
    const start = conversation && lines !== undefined ? chatTailStart(conversation.rows, lines) : 0;
    const messages = conversation ? tailMessages(conversation, rows, start) : [];
    return {
        agentId: subjectId,
        name: detail?.agent.name ?? row?.name ?? subjectId,
        fidelity: detail?.agent.fidelity ?? row?.fidelity ?? 'declared',
        unread: null,
        messages,
        context: detail ? chatContext(detail) : null,
        loaded: conversation !== null,
        earlier: start > 0,
        arriving: conversation ? arrivingMessageId(conversation, messages) : null,
    };
}

/** Rows that say nothing new about the conversation: they arrive beside a reply without ending it. */
function quiet(e: StreamEvent): boolean {
    return e.kind === 'usage' || e.kind === 'prompt_delivery' || e.kind === 'unknown' || (e.kind === 'notice' && e.level === 'debug');
}

/**
 * THE MESSAGE STILL ARRIVING (react-fancy 5.68 `streaming="progressive"`): the agent's words — a reply or a thought — that
 * are the last thing in its ledger while its turn is working. react-fancy draws that one progressively (an open <result>
 * as its card with the body so far, an open fence as code with no copy button yet) and every other message whole, which
 * is its contract: `streaming={done ? false : "progressive"}`. Anything after it that says something (a tool call, a
 * turn boundary, your message) means it is finished; so does a turn that is not working. A peer's message is delivered
 * whole and never arrives.
 */
export function arrivingMessageId(detail: ChatDetail, messages: readonly ChatMessage[]): string | null {
    const s = detail.session;
    if (!s || !s.running || s.turnState !== 'working') return null;
    let at = detail.rows.length - 1;
    while (at >= 0 && quiet(detail.rows[at]!.event)) at -= 1;
    const last: TimedEvent | undefined = detail.rows[at];
    if (!last) return null;
    const e = last.event;
    const id = last.id;
    if (e.kind === 'message' && e.speaker === 'agent') return messages.some((m) => m.id === id && m.who === 'agent') ? id : null;
    if (e.kind === 'think') {
        // Thoughts in a row are one message, under the first one's id: the thinking row last in the thread holds it.
        const thought = [...messages].reverse().find((m) => m.who === 'thinking');
        return thought?.id ?? null;
    }
    return null;
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
 * ONE LINE OF WHAT A MESSAGE SAYS — a mail card's preview. The whole message, not its first line: an FTQ answer's first line
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
export function chatCommsOf(messages: readonly (MailLike & { readonly app?: { readonly label: string } })[], nameOf: (id: string) => string | null = () => null): MailLike[] {
    // BOTH ENDS NAMED WHERE THE REGISTRY IS (Tynn #621): the chat's own rows are one workspace's agents, and a sender outside
    // them (Genie's own agent, an agent of another workspace, an app) was shown as its raw id.
    const named = (id: string, app?: { readonly label: string }): string | null => (id === 'human' ? null : app?.label ?? nameOf(id));
    return messages.map((m) => {
        const fromName = named(m.from, m.app);
        const toName = named(m.to);
        return { id: m.id, from: m.from, to: m.to, text: m.text, sentAt: m.sentAt, readAt: m.readAt,
            ...(fromName !== null ? { fromName } : {}), ...(toName !== null ? { toName } : {}),
            ...(m.deliveryRefusal ? { deliveryRefusal: m.deliveryRefusal } : {}),
        };
    });
}

/**
 * The agent's AgentInbox mail as MAIL rows — with the person and with other agents, either way (beta.33 items 7 + 18):
 * `you → atlas`, `atlas → wren`, with the whole text, each opening its message in the AgentInbox. Mail between two other
 * agents is not this agent's.
 */
function commsRows(detail: ChatDetail, rows: readonly AgentRow[]): ChatMessage[] {
    return mailRows(detail.comms ?? [], detail.agent.id, detail.agent.name, rows);
}

/** One mail record and receipt in declared and observed chats, on either side of the conversation. */
function mailRows(messages: readonly MailLike[], self: string, selfName: string, rows: readonly AgentRow[]): ChatMessage[] {
    // Never the id: the rows' name, else the name main carried, else words.
    const name = (id: string, carried: string | undefined): string => (id === 'human' ? 'you' : id === self ? selfName : rows.find((r) => r.id === id)?.name ?? carried ?? UNNAMED_AGENT);
    return messages
        .filter((m) => m.from === self || m.to === self)
        .map((m) => {
            const at = Date.parse(m.sentAt);
            const delivered = m.readAt != null;
            return { id: m.id, who: 'mail' as const, from: `${name(m.from, m.fromName)} → ${name(m.to, m.toName)}`, text: m.text, delivered, at: Number.isNaN(at) ? null : at, mailId: m.id,
                ...(!delivered && m.deliveryRefusal ? { reason: m.deliveryRefusal.reason } : {}),
            };
        });
}

/**
 * The messages from ledger row `start` on, with the mail among them. Mail sent before the first of those messages is
 * earlier history, as it is in the whole chat — placed before it there, it would arrive at the top of this one.
 */
function tailMessages(detail: ChatDetail, rows: readonly AgentRow[], start: number): ChatMessage[] {
    if (start === 0) return byTime(chatMessages(detail, rows), commsRows(detail, rows));
    const own = chatMessages({ ...detail, rows: detail.rows.slice(start) }, rows);
    const first = own.find((m) => m.at !== null)?.at ?? null;
    const mail = commsRows(detail, rows).filter((m) => m.at === null || (first !== null && m.at > first));
    return byTime(own, mail);
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
    /** Each end's name as main read it from the registry (Tynn #621); absent = the person, or nobody it knows. */
    readonly fromName?: string;
    readonly toName?: string;
    readonly deliveryRefusal?: { readonly attempts: number; readonly reason: string; readonly at: string };
}

/**
 * AN OBSERVED AGENT'S CHAT IS ITS INBOX THREAD (§4.4). Shared mail cards include its peer conversations and receipts;
 * `unread` still counts its mail to the person that the person has not read. A Take Over window's replies in its
 * terminal are not here — that TUI does not report them. `recent === null` (the inbox not read yet) gives `unread:
 * null`, never `0`, which would claim you are up to date.
 */
export function observedMail(recent: readonly MailLike[] | null, agentId: string, name: string, rows: readonly AgentRow[] = []): { messages: ChatMessage[]; unread: number | null } {
    if (recent === null) return { messages: [], unread: null };
    return { messages: mailRows(recent, agentId, name, rows), unread: recent.filter(m => m.from === agentId && m.to === 'human' && m.readAt === null).length };
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

/**
 * WHAT THE CHAT READS OF THE ESTATE'S AGENTS (genie#1340): their ids, names and fidelity — the subject's name, a mail
 * sender's name — and nothing else. The estate snapshot changes whenever any agent's status does (20 times a second
 * with eleven at work); keyed on this, the chat's thread is derived again only when something it shows could change.
 */
export function chatAgentsKey(rows: readonly AgentRow[]): string {
    return rows.map((r) => `${r.id}\u0000${r.name}\u0000${r.fidelity}`).join('\u0001');
}
