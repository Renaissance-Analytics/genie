import { Badge, Button, Card, Icon } from '@particle-academy/react-fancy';
import { useEffect, useReducer, type CSSProperties } from 'react';
import type { OptionTone } from '../../core/approval.js';
import type { DeckItem } from '../../core/deck.js';
import { EMPTY_TOASTS, keyStep, toastReducer, toastView, type ToastStackView } from '../../core/approval-toasts.js';

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
 * The front request is a full card; up to two more peek out ABOVE it, each a few pixels higher and slightly smaller;
 * beyond that a "+N". Over the stack, the mouse wheel brings the next request to the FRONT (rather than fanning the
 * stack open): the card under the pointer is always the whole request with live buttons, the stack keeps its size so
 * nothing under it is covered by surprise, and "2 of 5" says where in the ring you are. Focused (Tab), the arrow keys do
 * the same. While the pointer or focus is on it, a new request joins behind — never in front of the one being read.
 *
 * ## Fancy
 *
 * Built from Fancy's Card, Button, Badge and Icon. Fancy's own `Toast` (react-fancy 5.37.0) cannot carry this: it is
 * imperative (`useToast().toast()` mints its own id, so the list cannot be the Deck's), offers ONE action, lays toasts
 * out as a gapped column with no stacked mode, and `maxToasts` drops the oldest — a pending approval would vanish.
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
    /** Turn the stack by a number of requests (an arrow key: ±1). */
    onCycle: (by: number) => void;
    /** Raw wheel distance over the stack; the rules turn it into steps. */
    onWheel: (deltaY: number) => void;
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

/** The stack itself: a pure function of its view — no state, so a test can read it and press its buttons. */
export function ApprovalToastStack({ view, onAnswer, onLater, onCycle, onWheel, onEngage, onOpenDeck, right = 16 }: ApprovalToastStackProps) {
    if (view.cards.length === 0) return null;
    const front = view.cards[0]!;
    const busy = view.answering.includes(front.id);
    const options = front.answer.kind === 'inline' ? front.answer.options : [];
    const depth = view.cards.length - 1;
    const style: CSSProperties = { right, paddingTop: depth * OFFSET };
    return (
        <div
            data-approval-toasts=""
            data-front={front.id}
            data-position={view.position}
            data-total={view.total}
            role="region"
            aria-label={`Approval requests: ${view.total} waiting. Arrow keys or the mouse wheel move through them.`}
            aria-roledescription="stack"
            tabIndex={0}
            onWheel={(e) => onWheel(e.deltaY)}
            onKeyDown={(e) => {
                const by = keyStep(e.key);
                if (by === 0) return;
                e.preventDefault();
                onCycle(by);
            }}
            onMouseEnter={() => onEngage(true)}
            onMouseLeave={() => onEngage(false)}
            onFocus={() => onEngage(true)}
            onBlur={(e) => {
                const to = e.relatedTarget as Node | null;
                if (!to || !e.currentTarget.contains(to)) onEngage(false);
            }}
            className="absolute bottom-4 z-30 w-[360px] overscroll-contain rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            style={style}
        >
            <div className="relative">
                {/* The ones behind, back to front: higher and smaller, inert — only the front one is answered. */}
                {view.cards
                    .slice(1)
                    .map((item, i) => ({ item, d: i + 1 }))
                    .reverse()
                    .map(({ item, d }) => (
                        <Card
                            key={item.id}
                            data-approval-toast-behind={item.id}
                            aria-hidden="true"
                            variant="elevated"
                            size="sm"
                            className="pointer-events-none absolute inset-0 overflow-hidden border-[var(--border-1)] bg-[var(--bg-1)]"
                            style={{ transform: `translateY(-${d * OFFSET}px) scale(${1 - d * SCALE_STEP})`, transformOrigin: 'top center', zIndex: 10 - d, opacity: 1 - d * 0.2 }}
                        >
                            <span className="text-[12px] text-[var(--fg-3)]">{item.title}</span>
                        </Card>
                    ))}
                <Card
                    key={front.id}
                    data-approval-toast={front.id}
                    variant="elevated"
                    size="sm"
                    className="relative z-20 border-[var(--warning)]/40 bg-[var(--bg-1)] text-[13px]"
                >
                    <div className="mb-1.5 flex items-center gap-2 text-[11px] text-[var(--fg-3)]">
                        <Icon name="circle-help" size="xs" className="shrink-0 text-[var(--warning)]" />
                        <span data-approval-toast-agent="" className="font-semibold text-[var(--fg-1)]">{front.agentName ?? 'An agent'}</span>
                        <span aria-hidden="true">·</span>
                        <span data-approval-toast-workspace="" className="min-w-0 flex-1 truncate">{workspaceOf(front)}</span>
                        {view.total > 1 ? <span data-approval-toast-position="" className="shrink-0 font-mono">{`${view.position} of ${view.total}`}</span> : null}
                        {view.more > 0 ? <Badge data-approval-toast-more="" variant="soft" size="sm">{`+${view.more}`}</Badge> : null}
                    </div>
                    <p data-approval-toast-title="" className="mb-2.5 break-words leading-[18px] text-[var(--fg-1)]">{front.title}</p>
                    <div className="flex items-center gap-2">
                        {options.map((option) => (
                            <Button
                                key={option.id}
                                type="button"
                                size="sm"
                                data-toast-option={option.id}
                                data-tone={option.tone}
                                disabled={busy}
                                onClick={() => onAnswer(front, option.id)}
                                className={`border ${TONE[option.tone]}`}
                            >
                                {option.label}
                            </Button>
                        ))}
                        <span className="flex-1" />
                        {onOpenDeck ? (
                            <Button type="button" size="sm" variant="ghost" data-toast-deck="" onClick={() => onOpenDeck(front)} title="Open this request in the Deck">
                                Deck
                            </Button>
                        ) : null}
                        <Button type="button" size="sm" variant="ghost" data-toast-later="" disabled={busy} onClick={() => onLater(front)} title="Put it off: it stays in the Deck">
                            Later
                        </Button>
                    </div>
                </Card>
            </div>
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
            onCycle={(by) => dispatch({ kind: 'cycle', by })}
            onWheel={(deltaY) => dispatch({ kind: 'wheel', deltaY })}
            onEngage={(on) => dispatch({ kind: 'engage', on })}
            onOpenDeck={onOpenDeck}
            right={right}
        />
    );
}
