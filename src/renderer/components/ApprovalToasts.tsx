import { Button, Icon, Toast } from '@particle-academy/react-fancy';
import { useEffect, useReducer } from 'react';
import type { OptionTone } from '../../core/approval.js';
import type { DeckItem } from '../../core/deck.js';
import { EMPTY_TOASTS, TOAST_DEPTH, toastReducer, toastView, type ToastStackView } from '../../core/approval-toasts.js';

/**
 * THE APPROVAL TOASTS — an agent's gated Genie workflow (a site, a database, a background process, a terminal) answered
 * from whatever screen is open, without going to the Deck. The rules are `core/approval-toasts.ts`; this draws them.
 *
 * ## One request, one answer path
 *
 * A toast is the Deck's own item, and Allow / Deny call the Deck's own `onAnswer` (Shell's `onAnswerDeckItem` →
 * `deckAnswerRoute` → `deck.answer` → `ApprovalQueue.resolve`). Answered in either place, the request leaves the
 * snapshot, and so leaves both.
 *
 * ## The stack (the owner: "stack behind each other with slight top offset … hovering over the stack the user can
 * scroll the mouse to review each request")
 *
 * Fancy's `Toast.Stack` (react-fancy 5.41, built at Genie's request — react-fancy#33): the front request is a whole card
 * with live buttons; two more peek out ABOVE it, each a few pixels higher and slightly smaller; beyond that a "+N". The
 * wheel over it, or the arrow keys with focus in it, bring the next request to the FRONT, round the ring. It is a VIEW of
 * Genie's list: nothing in it can drop a request, and Genie owns which one is in front (`frontIndex`), so while the
 * pointer or focus is on it a new request joins behind — never in front of the one being read. The card under the
 * pointer is the whole request; "2 of 5" says where in the ring you are.
 */

/** Pixels each card behind sits above the one in front of it. */
const OFFSET = 8;
/** How much smaller each card behind is. */
const SCALE_STEP = 0.04;

/** The colours come from the option's tone, never from its words — ApprovalCard's rule. */
const TONE: Record<OptionTone, string> = {
    ok: 'border-[var(--success)]/40 text-[var(--success)] hover:bg-[var(--success)]/10',
    bad: 'border-[var(--danger)]/40 text-[var(--danger)] hover:bg-[var(--danger)]/10',
    neutral: 'border-[var(--border-2)] text-[var(--fg-2)] hover:bg-[var(--bg-2)]',
};

export interface ApprovalToastStackProps {
    view: ToastStackView;
    /** Allow / Deny — the Deck's own answer. */
    onAnswer: (item: DeckItem, optionId: string) => void;
    /** Later: off the toasts, kept in the Deck. */
    onLater: (item: DeckItem) => void;
    /** Fancy turned the stack (wheel or arrow): the new front's index in the ring. */
    onFront: (index: number) => void;
    /** The pointer or focus arrived at (true) or left (false) the stack. */
    onEngage: (on: boolean) => void;
    /** Open the Deck at this request. */
    onOpenDeck?: ((item: DeckItem) => void) | undefined;
    /** Distance from the right edge of the content row (clear of the chat strip, a docked panel or an open flyout). */
    right?: number | undefined;
}

function workspaceOf(item: DeckItem): string {
    return item.workspaceName?.trim() || 'a workspace not known here';
}

/** The front request: who, where, what, and its answers. */
function FrontCard({ item, view, onAnswer, onLater, onOpenDeck }: { item: DeckItem; view: ToastStackView } & Pick<ApprovalToastStackProps, 'onAnswer' | 'onLater' | 'onOpenDeck'>) {
    const busy = view.answering.includes(item.id);
    const options = item.answer.kind === 'inline' ? item.answer.options : [];
    return (
        <div data-approval-toast={item.id} className="text-[13px]">
            <div className="mb-1.5 flex items-center gap-2 text-[11px] text-[var(--fg-3)]">
                <Icon name="circle-help" size="xs" className="shrink-0 text-[var(--warning)]" />
                <span data-approval-toast-agent="" className="font-semibold text-[var(--fg-1)]">{item.agentName ?? 'An agent'}</span>
                <span aria-hidden="true">·</span>
                <span data-approval-toast-workspace="" className="min-w-0 flex-1 truncate">{workspaceOf(item)}</span>
                {view.total > 1 ? <span data-approval-toast-position="" className="shrink-0 font-mono">{`${view.position} of ${view.total}`}</span> : null}
            </div>
            <p data-approval-toast-title="" className="mb-2.5 break-words leading-[18px] text-[var(--fg-1)]">{item.title}</p>
            <div className="flex items-center gap-2">
                {options.map((option) => (
                    <Button
                        key={option.id}
                        type="button"
                        size="sm"
                        data-toast-option={option.id}
                        data-tone={option.tone}
                        disabled={busy}
                        onClick={() => onAnswer(item, option.id)}
                        className={`border ${TONE[option.tone]}`}
                    >
                        {option.label}
                    </Button>
                ))}
                <span className="flex-1" />
                {onOpenDeck ? (
                    <Button type="button" size="sm" variant="ghost" data-toast-deck="" onClick={() => onOpenDeck(item)} title="Open this request in the Deck">
                        Deck
                    </Button>
                ) : null}
                <Button type="button" size="sm" variant="ghost" data-toast-later="" disabled={busy} onClick={() => onLater(item)} title="Put it off: it stays in the Deck">
                    Later
                </Button>
            </div>
        </div>
    );
}

