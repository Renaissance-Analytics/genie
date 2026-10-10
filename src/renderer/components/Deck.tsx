import { Icon } from '@particle-academy/react-fancy';
import { deckBand, signalStrip, type DeckItem, type SignalAction, type SignalState } from '../../core/deck.js';
import { ApprovalCard } from './ApprovalCard.js';

/**
 * THE DECK — "does anything need me?"
 *
 * ## The acceptance test is a sentence, and the layout serves it
 *
 * > **You can clear the entire band without navigating once.**
 *
 * So every item is answered where it is read: inline options as buttons, a multi-part question
 * expanding **in place**, and a forwarded one shown with the host it belongs to rather than a
 * button that would mark it done while the real question waits forever.
 *
 * ## The only place badges exist
 *
 * Stated in `core/deck.ts` and repeated here because it is a rule about the whole application:
 * if a badge appears anywhere else, the design has failed.
 *
 * ## No Agents band
 *
 * The Dashboard absorbed it. Two boards claiming the same subject was the original design
 * error, and this one's subject is *decisions*.
 */

export interface DeckProps {
    items: readonly DeckItem[];
    signals: SignalState;
    /** `null` unless an answer is in flight. */
    answering: string | null;
    onAnswer: (item: DeckItem, optionId: string) => void;
    onOpenItem: (item: DeckItem) => void;
    onNavigate: (route: string) => void;
    /** The update signal's door is an action (§7): download, then install. */
    onSignalAction?: ((action: SignalAction) => void) | undefined;
}

export function Deck({ items, signals, answering, onAnswer, onOpenItem, onNavigate, onSignalAction }: DeckProps) {
    const band = deckBand(items);
    const strip = signalStrip(signals);

    return (
        <div data-surface="deck" className="flex h-full min-h-0 flex-col">
            <div className="flex h-14 shrink-0 items-center gap-4 border-b border-[var(--border-1)] pl-7 pr-5">
                <h1 className="text-lg font-semibold tracking-tight">Deck</h1>
                {/*
                 * The count, and only when there is one. The Deck being empty is said by the
                 * band below, in words — not by a zero in the header.
                 */}
                {band.length > 0 ? (
                    <span data-deck-count={band.length} className="font-mono text-xs text-[var(--fg-3)]">
                        {band.length} waiting on you
                    </span>
                ) : null}
            </div>

            {/*
             * The signal strip — silent unless something is true, and every signal a door.
             * Rendered above the band because it is context for it, and absent entirely when
             * there is nothing to say.
             */}
            {strip.length > 0 ? (
                <div data-signal-strip className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-1)] px-7 py-2">
                    {strip.map((signal) => (
                        <button
                            key={signal.kind}
                            type="button"
                            data-signal={signal.kind}
                            data-nav={signal.route}
                            data-action={signal.action}
                            onClick={() => (signal.action ? onSignalAction?.(signal.action) : onNavigate(signal.route))}
                            className="rounded-md border border-[var(--border-1)] px-2 py-1 text-xs text-[var(--fg-2)] hover:bg-[var(--bg-2)]"
                        >
                            {signal.label}
                        </button>
                    ))}
                </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-auto">
                {/*
                 * Empty, and it SAYS so.
                 *
                 * "Nothing needs you" is a real statement this surface is entitled to make —
                 * unlike the Dashboard's first run, where "no workspaces" before the bridge
                 * answers would be a claim about a machine nobody had looked at. Here the band
                 * is the whole subject, and an empty band is the answer to the question the
                 * surface asks.
                 */}
                {band.length === 0 ? (
                    <div data-deck="empty" className="flex h-full items-center justify-center text-[13px] text-[var(--fg-3)]">
                        Nothing needs you.
                    </div>
                ) : null}

                {band.map((item) => (
                    <div
                        key={item.id}
                        data-deck-item={item.id}
                        data-blocking={item.blocking ? 'true' : 'false'}
                        data-priority={item.priority}
                        className="border-b border-[var(--border-1)] px-7 py-3"
                    >
                        <div className="flex items-center gap-2 text-[13px]">
                            {/* Blocking is the most important bit on the item, so it is the
                                first thing on the row. An agent has STOPPED. */}
                            {item.blocking ? (
                                <span data-blocking-dot className="size-2 shrink-0 rounded-full bg-amber-500" />
                            ) : null}

                            {item.agentName ? (
                                <button
                                    type="button"
                                    data-deck-agent={item.agentId}
                                    onClick={() => onOpenItem(item)}
                                    className="shrink-0 font-medium hover:underline"
                                >
                                    {item.agentName}
                                </button>
                            ) : null}

                            <span className="min-w-0 flex-1 truncate text-[var(--fg-2)]">{item.title}</span>
                        </div>

                        {/* Answered WHERE IT IS READ. Navigating away is what the acceptance
                            test forbids. */}
                        {item.answer.kind === 'inline' ? (
                            <ApprovalCard
                                approval={{ question: item.title, options: item.answer.options }}
                                answering={answering}
                                onAnswer={(optionId) => onAnswer(item, optionId)}
                            />
                        ) : null}

                        {/* Expands IN PLACE — not a modal, not a navigation. */}
                        {item.answer.kind === 'form' ? (
                            <button
                                type="button"
                                data-deck-expand={item.id}
                                onClick={() => onOpenItem(item)}
                                className="mt-2 flex items-center gap-1.5 rounded-md border border-[var(--border-1)] px-2 py-1 text-xs hover:bg-[var(--bg-2)]"
                            >
                                <Icon name="list-checks" size="xs" />
                                Answer {item.answer.fields} questions
                            </button>
                        ) : null}

                        {/*
                         * Forwarded: shown, and NOT answerable here. Answering the local copy
                         * would mark it done while the real question waits forever — an agent
                         * blocked on a decision somebody believes they already made.
                         */}
                        {item.answer.kind === 'elsewhere' ? (
                            <p data-deck-elsewhere={item.answer.host} className="mt-2 text-xs text-[var(--fg-3)]">
                                Raised on <span className="font-mono text-[var(--fg-2)]">{item.answer.host}</span>, and
                                it has to be answered there.
                            </p>
                        ) : null}
                    </div>
                ))}
            </div>
        </div>
    );
}
