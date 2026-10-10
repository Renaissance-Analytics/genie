import { Icon, PromptInput } from '@particle-academy/react-fancy';
import type { Approval } from '../../core/approval.js';
import { DOCK_WIDTH } from '../../core/dock.js';
import { ApprovalCard } from './ApprovalCard.js';
import type { Fidelity } from '../../core/dashboard-view.js';

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
    messages: readonly { id: string; from: string; text: string; delivered: boolean }[];
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
}

export function ChatFlyout({
    thread, pinned, contextTokens, approval, answeringApproval, onAnswerApproval,
    onSend, onTogglePin, onClose,
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
                    <span data-chat-unread={thread.unread} className="rounded-sm bg-amber-500/15 px-1.5 font-mono text-[11px] text-amber-500">
                        {thread.unread}
                    </span>
                ) : null}

                <button
                    type="button"
                    data-chat-pin={pinned ? 'on' : 'off'}
                    aria-label={pinned ? 'Unpin chat' : 'Pin chat'}
                    aria-pressed={pinned}
                    onClick={onTogglePin}
                    className={`flex size-5 items-center justify-center rounded ${pinned ? 'text-violet-400' : 'text-[var(--fg-4)]'} hover:bg-[var(--bg-2)]`}
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

            <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
                {/*
                 * An empty thread says NOTHING. No fake greeting, no system line, no "how can I
                 * help" — every one of those is a message the agent did not send, attributed to
                 * it, in the one place a person reads what it said.
                 */}
                {thread?.messages.map((m) => (
                    <div key={m.id} data-chat-message={m.id} className="mb-2 text-[13px]">
                        <span className="mr-2 font-medium text-violet-400">{m.from}</span>
                        <span className="text-[var(--fg-2)]">{m.text}</span>
                        {/*
                         * An undelivered message is KEPT and MARKED, with the route to send it:
                         * the agent is not running. Dropping it loses what someone wrote, and
                         * showing it as sent is worse — they would wait for an answer that
                         * cannot come.
                         */}
                        {m.delivered ? null : (
                            <span data-chat-undelivered={m.id} className="ml-2 font-mono text-[11px] text-amber-500">
                                not delivered · the agent is not running
                            </span>
                        )}
                    </div>
                ))}
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
                    placeholder={mailOnly && thread ? `send to ${thread.name}'s inbox` : 'Message this agent'}
                    showHint
                    onSubmit={(text) => onSend(text)}
                />
            </div>
        </aside>
    );
}
