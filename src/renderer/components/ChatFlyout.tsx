import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ContentRenderer, Icon, PromptInput } from '@particle-academy/react-fancy';
import type { Approval } from '../../core/approval.js';
import { toPromptCmds, type ProviderCommand } from '../../core/provider-commands.js';
import { DOCK_WIDTH } from '../../core/dock.js';
import { atThreadEnd, clampChatWidth, dragChatWidth, readChatWidth, writeChatWidth } from '../../core/chat-width.js';
import { ApprovalCard } from './ApprovalCard.js';
import type { Fidelity } from '../../core/dashboard-view.js';
import type { ChatChip, ChatContext, ChatMessage } from '../../core/chat-view.js';
import type { Attachment } from '../../core/prompt-content.js';
import type { ChatScope } from '../../core/chat-scope.js';
import { namePastedImages, type ComposerMeter } from '../../core/composer.js';
import { FidelityDot } from './Dashboard.js';

/**
 * THE CHAT FLYOUT — the only place a human types to an agent.
 *
 * It replaces the Agent view's composer. There is exactly one composer in the application, and
 * a parked approval renders wherever it is — see `approvalPlacement`. One actionable rendering,
 * one marker, never two sets of buttons for one decision.
 *
 * ## Pinned and unpinned are different geometries, not a style
 *
 * **Unpinned** overlays the right edge with a shadow and **nothing underneath moves**. `Esc`
 * closes it.
 *
 * **Pinned** reserves a gutter that starts *below* the view header — the header keeps its width
 * and position, and the content reflows into what is left. **`Esc` does not close a pinned
 * dock**, because a pin is a statement that this panel stays.
 *
 * The reserve lives on the content row in `Shell`, as a `margin`, from the same `DOCK_WIDTH`
 * this panel is sized by. See `core/dock.ts` for the three places it must not go, each of
 * which has already cost a release.
 *
 * **Unpinned, the person sets the width** by dragging the left edge, and it is remembered
 * across closing, pinning and restarts (`core/chat-width.ts`). Pinned ignores it: the dock is
 * `DOCK_WIDTH`, because the reserve reads that token and a wider panel would overlap the content.
 *
 * ## Not a `Drawer`
 *
 * Fancy has one, and it is the wrong component: a drawer implies a scrim, and a scrim is
 * precisely the thing a pin removes. A pinned panel that dimmed the work behind it would make
 * the pin pointless.
 */

export interface ChatThread {
    agentId: string;
    name: string;
    fidelity: Fidelity;
    /** `null` when the count could not be read — never `0`, which claims you are up to date. */
    unread: number | null;
    /** The transcript (`core/chat-view.ts`): message events only — no thought ever appears in chat. */
    messages: readonly (Pick<ChatMessage, 'id' | 'from' | 'text' | 'delivered'> & Partial<Pick<ChatMessage, 'who' | 'at' | 'read' | 'attachments' | 'reason'>>)[];
    /** The line under the chips — what the agent is doing, in the board's words; `null` = not read yet. */
    context?: ChatContext | null | undefined;
    /** The agents sharing the subject's workspace, the subject active; absent or empty = no chips row. */
    chips?: readonly ChatChip[] | undefined;
}

const CONTEXT_TONE = { ok: 'text-[var(--success)]', warn: 'text-[var(--warning)]', bad: 'text-[var(--danger)]', muted: 'text-[var(--fg-3)]' } as const;

/** `13:58` from epoch ms, in the local clock — only ever called with a real time. */
/** genie's tab mark: Genie's own gradient, the title bar's mark in small — the OS agent has no state to guess. */
export function GenieMark() {
    return <span data-genie-mark="" className="size-2 shrink-0 rounded-[2px] bg-gradient-to-br from-[var(--brand-grad-from)] via-[var(--brand-grad-via)] to-[var(--brand-grad-to)]" aria-hidden />;
}

