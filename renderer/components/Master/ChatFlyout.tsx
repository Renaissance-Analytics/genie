import { Button, Icon, Text, Textarea } from '@particle-academy/react-fancy';
import { useState } from 'react';
import type { AgentSession, Message, PendingApproval } from '../../../main/agentsession/model';
import { chatFlyoutView } from '../../lib/chat-flyout-view';

/**
 * CHAT — §5.4 of the owner's spec board. A flyout, pinnable right.
 *
 * It replaces the Agent view's composer, which makes it the only place a human types to an
 * agent. Two consequences shape the whole component:
 *
 *  - **It must say where the text goes.** For a pty-only agent the button reads *"Send to
 *    terminal"* and the thread carries a note saying replies stay there. Without that, a
 *    one-sided thread reads as an agent ignoring you rather than as a provider that reports
 *    nothing — the `null`-is-not-zero rule applied to a conversation.
 *  - **Approvals are answered HERE, inline.** Not in a modal: an `Edit` approval fires many
 *    times a turn, and a modal per approval makes the modal the new TUI (§6.4).
 *
 * Every wording and state decision is in `lib/chat-flyout-view.ts` with its tests. This file
 * is the render.
 *
 * ## Pinned vs unpinned
 *
 * Pinned it RESERVES a 380px gutter and the header does not move; unpinned it overlays with a
 * shadow and nothing underneath moves. That geometry has shipped wrong three times here, most
 * recently with a reserve that named only the hidden grid row (genie#841), so the width is a
 * constant shared with the stylesheet and the behaviour is asserted in E2E rather than eyeballed.
 */

function HumanLine({ message }: { message: Message }): React.JSX.Element {
    return (
        <div className="chat-msg" data-from="you">
            <Text size="xs" className="chat-who">
                you
            </Text>
            <div className="chat-bubble">
                <Text size="sm">{message.content}</Text>
            </div>
        </div>
    );
}

function AgentLine({ message }: { message: Message }): React.JSX.Element {
    return (
        <div className="chat-msg" data-from="agent">
            <Text size="xs" className="chat-who">
                {/* The AUTHOR when another agent wrote it, which is what makes a relayed
                    message legible as somebody else's. `author` is set by the floor for mail
                    and left unset for the agent's own speech. */}
                <span className="chat-who-name">{message.author ?? 'agent'}</span>
            </Text>
            <Text size="sm" className="chat-agent-text">
                {message.content}
            </Text>
        </div>
    );
}

/** An approval, answered in the thread. A / D are the same keys the Deck queue uses. */
function Approval({
    approval,
    onDecide,
}: {
    approval: PendingApproval;
    onDecide?: (id: string, decision: 'allow-once' | 'allow-always' | 'deny') => void;
}): React.JSX.Element {
    return (
        <div className="chat-approval">
            <div className="chat-approval-head">
                <Icon name="shield-alert" size="xs" />
                <Text size="sm" className="chat-approval-title">
                    {approval.name}
                </Text>
            </div>
            <div className="chat-approval-actions">
                <Button size="sm" onClick={() => onDecide?.(approval.id, 'allow-once')}>
                    Allow <span className="chat-key">A</span>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onDecide?.(approval.id, 'deny')}>
                    Deny <span className="chat-key">D</span>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onDecide?.(approval.id, 'allow-always')}>
                    Allow for this session
                </Button>
            </div>
        </div>
    );
}