/** The stack itself: a pure function of its view — no state, so a test can read it and press its buttons. */
export function ApprovalToastStack({ view, onAnswer, onLater, onFront, onEngage, onOpenDeck, right = 16 }: ApprovalToastStackProps) {
    if (view.total === 0) return null;
    const front = view.ring[view.front]!;
    return (
        <div
            data-approval-toasts=""
            data-front={front.id}
            data-position={view.position}
            data-total={view.total}
            onMouseEnter={() => onEngage(true)}
            onMouseLeave={() => onEngage(false)}
            onFocus={() => onEngage(true)}
            onBlur={(e) => {
                const to = e.relatedTarget as Node | null;
                if (!to || !e.currentTarget.contains(to)) onEngage(false);
            }}
            className="absolute bottom-4 z-30 w-[360px] overscroll-contain"
            style={{ right }}
        >
            <Toast.Stack
                items={view.ring}
                getKey={(item) => item.id}
                frontIndex={view.front}
                onFrontIndexChange={onFront}
                depth={TOAST_DEPTH - 1}
                offset={OFFSET}
                scaleStep={SCALE_STEP}
                position="inline"
                label={`Approval requests: ${view.total} waiting. Arrow keys or the mouse wheel move through them.`}
                className="w-full"
                cardClassName="border-[var(--warning)]/40 bg-[var(--bg-1)]"
                renderItem={(item, { isFront }) =>
                    isFront ? (
                        <FrontCard item={item} view={view} onAnswer={onAnswer} onLater={onLater} onOpenDeck={onOpenDeck} />
                    ) : (
                        // The ones behind are inert (Fancy's): only the front one is answered.
                        <span data-approval-toast-behind={item.id} className="text-[12px] text-[var(--fg-3)]">{item.title}</span>
                    )
                }
            />
        </div>
    );
}

export interface ApprovalToastsProps {
    /** The Deck's items — the same list the Deck shows. */
    items: readonly DeckItem[];
    /** Do Not Disturb (Settings → General): nothing pops; arrivals wait in the Deck. */
    dnd: boolean;
    /** Drawn nowhere (the Deck itself is on screen: it shows these with the same buttons). The rules keep running. */
    hidden?: boolean | undefined;
    onAnswer: (item: DeckItem, optionId: string) => void;
    onOpenDeck?: ((item: DeckItem) => void) | undefined;
    right?: number | undefined;
}

/** The stack with its rules: what arrived, what was put off, which one is in front. */
export function ApprovalToasts({ items, dnd, hidden = false, onAnswer, onOpenDeck, right }: ApprovalToastsProps) {
    // The first render already knows what is parked (and what arrived under DND), so nothing flashes on boot.
    const [state, dispatch] = useReducer(toastReducer, null, () => toastReducer(EMPTY_TOASTS, { kind: 'items', items, dnd }));
    useEffect(() => { dispatch({ kind: 'items', items, dnd }); }, [items, dnd]);
    if (hidden) return null;
    return (
        <ApprovalToastStack
            view={toastView(state, items)}
            onAnswer={(item, optionId) => {
                dispatch({ kind: 'answering', id: item.id });
                onAnswer(item, optionId);
            }}
            onLater={(item) => dispatch({ kind: 'later', id: item.id })}
            onFront={(index) => dispatch({ kind: 'front', index })}
            onEngage={(on) => dispatch({ kind: 'engage', on })}
            onOpenDeck={onOpenDeck}
            right={right}
        />
    );
}
