import { ContentRenderer, Icon, PromptInput } from '@particle-academy/react-fancy';
import type { Approval } from '../../core/approval.js';
import { DOCK_WIDTH } from '../../core/dock.js';
import { ApprovalCard } from './ApprovalCard.js';
import type { Fidelity } from '../../core/dashboard-view.js';
import type { ChatChip, ChatContext, ChatMessage } from '../../core/chat-view.js';
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
    messages: readonly (Pick<ChatMessage, 'id' | 'from' | 'text' | 'delivered'> & Partial<Pick<ChatMessage, 'who' | 'at' | 'read'>>)[];
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
    contextTokens: number;
    /**
     * The approval to answer HERE, when this is where the composer is.
     *
     * Passed in rather than read from the thread, because which surface owns an approval is a
     * decision (`approvalPlacement`) and not a property of the conversation.
     */
    approval?: Approval | null | undefined;
    answeringApproval?: string | null | undefined;
    onAnswerApproval?: ((optionId: string) => void) | undefined;
    onSend: (text: string) => void;
    onTogglePin: () => void;
    onClose: () => void;
    /** `Restart <agent> and send` on an undelivered draft (§4.4): restart the agent, then send that text. */
    onRestartAndSend?: ((draftId: string) => void) | undefined;
    /** A thread chip was clicked: switch the conversation to that agent (the route's `chat=`). */
    onPickThread?: ((agentId: string) => void) | undefined;
    /** A turn is running: `[Stop]` sits beside Send (§6.2 stop — everything about the agent kept). */
    running?: boolean | undefined;
    onStop?: (() => void) | undefined;
}

export function ChatFlyout({
    thread, pinned, contextTokens, approval, answeringApproval, onAnswerApproval,
    onSend, onTogglePin, onClose, onPickThread, onRestartAndSend, running = false, onStop,
}: ChatFlyoutProps) {
    /**
     * An OBSERVED agent gets a different SHAPE of chat, not a disabled one.
     *
     * It is a TUI the user opened via Take Over. Genie can put a message in its AgentInbox and
     * cannot see what it says back, so the composer says `send to <name>'s inbox` and the head
     * chip reads `observed · mail only`. **Replies are not shown, because that TUI does not
     * report them** — an empty transcript there would read as an agent ignoring you.
     */
    const mailOnly = thread?.fidelity === 'observed';

    return (
        <aside
            data-chat={pinned ? 'pinned' : 'overlay'}
            style={{ width: DOCK_WIDTH }}
            className={[
                'flex min-h-0 shrink-0 flex-col border-l border-[var(--border-1)] bg-[var(--surface)]',
                // Unpinned: absolutely positioned over the right edge with a shadow. Nothing
                // underneath moves, which is why it needs no reserve.
                pinned ? '' : 'absolute inset-y-0 right-0 z-20 shadow-xl',
            ]
                .filter(Boolean)
                .join(' ')}
        >
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border-1)] px-3">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {thread ? thread.name : 'genie'}
                </span>

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

            <div className="flex min-h-0 flex-1 flex-col justify-end gap-3 overflow-auto px-3 py-3">
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
                                    <span className="text-[12px] text-[var(--danger)]">Not delivered. {thread?.name ?? 'the agent'} is not running.</span>
                                    <button type="button" data-action="restart-and-send" data-draft={m.id} onClick={() => onRestartAndSend?.(m.id)} className="rounded-lg border border-[var(--primary-hover)] bg-[var(--primary)] px-2.5 py-1 text-[12px] font-medium text-white hover:bg-[var(--primary-hover)]">Restart {thread?.name ?? 'the agent'} and send</button>
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
                 */}
                <PromptInput
                    budgetTokens={contextTokens}
                    placeholder={!thread ? 'Message this agent' : mailOnly ? `send to ${thread.name}'s inbox` : approval ? `Reply to ${thread.name}, or answer with A / D` : `Message ${thread.name}`}
                    showHint
                    onSubmit={(text) => onSend(text)}
                />
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
