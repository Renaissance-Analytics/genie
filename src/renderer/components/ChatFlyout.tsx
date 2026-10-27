import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ContentRenderer, Icon, PromptInput } from '@particle-academy/react-fancy';
import type { Approval } from '../../core/approval.js';
import { toPromptCmds, type ProviderCommand } from '../../core/provider-commands.js';
import { fileLinkTarget, linkFileRefs } from '../../core/chat-file-links.js';
import { atThreadEnd, clampChatDockWidth, readChatDockWidth, writeChatDockWidth } from '../../core/chat-width.js';
import { ApprovalCard } from './ApprovalCard.js';
import type { Fidelity } from '../../core/dashboard-view.js';
import { CHAT_LIVE_LINES, chatWindowStart } from '../../core/chat-window.js';
import { chatFollowKey, mailSubject, type ChatContext, type ChatMessage, type ChatWaitingOn } from '../../core/chat-view.js';
import type { Attachment } from '../../core/prompt-content.js';
import type { ChatScope } from '../../core/chat-scope.js';
import { namePastedImages, PASTE_PILL_CHARS, type ComposerMeter } from '../../core/composer.js';
import { keepChat } from '../../core/chat-drafts.js';
import { TurnStop } from './TurnStop.js';

/**
 * THE CHAT FLYOUT — the only place a human types to an agent.
 *
 * It replaces the Agent view's composer. There is exactly one composer in the application, and
 * a parked approval renders wherever it is — see `approvalPlacement`. One actionable rendering,
 * one marker, never two sets of buttons for one decision.
 *
 * ## Docked, always
 *
 * The owner, 2026-10-17: "get rid of the chat flyout and make the pinned chat be the only chat ux". The chat sits in the
 * dock: a gutter that starts *below* the view header — the header keeps its width and position, and the content
 * reflows into what is left (`Shell`, `core/dock.ts`). Nothing is overlaid. It stays until it is closed (its close
 * button, or ⌘J / Ctrl+J); `Esc` does not close it.
 *
 * **The person sets the width** by dragging the left edge (Tynn #798), and it is remembered; the content row's
 * reserve reads the same number, so the two never diverge.
 *
 * ## Not a `Drawer`
 *
 * Fancy has one, and it is the wrong component: a drawer implies a scrim, and a scrim is
 * precisely the thing a pin removes. A pinned panel that dimmed the work behind it would make
 * the pin pointless.
 */

/** One message as the chat draws it (`core/chat-view.ts`'s `ChatMessage`, its optional parts optional). */
export type ChatThreadMessage = Pick<ChatMessage, 'id' | 'from' | 'text' | 'delivered'> & Partial<Pick<ChatMessage, 'who' | 'at' | 'read' | 'attachments' | 'reason' | 'resend' | 'mailId' | 'mail' | 'waiting' | 'queued' | 'queuedForProvider' | 'promptId' | 'draftProblem'>>;

export interface ChatThread {
    agentId: string;
    name: string;
    fidelity: Fidelity;
    /** `null` when the count could not be read — never `0`, which claims you are up to date. */
    unread: number | null;
    /** The transcript (`core/chat-view.ts`): message events only — no thought ever appears in chat. */
    messages: readonly ChatThreadMessage[];
    /** The line under the header — what the agent is doing, in the board's words; `null` = not read yet. */
    context?: ChatContext | null | undefined;
    /** The subject's own conversation is loaded (`core/chat-view.ts`); absent = not said, drawn as not loaded. */
    loaded?: boolean | undefined;
    /** Ledger rows lie before these messages (`core/chat-view.ts` chatTailStart): more history pages in on request. */
    earlier?: boolean | undefined;
}

const CONTEXT_TONE = { ok: 'text-[var(--success)]', warn: 'text-[var(--warning)]', bad: 'text-[var(--danger)]', muted: 'text-[var(--fg-3)]' } as const;

/** `13:58` from epoch ms, in the local clock — only ever called with a real time. */
/** genie's tab mark: Genie's own gradient, the title bar's mark in small — the OS agent has no state to guess. */
export function GenieMark() {
    return <span data-genie-mark="" className="size-2 shrink-0 rounded-[2px] bg-gradient-to-br from-[var(--brand-grad-from)] via-[var(--brand-grad-via)] to-[var(--brand-grad-to)]" aria-hidden />;
}

/**
 * An agent's or a peer's reply, RENDERED (the owner): Markdown through Fancy's ContentRenderer, sanitised by default.
 * MEMOISED on its text: the chat re-rendered EVERY reply's Markdown on every push of a busy agent, which is many a second
 * (the owner, 2026-10-20: "severe UI lag like 3 seconds to show any text at all"). Only the reply that grew renders again.
 */
const ChatReply = memo(function ChatReply({ text, linkFiles }: { text: string; linkFiles: boolean }) {
    return <ContentRenderer value={linkFiles ? linkFileRefs(text) : text} format="markdown" lineSpacing={1.5} className="text-[13px] text-[var(--fg-2)]" />;
});