function clock(at: number): string {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export interface ChatFlyoutProps {
    thread: ChatThread | null;
    pinned: boolean;
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
    /** The agent's own commands and skills (core/provider-commands.ts), offered in the composer's `/` menu. */
    commands?: readonly ProviderCommand[] | null | undefined;
    answeringApproval?: string | null | undefined;
    onAnswerApproval?: ((optionId: string) => void) | undefined;
    onSend: (text: string, attachments?: readonly Attachment[]) => void;
    /** Absent = no pin control (the doctor window: the chat is the page, not a panel). */
    onTogglePin?: (() => void) | undefined;
    onClose: () => void;
    /** `Restart <agent> and send` on an undelivered draft (§4.4): restart the agent, then send that text. */
    onRestartAndSend?: ((draftId: string) => void) | undefined;
    /** A thread chip was clicked: switch the conversation to that agent (the route's `chat=`). */
    onPickThread?: ((agentId: string) => void) | undefined;
    /** A turn is running: `[Stop]` sits beside Send (§6.2 stop — everything about the agent kept). */
    running?: boolean | undefined;
    onStop?: (() => void) | undefined;
    /** Where the unpinned width is remembered; absent = the window's localStorage (tests pass their own). */
    widthStorage?: Pick<Storage, 'getItem' | 'setItem'> | null | undefined;
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
    thread, pinned, contextUsage = null, approval, commands, answeringApproval, onAnswerApproval,
    onSend, onTogglePin, onClose, onPickThread, onRestartAndSend, running = false, onStop, widthStorage, scope,
}: ChatFlyoutProps) {
    const storage = widthStorage === undefined ? browserStorage() : widthStorage;
    const [overlayWidth, setOverlayWidth] = useState(() => readChatWidth(storage));
    const width = pinned ? DOCK_WIDTH : overlayWidth;

    /**
     * Drag the LEFT edge (the panel is anchored right). Pointer capture keeps the drag alive
     * over whatever is underneath; the width is written once, when the drag ends.
     */
    const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const startX = e.clientX;
        const from = overlayWidth;
        let last = from;
        const onMove = (ev: PointerEvent) => { last = dragChatWidth(from, startX, ev.clientX, window.innerWidth); setOverlayWidth(last); };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            writeChatWidth(storage, last);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };
    /** The same separator from the keyboard: arrows move the edge 16px, and the width is kept. */
    const keyResize = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        const step = e.key === 'ArrowLeft' ? 16 : e.key === 'ArrowRight' ? -16 : 0;
        if (step === 0) return;
        e.preventDefault();
        const next = clampChatWidth(overlayWidth + step, window.innerWidth);
        setOverlayWidth(next);
        writeChatWidth(storage, next);
    };

    /**
     * Follow the end of the thread while the person is AT the end; once they scroll up to read,
     * new messages do not drag them back down. Opening a thread starts at its end.
     */
    const scrollRef = useRef<HTMLDivElement>(null);
    const followRef = useRef(true);
    const messageCount = thread?.messages.length ?? 0;
    useLayoutEffect(() => { followRef.current = true; }, [thread?.agentId]);
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (el && followRef.current) el.scrollTop = el.scrollHeight;
    }, [thread?.agentId, messageCount]);
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

    return (
        <aside
            data-chat={pinned ? 'pinned' : 'overlay'}
            style={{ width }}
            className={[
                'flex min-h-0 shrink-0 flex-col border-l border-[var(--border-1)] bg-[var(--surface)]',
                // Unpinned: absolutely positioned over the right edge with a shadow. Nothing
                // underneath moves, which is why it needs no reserve.
                pinned ? '' : 'absolute inset-y-0 right-0 z-20 shadow-xl',
            ]
                .filter(Boolean)
                .join(' ')}
        >
            {/* The left edge, unpinned only: a pinned dock is the designed width, so it has nothing to drag. */}
            {pinned ? null : (
                <div
                    data-chat-resize=""
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize chat"
                    aria-valuenow={overlayWidth}
                    tabIndex={0}
                    onPointerDown={startResize}
                    onKeyDown={keyResize}
                    className="absolute inset-y-0 left-0 z-30 w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-[var(--accent)]/40 focus-visible:bg-[var(--accent)]/40 focus-visible:outline-none"
                />
            )}
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

                {onTogglePin ? (
                <button
                    type="button"
                    data-chat-pin={pinned ? 'on' : 'off'}
                    aria-label={pinned ? 'Unpin chat' : 'Pin chat'}
                    aria-pressed={pinned}
                    onClick={onTogglePin}
                    className={`flex size-5 items-center justify-center rounded ${pinned ? 'text-[var(--violet-400)]' : 'text-[var(--fg-4)]'} hover:bg-[var(--bg-2)]`}
                >
                    <Icon name="pin" size="xs" />
                </button>
                ) : null}

                {/* No close button on a pinned dock: a pin says this panel stays, and `Esc`
                    does not close it either. Unpin first — which is one click and reversible. */}
                {pinned ? null : (
                    <button
                        type="button"
                        aria-label="Close chat"
                        onClick={onClose}
                        className="flex size-5 items-center justify-center rounded text-[var(--fg-4)] hover:bg-[var(--bg-2)]"
                    >
                        <Icon name="x" size="xs" />
                    </button>
                )}
            </div>

            {/* THREAD TABS (the board): your conversations, whoever waits on you, genie last; a click switches the thread. */}
            {thread?.chips && thread.chips.length > 0 ? (
                <div data-chat-threads="" className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-[var(--border-1)] px-3 py-2">
                    {thread.chips.map((c) => (
                        <button
                            key={c.agentId}
                            type="button"
                            data-chat-thread-chip={c.agentId}
                            {...(c.active ? { 'data-active': 'true' } : {})}
                            onClick={() => onPickThread?.(c.agentId)}
                            className={`flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-[12px] ${c.active ? 'bg-[var(--bg-3)] text-[var(--fg-1)]' : 'text-[var(--fg-2)] hover:bg-[var(--bg-2)]'}`}
                        >
                            {c.state === null ? <GenieMark /> : <FidelityDot fidelity={c.fidelity} state={c.state} />}
                            <span>{c.name}</span>
                            {c.unread !== null && c.unread > 0 ? <span className="rounded-full bg-[var(--violet-400)] px-1.5 font-mono text-[10px] text-white">{c.unread}</span> : null}
                        </button>
                    ))}
                </div>
            ) : null}
            {/* THE CONTEXT LINE: what the agent is doing, in the board's words. Absent until read — never "Idle" as a guess. */}
            {thread?.context ? (
                <div data-chat-context={thread.context.tone} className={`shrink-0 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-4 py-1.5 text-[12px] ${CONTEXT_TONE[thread.context.tone]}`}>{thread.context.text}</div>
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
                onScroll={(e) => { const el = e.currentTarget; followRef.current = atThreadEnd(el.scrollTop, el.scrollHeight, el.clientHeight); }}
                className="min-h-0 flex-1 overflow-y-auto"
            >
            <div data-chat-log="" className="flex min-h-full flex-col justify-end gap-3 px-3 py-3">
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
                {thread?.messages.map((m) => {
                    const who = m.who ?? (m.from === 'you' ? 'you' : 'agent');
                    const stamp = m.at !== null && m.at !== undefined ? <span data-chat-time={m.at} className="font-mono">{clock(m.at)}</span> : null;
                    // The agent's mail with another agent (the board): one mono line, the arrows icon — no bubble, no speaker.
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
                            <div className={`rounded-[10px] border px-2.5 py-2 text-[13px] leading-normal ${m.delivered ? 'border-[var(--border-1)] bg-[var(--bg-2)]' : 'border-dashed border-[var(--danger)] bg-[var(--bg-2)]'}`}>{m.text}</div>
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
                            {mailOnly && m.read !== undefined ? (
                                <span data-chat-read={m.id} className="font-mono text-[11px] text-[var(--fg-4)]">{m.read === null ? 'not read yet' : `read ${clock(m.read)}`}</span>
                            ) : null}
                            {m.delivered ? null : (
                                <div data-chat-undelivered={m.id} className="flex flex-col items-end gap-1.5">
                                    <span className="text-[12px] text-[var(--danger)]">Not delivered. {m.reason ?? `${thread?.name ?? 'the agent'} is not running.`}</span>
                                    {m.reason ? null : <button type="button" data-action="restart-and-send" data-draft={m.id} onClick={() => onRestartAndSend?.(m.id)} className="rounded-lg border border-[var(--primary-hover)] bg-[var(--primary)] px-2.5 py-1 text-[12px] font-medium text-white hover:bg-[var(--primary-hover)]">Restart {thread?.name ?? 'the agent'} and send</button>}
                                </div>
                            )}
                        </div>
                    ) : (
                        <div key={m.id} data-chat-message={m.id} data-who={who} className="flex max-w-[94%] flex-col gap-1">
                            <div className="font-mono text-[11px] text-[var(--fg-3)]"><span className="text-[var(--violet-400)]">{m.from}</span>{stamp ? <> · {stamp}</> : null}</div>
                            {/* An agent's or a peer's reply, RENDERED (the owner): Markdown through Fancy's ContentRenderer, sanitised by default. */}
                            <ContentRenderer value={m.text} format="markdown" lineSpacing={1.5} className="text-[13px] text-[var(--fg-2)]" />
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
                        onAnswer={(id) => onAnswerApproval?.(id)}
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
                 * A long paste (500+ characters) is a pill where it was pasted, expanded in place when sent; a pasted
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
                ) : (
                <PromptInput
                    {...(contextUsage
                        ? { budgetTokens: contextUsage.size, usedTokens: contextUsage.used, meter: 'near-limit' as const }
                        // The type requires a budget; with the meter hidden it is never drawn, and nothing is made up.
                        : { budgetTokens: 0, meter: 'hidden' as const })}
                    attachButton="icon"
                    sendButton="icon"
                    pasteThreshold={500}
                    pasteImages
                    previewChars={30}
                    commands={toPromptCmds(commands)}
                    placeholder={!thread ? 'Message this agent' : mailOnly ? `send to ${thread.name}'s inbox${elsewhere ? ` — in ${elsewhere}` : ''}` : approval ? `Reply to ${addressee}, or answer with A / D` : `Message ${addressee}`}
                    onSubmit={(text, picked) => { void readAttachments(namePastedImages(text, picked)).then((files) => onSend(text, files)); }}
                />
                )}
                {/* `[Stop]` beside Send while a turn runs (the board): stop means stop (§6.2) — everything about the agent kept. */}
                {running ? (
                    <div className="mt-1.5 flex justify-end">
                        <button type="button" data-action="chat-stop" onClick={() => onStop?.()} className="flex items-center gap-1.5 rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[12px] text-[var(--fg-1)] hover:bg-[var(--bg-2)]">
                            <span className="size-2 rounded-[2px] bg-[var(--fg-2)]" />
                            Stop
                        </button>
                    </div>
                ) : null}
            </div>
        </aside>
    );
}