export function ChatFlyout({
    session,
    pinned,
    onTogglePin,
    onClose,
    onSend,
    onStop,
    onDecide,
    now = Date.now(),
}: {
    /** The agent this thread is with, or null for the genie thread. */
    session: AgentSession | null;
    pinned: boolean;
    onTogglePin?: () => void;
    onClose?: () => void;
    /**
     * Deliver the draft. Returning `false` means it did NOT land, and the composer puts the
     * text back — the session API distinguishes a delivered send from a parked or
     * sessionless one, and losing what you typed to a silent refusal is the one failure
     * here you cannot undo.
     */
    onSend?: (text: string) => void | boolean | Promise<boolean | void>;
    onStop?: () => void;
    onDecide?: (id: string, decision: 'allow-once' | 'allow-always' | 'deny') => void;
    now?: number;
}): React.JSX.Element {
    const view = chatFlyoutView({ session, now });
    const [draft, setDraft] = useState('');

    const send = async () => {
        const text = draft.trim();
        if (!text || !view.canSend) return;
        // Cleared optimistically so the composer feels immediate, and RESTORED below if the
        // send did not land. Clearing unconditionally — which this did — silently destroyed
        // the message whenever the agent was parked or had no session.
        setDraft('');
        const delivered = await onSend?.(text);
        if (delivered === false) setDraft(text);
    };

    return (
        <div className="chat-dock" data-pinned={pinned ? '' : undefined}>
            <div className="chat-head">
                <Text size="sm" className="chat-head-title">
                    Chat
                </Text>
                {session ? (
                    <span className="chat-target">
                        <Text size="xs">{session.session.name}</Text>
                    </span>
                ) : null}
                <div className="chat-head-spacer" />
                <Button
                    size="sm"
                    variant="ghost"
                    aria-label={pinned ? 'Unpin chat' : 'Pin chat right'}
                    aria-pressed={pinned}
                    onClick={onTogglePin}
                >
                    <Icon name="pin" size="xs" />
                </Button>
                <Button size="sm" variant="ghost" aria-label="Close chat" onClick={onClose}>
                    <Icon name="x" size="xs" />
                </Button>
            </div>

            {view.contextLine ? (
                <div className="chat-context" data-level={view.contextLevel}>
                    <Text size="xs">{view.contextLine}</Text>
                </div>
            ) : null}

            <div className="chat-body">
                {view.isEmpty ? (
                    <div className="chat-empty">
                        <Text size="sm" className="chat-empty-title">
                            No messages yet.
                        </Text>
                        {/* Says what the default recipient CAN do. An empty surface reporting
                            only its emptiness teaches nothing. */}
                        <Text size="sm" className="chat-empty-hint">
                            {view.emptyHint}
                        </Text>
                    </div>
                ) : null}

                {view.oneSidedNote ? (
                    <div className="chat-fact">
                        <Text size="xs">{view.oneSidedNote}</Text>
                    </div>
                ) : null}

                {(session?.transcript ?? []).map((message) =>
                    message.role === 'user' && !message.author ? (
                        <HumanLine key={message.id} message={message} />
                    ) : (
                        <AgentLine key={message.id} message={message} />
                    ),
                )}

                {session?.live ? (
                    <div className="chat-msg" data-from="agent" data-live="">
                        <Text size="sm" className="chat-agent-text">
                            {session.live.content}
                        </Text>
                    </div>
                ) : null}

                {(session?.approvals ?? []).map((approval) => (
                    <Approval key={approval.id} approval={approval} onDecide={onDecide} />
                ))}

                {view.contextLevel === 'attention' ? (
                    // THE TURN VISIBLY PARKS (§6.4). A stopped agent must be obvious in the
                    // thread, not only inferable from the absence of new messages.
                    <div className="chat-parked">
                        <Text size="xs">{view.contextLine}</Text>
                    </div>
                ) : null}
            </div>

            <div className="chat-composer">
                <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.currentTarget.value)}
                    placeholder={view.placeholder}
                    disabled={!view.canSend}
                    rows={2}
                    onKeyDown={(e) => {
                        // ⌘↵ sends, as everywhere else in Genie. A bare Enter inserts a
                        // newline — a message to an agent is often several lines, and sending
                        // on Enter would truncate half of them.
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            send();
                        }
                    }}
                />
                <div className="chat-composer-actions">
                    <Text size="xs" className="chat-composer-hint">
                        @ agent · / command
                    </Text>
                    <div className="chat-head-spacer" />
                    {view.canStop ? (
                        <Button size="sm" variant="ghost" onClick={onStop}>
                            Stop
                        </Button>
                    ) : null}
                    <Button size="sm" disabled={!view.canSend || draft.trim().length === 0} onClick={send}>
                        {view.sendLabel} <span className="chat-key">⌘↵</span>
                    </Button>
                </div>
            </div>
        </div>
    );
}