function clock(at: number): string {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * YOUR MESSAGE IS WAITING BEHIND A STEP (beta.33 item 21; the owner: three messages unanswered while moic ran one shell
 * command, "with nothing on screen saying why"). Which step, running since when; and — the owner's choice, FTQ
 * q_91b3cddf — `Interrupt and send`: the current turn ends (the Stop-this-turn path) and what waits runs next, in order.
 * Without a way to stop the turn here, it still says why, with no dead button. Hook-free.
 */
export function ChatWaiting({ id, agentName, waiting, onInterruptAndSend }: { id: string; agentName: string; waiting: ChatWaitingOn; onInterruptAndSend?: (() => void) | undefined }) {
    return (
        <div data-chat-waiting={id} className="flex max-w-full flex-col items-end gap-1 text-right text-[12px] text-[var(--warning)]">
            <span>{`Waiting — ${agentName} reads it when this step ends:`}</span>
            <span className="font-mono text-[11px] text-[var(--fg-2)]">{waiting.step}</span>
            {waiting.since !== null ? <span className="font-mono text-[11px] text-[var(--fg-4)]">{`running since ${clock(waiting.since)}`}</span> : null}
            {onInterruptAndSend ? (
                <button type="button" data-action="interrupt-and-send" data-message={id} title={`Stop ${agentName}'s current turn; what you sent runs next, in order`} onClick={() => onInterruptAndSend()} className="rounded-lg border border-[var(--warning)] bg-[var(--warning)]/10 px-2.5 py-1 text-[12px] font-medium text-[var(--fg-1)] hover:bg-[var(--warning)]/20">
                    Interrupt and send
                </button>
            ) : null}
        </div>
    );
}

/**
 * A PIECE OF AGENTINBOX MAIL in the chat (beta.33 items 7 + 18; the owner: "I need to be able to see the context in
 * agentInbox deliveries … click an inbox post and have it open the agent inbox"). Who to whom and when, then a short
 * preview (2026-10-21: no longer the whole message) — an FTQ answer reads as its question's header, the option chosen and
 * the note, on one line. The head opens that
 * message in the AgentInbox; with nowhere to open it (the doctor window), it is plain text, never a dead button.
 * Hook-free, so a test can press it.
 */
export function ChatMailRow({ m, onOpenMail }: { m: ChatThreadMessage; onOpenMail?: ((messageId: string) => void) | undefined }) {
    const head = (
        <>
            <Icon name="mail" size="xs" />
            <span>{m.from}</span>
            <span className="text-[var(--fg-4)]">· AgentInbox{m.at !== null && m.at !== undefined ? <> · <span data-chat-time={m.at}>{clock(m.at)}</span></> : null}</span>
        </>
    );
    const mailId = m.mailId ?? m.id;
    return (
        <div data-chat-message={m.id} data-who="mail" className="flex max-w-[94%] flex-col gap-1 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] px-2.5 py-2">
            {onOpenMail ? (
                <button type="button" data-open-mail={mailId} title="Open this message in the AgentInbox" onClick={() => onOpenMail(mailId)} className="flex items-center gap-1.5 self-start font-mono text-[11px] text-[var(--violet-400)] hover:underline">
                    {head}
                </button>
            ) : (
                <div className="flex items-center gap-1.5 font-mono text-[11px] text-[var(--violet-400)]">{head}</div>
            )}
            {/* A SHORT PREVIEW, not the message (the owner, 2026-10-21: "I don't need to see so much content, that is what the
                link to open it is for"): one plain line of it, at most two lines tall; the head opens it in full. */}
            <p data-mail-preview={m.id} className="line-clamp-2 text-[13px] text-[var(--fg-2)]">{mailSubject(m.text)}</p>
        </div>
    );
}

/**
 * GENIE'S NOTICE TURN, WITH ITS CONTEXT: `genie → atlas · told atlas about 2 AgentInbox messages`, then one entry per
 * message — who wrote it and one line of what it says — each opening that message. The notice's own words to the agent
 * ("collect it with agentinbox receive") are an instruction to it, not something for the person to read. Hook-free.
 */
export function ChatDeliveryRow({ m, onOpenMail }: { m: ChatThreadMessage; onOpenMail?: ((messageId: string) => void) | undefined }) {
    return (
        <div data-chat-message={m.id} data-who="delivery" className="flex flex-col gap-1 font-mono text-[11px] text-[var(--fg-3)]">
            <div className="flex items-center gap-2">
                <span className="text-[var(--violet-400)]"><Icon name="mail" size="xs" /></span>
                <span>{`${m.from} · ${m.text}`}</span>
                {m.at !== null && m.at !== undefined ? <span className="text-[var(--fg-4)]">· <span data-chat-time={m.at}>{clock(m.at)}</span></span> : null}
            </div>
            <ul className="flex flex-col gap-0.5 pl-5">
                {(m.mail ?? []).map((ref) => {
                    const body = <><span className="shrink-0 text-[var(--fg-2)]">{`from ${ref.from}`}</span><span className="min-w-0 truncate font-sans text-[12px] text-[var(--fg-2)]">{ref.subject}</span></>;
                    return (
                        <li key={ref.id} data-delivery-mail={ref.id}>
                            {onOpenMail ? (
                                <button type="button" data-open-mail={ref.id} title="Open this message in the AgentInbox" onClick={() => onOpenMail(ref.id)} className="flex w-full min-w-0 items-baseline gap-2 rounded px-1 text-left hover:bg-[var(--bg-2)]">{body}</button>
                            ) : (
                                <div className="flex min-w-0 items-baseline gap-2 px-1">{body}</div>
                            )}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

export interface ChatFlyoutProps {
    thread: ChatThread | null;
    /** How many lines the chat shows now (core/chat-window.ts): the caller derives only those from the ledger. */
    onWindowLines?: ((lines: number) => void) | undefined;
    /**
     * The chat agent's REAL context usage and window (`core/composer.ts` `composerMeter`), for the composer's meter.
     * `null` or absent = not reported, and then there is no meter — never a made-up window.
     */
    contextUsage?: ComposerMeter | null | undefined;
    /**
     * The approval to answer HERE, when this is where the composer is.
     *
     * Passed in rather than read from the thread, because which surface owns an approval is a
     * decision (`approvalPlacement`) and not a property of the conversation.
     */
    approval?: Approval | null | undefined;
    /**
     * Open a file the chat names, in the agent's workspace (core/chat-file-links.ts). Absent = nowhere to open it (genie's
     * own chat), and file references stay plain text.
     */
    onOpenFile?: ((path: string, line: number | null) => void) | undefined;
    /** Open a piece of AgentInbox mail the chat shows, by its inbox id. Absent = nowhere to open it; the rows stay text. */
    onOpenMail?: ((messageId: string) => void) | undefined;
    /** The agent's own commands and skills (core/provider-commands.ts), offered in the composer's `/` menu. */
    commands?: readonly ProviderCommand[] | null | undefined;
    /** The option id in flight for THIS chat's parked approval (core/approval-answering.ts); `null` = none. */
    answeringApproval?: string | null | undefined;
    /** The host's refusal of the last answer to THIS approval, in words, for the card. */
    approvalRefusal?: string | null | undefined;
    /** `note`: the person's words with the answer (beta.33 item 16), delivered to the agent; absent = none. */
    onAnswerApproval?: ((optionId: string, note?: string) => void) | undefined;
    /**
     * `agentId`: the chat the message was typed in (genie#1261) — each chat has its own composer, and reading the
     * attachments is async, so the chat on screen by the time it is sent may be another.
     */
    onSend: (text: string, attachments?: readonly Attachment[], agentId?: string) => void;
    /** Absent = no close button (the doctor window: the chat is the page, not a panel). */
    onClose?: (() => void) | undefined;
    /**
     * An undelivered draft's action (§4.4), by its id: `Send now` while the agent runs, else the chat's ONE `Restart`
     * (genie#1238) — the agent is restarted and every undelivered message to it is sent, in order.
     */
    onRestartAndSend?: ((draftId: string) => void) | undefined;
    /** Put an undelivered draft away, unsent (the owner, 2026-10-20: it was "stuck on my screen"). */
    onDiscardDraft?: ((draftId: string) => void) | undefined;
    /**
     * Present = a turn is running AND it can be stopped with the agent kept (`turnStopOffered`): `Stop this turn` sits on
     * the context line, with the turn's status. Absent = no turn Stop in the chat — never a Stop that ends the agent.
     */
    onStopTurn?: (() => void) | undefined;
    /**
     * `Interrupt and send` on a message waiting behind a step (beta.33 item 21): end the current turn so what waits runs
     * next. Absent = this turn cannot be stopped from here; the waiting message still says why.
     */
    onInterruptAndSend?: (() => void) | undefined;
    /** Present = the agent's provider login is held for its rate limit: `Resume now` on the context line (Tynn #794). */
    onResumeLimit?: (() => void) | undefined;
    /** Signed out: `Log in` on the context line, with the provider's name. */
    onProviderLogin?: { name: string; run: () => void } | undefined;
    /** Its account paused by the provider: `Try again` on the context line, for every agent on that login. */
    onAccountRetry?: (() => void) | undefined;
    /** A tool was refused for want of Claude Design's login (#1081): `Log in to Claude Design` on the context line. */
    onDesignLogin?: (() => void) | undefined;
    /** Where the width is remembered; absent = the window's localStorage (tests pass their own). */
    widthStorage?: Pick<Storage, 'getItem' | 'setItem'> | null | undefined;
    /** The width the dock gives the chat (the content row reserves the same; Tynn #798). Absent = the remembered width. */
    dockWidth?: number | undefined;
    /** The edge was dragged — the new width, live, so the reserve follows; the panel remembers it at the drag's end. */
    onDockWidth?: ((width: number) => void) | undefined;
    /**
     * The chat's agent against the workspace on screen (`core/chat-scope.ts`). `elsewhere`: the composer and the header
     * NAME the agent's workspace. `blocked`: the workspace on screen has no agent to message — the reason replaces the
     * composer. Absent = `here` (the doctor window, which has no workspace on screen).
     */
    scope?: ChatScope | undefined;
}

const browserStorage = (): Pick<Storage, 'getItem' | 'setItem'> | null => {
    try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
};

/**
 * The composer's picks as bytes: react-fancy's `PromptAttachment` carries the `File` the person attached (5.10.0,
 * react-fancy#16). One without a File (restored, not picked) cannot be sent, so it is named in the text that goes,
 * rather than vanishing.
 */
async function readAttachments(picked: readonly { name: string; file?: File; type?: string }[]): Promise<Attachment[]> {
    return Promise.all(picked.map(async (a) => ({ name: a.name, type: a.file?.type ?? a.type ?? '', bytes: a.file ? new Uint8Array(await a.file.arrayBuffer()) : new Uint8Array(0) })));
}

export function ChatFlyout({
    thread, onWindowLines, contextUsage = null, approval, commands, answeringApproval, approvalRefusal, onAnswerApproval,
    onSend, onClose, onOpenFile, onOpenMail, onRestartAndSend, onDiscardDraft, onStopTurn, onInterruptAndSend, onResumeLimit, onProviderLogin, onAccountRetry, onDesignLogin, widthStorage, scope, dockWidth, onDockWidth,
}: ChatFlyoutProps) {
    const storage = widthStorage === undefined ? browserStorage() : widthStorage;
    const [ownDockWidth, setOwnDockWidth] = useState(() => readChatDockWidth(storage));
    const width = dockWidth ?? ownDockWidth;
    const setWidth = (w: number) => { setOwnDockWidth(w); onDockWidth?.(w); };

    /**
     * Drag the LEFT edge (the panel is anchored right). Pointer capture keeps the drag alive over whatever is underneath;
     * the width is clamped so the view keeps its room, handed up live so the reserve follows, and written once, when the
     * drag ends.
     */
    const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const startX = e.clientX;
        const from = width;
        let last = from;
        const onMove = (ev: PointerEvent) => { last = clampChatDockWidth(from + (startX - ev.clientX), window.innerWidth); setWidth(last); };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            writeChatDockWidth(storage, last);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };
    /** The same separator from the keyboard: arrows move the edge 16px, and the width is kept. */
    const keyResize = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        const step = e.key === 'ArrowLeft' ? 16 : e.key === 'ArrowRight' ? -16 : 0;
        if (step === 0) return;
        e.preventDefault();
        const next = clampChatDockWidth(width + step, window.innerWidth);
        setWidth(next);
        writeChatDockWidth(storage, next);
    };

    /**
     * Follow the end of the thread while the person is AT the end; once they scroll up to read,
     * new messages do not drag them back down. Opening a thread starts at its end.
     */
    const scrollRef = useRef<HTMLDivElement>(null);
    const followRef = useRef(true);
    // What the end of the thread IS: its agent, how many messages, and how long the last one is — a reply is one row that
    // GROWS as the agent writes (beta.33 item 6), and keyed on the count alone its words were written below a chat that
    // did not move until the next message arrived.
    const followKey = chatFollowKey(thread?.agentId ?? null, thread?.messages ?? []);
    /**
     * FOLLOWING LIVE = THE LAST 500 LINES (the owner, 2026-10-22; core/chat-window.ts). Only the messages holding the
     * thread's last `lines` lines are drawn; the rest stays in memory. Earlier history pages in, another
     * CHAT_LIVE_LINES at a time, from the control at the top (or by scrolling to the top), keeping the reader's place;
     * back at the end, the window shrinks to the live 500 again.
     */
    const [lines, setLines] = useState(CHAT_LIVE_LINES);
    const messages = thread?.messages ?? [];
    const windowStart = chatWindowStart(messages, lines);
    const shown = windowStart === 0 ? messages : messages.slice(windowStart);
    // ONE RESTART IN THE CHAT (genie#1238): on the latest message waiting for one — the restart sends every undelivered
    // message, in order, so a Restart on each was the same button many times over.
    const restartOn = [...messages].reverse().find((m) => (m.who ?? (m.from === 'you' ? 'you' : 'agent')) === 'you' && !m.delivered && !m.queued && !m.reason && m.resend !== 'send')?.id ?? null;
    /** The scroll height before a page of history was added: the reader stays on the message they were reading. */
    const anchorRef = useRef<number | null>(null);
    const showEarlier = () => {
        const el = scrollRef.current;
        anchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
        followRef.current = false;
        setLines((n) => n + CHAT_LIVE_LINES);
    };
    useLayoutEffect(() => { followRef.current = true; setLines(CHAT_LIVE_LINES); }, [thread?.agentId]);
    useEffect(() => { onWindowLines?.(lines); }, [lines, onWindowLines]);
    /** History behind what is drawn: messages held but not drawn, or ledger rows not derived yet. */
    const behind = windowStart > 0 || thread?.earlier === true;
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        if (anchorRef.current !== null) {
            el.scrollTop = el.scrollHeight - anchorRef.current;
            anchorRef.current = null;
        } else if (followRef.current) el.scrollTop = el.scrollHeight;
    }, [followKey, lines]);
    /**
     * An OBSERVED agent gets a different SHAPE of chat, not a disabled one.
     *
     * It is a TUI the user opened via Take Over. Genie can put a message in its AgentInbox and
     * cannot see what it says back, so the composer says `send to <name>'s inbox` and the head
     * chip reads `observed · mail only`. **Replies are not shown, because that TUI does not
     * report them** — an empty transcript there would read as an agent ignoring you.
     */
    const mailOnly = thread?.fidelity === 'observed';
    /**
     * WHO you are writing to, with WHERE when it is not the workspace on screen (the owner, beta.26: a message meant for
     * prism went to moic). `Message lark — in beta.example` can not be read as the project you are looking at.
     */
    const elsewhere = scope?.kind === 'elsewhere' ? scope.workspace : null;
    const blocked = scope?.kind === 'blocked' ? scope.reason : null;
    const addressee = thread ? (elsewhere ? `${thread.name} — in ${elsewhere}` : thread.name) : null;
    /**
     * ONE DRAFT PER CHAT (genie#1261, core/chat-drafts.ts): every chat typed in keeps its own composer, so a half-typed
     * message stays with the chat it was typed in. Updated during render — the documented "adjust state while rendering"
     * pattern — so the chat's own composer is there on the first frame it is shown; `keepChat` returns the same list
     * once it is in, so this settles in one pass.
     */
    const activeChat = blocked ? null : thread?.agentId ?? '';
    const [chats, setChats] = useState<readonly string[]>(() => keepChat([], activeChat));
    const keptChats = keepChat(chats, activeChat);
    if (keptChats !== chats) setChats(keptChats);

    return (
        <aside
            data-chat="pinned"
            // Whether the subject's own conversation is loaded — the smoke reads it on a page reached without `chat=`.
            data-chat-loaded={thread?.loaded ? 'true' : 'false'}
            // Whose chat this is — the smoke reads it after a Dashboard row click (genie#1209).
            data-chat-subject={thread?.agentId ?? ''}
            style={{ width }}
            className="relative flex min-h-0 min-w-0 shrink-0 flex-col border-l border-[var(--border-1)] bg-[var(--surface)]"
        >
            {/* The left edge (Tynn #798): drag it, or arrow it, to size the dock — remembered. */}
            <div
                data-chat-resize=""
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize chat"
                aria-valuenow={width}
                tabIndex={0}
                onPointerDown={startResize}
                onKeyDown={keyResize}
                className="absolute inset-y-0 left-0 z-30 w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-[var(--accent)]/40 focus-visible:bg-[var(--accent)]/40 focus-visible:outline-none"
            />
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border-1)] px-3">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {thread ? thread.name : 'genie'}
                </span>

                {elsewhere ? (
                    <span data-chat-scope="elsewhere" title={`${thread?.name ?? 'This agent'} is in ${elsewhere}, not the workspace on screen`} className="shrink-0 rounded-sm bg-[var(--warning)]/15 px-1.5 py-px font-mono text-[10px] text-[var(--warning)]">
                        in {elsewhere}
                    </span>
                ) : null}

                {mailOnly ? (
                    <span data-chat-chip="mail-only" className="rounded-sm bg-[var(--bg-2)] px-1.5 py-px font-mono text-[10px] text-[var(--fg-3)]">
                        observed · mail only
                    </span>
                ) : null}

                {/* The unread count, or nothing. `0` would claim you are up to date, which is a
                    different statement from "we could not read the count". */}
                {thread?.unread !== null && thread?.unread !== undefined && thread.unread > 0 ? (
                    <span data-chat-unread={thread.unread} className="rounded-sm bg-[var(--warning)]/15 px-1.5 font-mono text-[11px] text-[var(--warning)]">
                        {thread.unread}
                    </span>
                ) : null}

                {onClose ? (
                    <button
                        type="button"
                        aria-label="Close chat"
                        onClick={onClose}
                        className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--fg-4)] hover:bg-[var(--bg-2)]"
                    >
                        <Icon name="x" size="xs" />
                    </button>
                ) : null}
            </div>

            {/* THE CONTEXT LINE: what the agent is doing, in the board's words. Absent until read — never "Idle" as a guess.
                While a turn runs that can be stopped, `Stop this turn` sits at its end: with the turn, not under Send. */}
            {thread?.context || onStopTurn || onResumeLimit || onProviderLogin || onAccountRetry || onDesignLogin ? (
                <div data-chat-context={thread?.context?.tone ?? 'ok'} {...(thread?.context?.title ? { title: thread.context.title } : {})} className={`flex shrink-0 items-center gap-2 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-4 py-1.5 text-[12px] ${CONTEXT_TONE[thread?.context?.tone ?? 'ok']}`}>
                    {thread?.context?.text ?? 'Working'}
                    {onStopTurn ? <TurnStop onStop={onStopTurn} agentName={thread?.name} className="ml-auto" /> : null}
                    {onProviderLogin ? (
                        <button
                            type="button"
                            data-action="provider-login"
                            title={`Open the ${onProviderLogin.name} login in a window of its own`}
                            onClick={() => onProviderLogin.run()}
                            className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--warning)] bg-[var(--warning)]/10 px-2 py-0.5 text-xs text-[var(--fg-1)] hover:bg-[var(--warning)]/20"
                        >
                            Log in to {onProviderLogin.name}
                        </button>
                    ) : null}
                    {onAccountRetry ? (
                        <button
                            type="button"
                            data-action="account-retry"
                            title="Once the account is put right with the provider: every agent it stopped comes back"
                            onClick={() => onAccountRetry()}
                            className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--danger)] bg-[var(--danger)]/10 px-2 py-0.5 text-xs text-[var(--fg-1)] hover:bg-[var(--danger)]/20"
                        >
                            Try again
                        </button>
                    ) : null}
                    {onDesignLogin ? (
                        <button
                            type="button"
                            data-action="design-login"
                            title="Open Claude Code in a window of its own to run /design-login; this agent is told to retry once it has run"
                            onClick={() => onDesignLogin()}
                            className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--warning)] bg-[var(--warning)]/10 px-2 py-0.5 text-xs text-[var(--fg-1)] hover:bg-[var(--warning)]/20"
                        >
                            Log in to Claude Design
                        </button>
                    ) : null}
                    {onResumeLimit ? (
                        <button
                            type="button"
                            data-action="resume-limit"
                            title="Resume now — every agent waiting for this provider's rate limit goes on"
                            onClick={() => onResumeLimit()}
                            className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--border-1)] px-2 py-0.5 text-xs text-[var(--fg-1)] hover:bg-[var(--bg-2)]"
                        >
                            Resume now
                        </button>
                    ) : null}
                </div>
            ) : null}

            {/*
             * THE SCROLLER and THE COLUMN are two elements (the owner could not scroll at all): one element that
             * both scrolled and packed its messages to the bottom (`justify-end`) overflowed at its TOP, and
             * overflow at the start of a scroll container cannot be scrolled to — a long thread lost its top and
             * had no scrollbar. The column is at least as tall as the scroller, so a short thread still sits at the
             * bottom, and a long one grows downward, where scrolling reaches it.
             */}
            <div
                ref={scrollRef}
                data-chat-scroll=""
                onScroll={(e) => {
                    const el = e.currentTarget;
                    followRef.current = atThreadEnd(el.scrollTop, el.scrollHeight, el.clientHeight);
                    // Back at the end: Following Live again, so only the live 500 lines stay in the DOM.
                    if (followRef.current && lines > CHAT_LIVE_LINES) setLines(CHAT_LIVE_LINES);
                    // At the top with history behind: the next page comes in.
                    else if (el.scrollTop === 0 && behind) showEarlier();
                }}
                className="min-h-0 flex-1 overflow-y-auto"
            >
            <div
                data-chat-log=""
                className="flex min-h-full flex-col justify-end gap-3 px-3 py-3"
                // A file link (`#file:…`) opens the file in the agent's workspace, its tree revealed — never navigates the window.
                onClick={onOpenFile ? (e) => {
                    const a = (e.target as HTMLElement).closest?.('a');
                    const target = a ? fileLinkTarget(a.getAttribute('href') ?? '') : null;
                    if (!target) return;
                    e.preventDefault();
                    onOpenFile(target.path, target.line);
                } : undefined}
            >
                {/*
                 * An empty thread says NOTHING. No fake greeting, no system line, no "how can I
                 * help" — every one of those is a message the agent did not send, attributed to
                 * it, in the one place a person reads what it said.
                 *
                 * Three speakers, three shapes (the board): YOU on the right in a bubble; the agent
                 * BY NAME in violet; a peer as `wren → atlas`. Rendering `role` alone once labelled a
                 * sibling agent's message `user` — the same word as the owner's.
                 */}
                {/* THE OBSERVED FACT CARD (the board): what this chat IS for a Take Over window, said once at the top — not an
                    empty transcript, which would read as an agent ignoring you. */}
                {mailOnly && thread ? (
                    <div data-chat-fact="observed" className="mx-3 mb-2 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] px-3 py-2 text-[12px] leading-normal text-[var(--fg-3)]">
                        {thread.name} runs in a terminal. What you send here lands in its inbox, which it reads when its TUI asks, and mail it sends you shows here. Its replies in the terminal are not shown — that TUI does not report them.
                    </div>
                ) : null}
                {/* genie's empty thread (the board): what genie is for — the one thread with no work of its own to show. */}
                {thread?.agentId === 'genie' && thread.messages.length === 0 ? (
                    <div data-chat-empty="genie" className="my-auto flex flex-col items-start gap-1.5 px-1">
                        <div className="text-[14px] font-semibold">No messages with genie yet.</div>
                        <div className="text-[13px] leading-normal text-[var(--fg-3)]">genie can reach any agent in any workspace. Name one with @, or pick a thread above.</div>
                    </div>
                ) : null}
                {/* EARLIER HISTORY (core/chat-window.ts): how many messages are behind the window, and the page that brings them in. */}
                {behind ? (
                    <button type="button" data-chat-earlier={windowStart > 0 ? windowStart : 'more'} onClick={showEarlier} className="self-center rounded-full border border-[var(--border-1)] px-3 py-0.5 font-mono text-[11px] text-[var(--fg-3)] hover:bg-[var(--bg-1)]">
                        {windowStart > 0 ? `${windowStart.toLocaleString('en-US')} earlier ${windowStart === 1 ? 'message' : 'messages'} · show more` : 'Earlier messages · show more'}
                    </button>
                ) : null}
                {shown.map((m) => {
                    const who = m.who ?? (m.from === 'you' ? 'you' : 'agent');
                    const stamp = m.at !== null && m.at !== undefined ? <span data-chat-time={m.at} className="font-mono">{clock(m.at)}</span> : null;
                    // The agent's mail with another agent (the board): one mono line, the arrows icon — no bubble, no speaker.
                    // A STOPPED TURN (the composer's `Stop this turn`): one plain line where the reply ends.
                    if (who === 'stopped') {
                        return (
                            <div key={m.id} data-chat-message={m.id} data-who="stopped" className="flex items-center gap-2 font-mono text-[11px] text-[var(--fg-3)]">
                                <Icon name="square" size="xs" />
                                <span>{m.text}</span>
                                {stamp ? <span className="text-[var(--fg-4)]">· {stamp}</span> : null}
                            </div>
                        );
                    }
                    // THE AGENT'S THINKING (the owner, 2026-10-20): in its place among the replies, closed until you open it.
                    if (who === 'thinking') {
                        return (
                            <details key={m.id} data-chat-message={m.id} data-who="thinking" className="max-w-[94%] text-[12px] text-[var(--fg-3)]">
                                <summary className="group flex cursor-pointer select-none items-center gap-1.5 font-mono text-[11px] hover:text-[var(--fg-2)]">
                                    <Icon name="sparkles" size="xs" />
                                    {/* Underlined on hover so it reads as something to open (the owner, 2026-10-23: "I did not realize I could click the thinking row to expand it"). */}
                                    <span className="group-hover:underline">{m.from}’s thinking</span>
                                    {stamp ? <span className="text-[var(--fg-4)]">· {stamp}</span> : null}
                                </summary>
                                <div className="mt-1 border-l-2 border-[var(--border-1)] pl-2.5">
                                    <ChatReply text={m.text} linkFiles={Boolean(onOpenFile)} />
                                </div>
                            </details>
                        );
                    }
                    if (who === 'mail') return <ChatMailRow key={m.id} m={m} onOpenMail={onOpenMail} />;
                    if (who === 'delivery') return <ChatDeliveryRow key={m.id} m={m} onOpenMail={onOpenMail} />;
                    if (who === 'system') {
                        return (
                            <div key={m.id} data-chat-message={m.id} data-who="system" className="flex items-center gap-2 font-mono text-[11px] text-[var(--fg-3)]">
                                <span className="text-[var(--violet-400)]"><Icon name="arrow-right-left" size="xs" /></span>
                                <span>{m.text}</span>
                            </div>
                        );
                    }
                    return who === 'you' ? (
                        <div key={m.id} data-chat-message={m.id} data-who="you" className="flex max-w-[86%] flex-col items-end gap-1 self-end">
                            <div className="font-mono text-[11px] text-[var(--fg-3)]">you{stamp ? <> · {stamp}</> : null}</div>
                            {/* As you typed it (the owner, 2026-10-21): your newlines kept, a long word or URL broken rather than overflowing. */}
                            <div data-chat-user-text="" className={`whitespace-pre-wrap break-words rounded-[10px] border px-2.5 py-2 text-[13px] leading-normal ${m.delivered || m.queued ? 'border-[var(--border-1)] bg-[var(--bg-2)]' : 'border-dashed border-[var(--danger)] bg-[var(--bg-2)]'}`}>{m.text}</div>
                            {m.attachments ? (
                                <div data-chat-attachments={m.id} className="flex flex-wrap justify-end gap-1">
                                    {m.attachments.map((name) => (
                                        <span key={name} className="flex items-center gap-1 rounded-md border border-[var(--border-1)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--fg-3)]"><Icon name="paperclip" size="xs" />{name}</span>
                                    ))}
                                </div>
                            ) : null}
                            {/*
                             * An undelivered message is KEPT and MARKED, with the route to send it:
                             * the agent is not running. Dropping it loses what someone wrote, and
                             * showing it as sent is worse — they would wait for an answer that
                             * cannot come.
                             */}
                            {/* Your mail to a Take Over window: whether it has read it — the inbox's own receipt. */}
                            {m.waiting && m.delivered ? <ChatWaiting id={m.id} agentName={thread?.name ?? 'the agent'} waiting={m.waiting} onInterruptAndSend={onInterruptAndSend} /> : null}
                            {mailOnly && m.read !== undefined ? (
                                <span data-chat-read={m.id} className="font-mono text-[11px] text-[var(--fg-4)]">{m.read === null ? 'not read yet' : `read ${clock(m.read)}`}</span>
                            ) : null}
                            {m.queued ? <span data-chat-queued={m.id} className="font-mono text-[11px] text-[var(--fg-3)]">{m.queuedForProvider ? 'Queued · waiting for the provider to resume' : 'Queued · waiting for the current turn to end'}</span> : null}
                            {m.delivered || m.queued ? null : (
                                <div data-chat-undelivered={m.id} className="flex flex-col items-end gap-1.5">
                                    {/* What is true NOW: an agent running again was not running when it was written — it is not "not running". */}
                                    <span className="text-[12px] text-[var(--danger)]">Not delivered. {m.reason ?? (m.promptId ? 'Kept for you to send again.' : m.resend === 'send' ? `${thread?.name ?? 'the agent'} was not running when you sent it.` : `${thread?.name ?? 'the agent'} is not running.`)}</span>
                                    {m.draftProblem ? <span role="alert" className="text-[12px] text-[var(--danger)]">{m.draftProblem}</span> : null}
                                    <div className="flex items-center gap-1.5">
                                        {onDiscardDraft ? <button type="button" data-action="discard-draft" data-draft={m.id} onClick={() => onDiscardDraft(m.id)} className="rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[12px] text-[var(--fg-2)] hover:bg-[var(--bg-2)]">Discard</button> : null}
                                        {m.reason ? null : m.resend === 'send'
                                            ? <button type="button" data-action="send-draft" data-draft={m.id} onClick={() => onRestartAndSend?.(m.id)} className="rounded-lg border border-[var(--primary-hover)] bg-[var(--primary)] px-2.5 py-1 text-[12px] font-medium text-white hover:bg-[var(--primary-hover)]">Send now</button>
                                            : m.id === restartOn
                                                ? <button type="button" data-action="restart" data-draft={m.id} title={`Restart ${thread?.name ?? 'the agent'}; every message not yet delivered to it is sent, in order, once it is up`} onClick={() => onRestartAndSend?.(m.id)} className="rounded-lg border border-[var(--primary-hover)] bg-[var(--primary)] px-2.5 py-1 text-[12px] font-medium text-white hover:bg-[var(--primary-hover)]">Restart</button>
                                                : null}
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div key={m.id} data-chat-message={m.id} data-who={who} className="flex max-w-[94%] flex-col gap-1">
                            <div className="font-mono text-[11px] text-[var(--fg-3)]"><span className="text-[var(--violet-400)]">{m.from}</span>{stamp ? <> · {stamp}</> : null}</div>
                            {/* An agent's or a peer's reply, RENDERED (the owner): Markdown through Fancy's ContentRenderer, sanitised by default. */}
                            <ChatReply text={m.text} linkFiles={Boolean(onOpenFile)} />
                        </div>
                    );
                })}
                {/* The board's error rule: a broken session ends the transcript with the failure, in red. */}
                {thread?.context?.tone === 'bad' ? (
                    <div data-chat-error="" className="flex items-center gap-2 border-y border-[var(--danger)] py-1.5 font-mono text-[11px] text-[var(--danger)]">
                        <Icon name="circle-alert" size="xs" />
                        <span>{thread.context.text.replace(/^Broken · /, '')}</span>
                    </div>
                ) : null}
            </div>
            </div>

            {/*
             * Directly above the composer, because that is where the person already is. The
             * approval renders wherever the composer is — one actionable rendering, and a
             * marker everywhere else.
             */}
            {approval ? (
                <div className="shrink-0 border-t border-[var(--border-1)]">
                    <ApprovalCard
                        approval={approval}
                        answering={answeringApproval ?? null}
                        refusal={approvalRefusal ?? null}
                        onAnswer={(id, note) => onAnswerApproval?.(id, note)}
                        agentName={thread?.name}
                    />
                </div>
            ) : null}

            <div className="shrink-0 border-t border-[var(--border-1)] p-2">
                {/*
                 * `PromptInput` — *"the chat composer every AI app rebuilds"*: auto-growing,
                 * slash commands, @-mentions, drop-to-attach, keyboard submit, live token
                 * budget. Hand-rolling a textarea here would be rebuilding it badly.
                 *
                 * `⌘↵` sends and a bare Enter is a newline, which is the component's own
                 * behaviour and the design's requirement.
                 *
                 * 5.39.0 (react-fancy#32, asked for by this composer): a quiet footer — the paperclip and the send arrow
                 * as icons, the shortcut in the send button's tooltip instead of an inline hint — and the meter only near
                 * the limit, on the agent's REAL context (`contextUsage`), or not at all when that was never reported.
                 * A paste of PASTE_PILL_CHARS+ characters is a pill where it was pasted, expanded in place when sent; a pasted
                 * image is a pill too, and reaches `onSubmit` as a file — sent as an image block, its marker kept in
                 * the text and the file named after it (`core/composer.ts`).
                 */}
                {/* No agent on screen to message: the reason, and nothing to type into — a message here would go to a
                    project the person is not looking at (the owner, beta.26). */}
                {blocked ? (
                    <div data-chat-blocked="" role="status" className="flex items-center gap-2 rounded-lg border border-[var(--border-1)] px-3 py-2 text-[12px] text-[var(--fg-2)]">
                        <Icon name="circle-alert" size="xs" />
                        <span>{blocked}</span>
                    </div>
                ) : null}
                {/*
                 * One composer per chat (genie#1261): the chat on screen shows its own; the others stay mounted, hidden, so
                 * their drafts — text, paste pills, attachments — are there when their chat comes back. A blocked chat
                 * hides them all and drops none.
                 */}
                <ChatComposers chats={keptChats} active={activeChat}>
                    {(chat) => (
                    <PromptInput
                        {...(contextUsage
                            ? { budgetTokens: contextUsage.size, usedTokens: contextUsage.used, meter: 'near-limit' as const }
                            // The type requires a budget; with the meter hidden it is never drawn, and nothing is made up.
                            : { budgetTokens: 0, meter: 'hidden' as const })}
                        attachButton="icon"
                        sendButton="icon"
                        pasteThreshold={PASTE_PILL_CHARS}
                        pasteImages
                        previewChars={30}
                        commands={toPromptCmds(commands)}
                        placeholder={!thread ? 'Message this agent' : mailOnly ? `send to ${thread.name}'s inbox${elsewhere ? ` — in ${elsewhere}` : ''}` : approval ? `Reply to ${addressee}, or answer with A / D` : `Message ${addressee}`}
                        onSubmit={(text, picked) => { void readAttachments(namePastedImages(text, picked)).then((files) => onSend(text, files, chat)); }}
                    />
                    )}
                </ChatComposers>
            </div>
        </aside>
    );
}

/**
 * The kept composers (genie#1261), one per chat in ONE list keyed by the chat's agent: a chat never changes slot, so a
 * switch only flips `hidden` and moves Genie's handle, and React keeps every instance — the way Genie 1 kept each
 * terminal panel mounted-hidden by its id (v0.7.0-beta.342 `renderer/lib/terminal-grid-layout.ts`).
 *
 * `data-chat-composer` — Genie's own handle on the composer, and only on the one on screen (never on the blocked
 * notice, never on a hidden draft). The smoke and the focus shortcut find the composer by it — with paste pills on,
 * react-fancy's input is a `contenteditable` `role="textbox"`, not a `<textarea>`, so a selector for the library's
 * element broke the day it changed. `data-chat-draft` names whose draft each one holds.
 */
export function ChatComposers({ chats, active, children }: { chats: readonly string[]; active: string | null; children: (chat: string) => ReactNode }) {
    return (
        <>
            {chats.map((chat) => (
                <div key={chat} data-chat-draft={chat} hidden={chat !== active} {...(chat === active ? { 'data-chat-composer': '' } : {})}>
                    {children(chat)}
                </div>
            ))}
        </>
    );
}
