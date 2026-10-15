import { Icon } from '@particle-academy/react-fancy';
import { useEffect, useRef } from 'react';
import { QuestionForm } from './QuestionForm.js';
import { ageLabel, DAY_MS, deckBand, dismissableOlderThan, isDismissable, signalStrip, sinceYouLooked, type DeckItem, type SignalAction, type SignalState } from '../../core/deck.js';
import { ApprovalCard } from './ApprovalCard.js';

/**
 * THE DECK — "does anything need me?"
 *
 * ## The acceptance test is a sentence, and the layout serves it
 *
 * > **You can clear the entire band without navigating once.**
 *
 * So every item is answered where it is read: inline options as buttons, an agent's questions as their form, right in
 * the row, and a forwarded one shown with the host it belongs to rather than a button that would mark it done while the
 * real question waits forever.
 *
 * ## A question is READ here (the owner, 2026-10-15: "I can't read this")
 *
 * The row says who asked, in which workspace (its NAME, as the rail says it), how long ago, and the question's short
 * header as its title — plain text. The body is the question itself, rendered from its Markdown by QuestionForm, the
 * same form the question window shows: sans, 13px, a reading width, never a monospace dump and never cut off.
 *
 * ## Nothing waits forever
 *
 * Every agent question can be Dismissed without an answer (its agent is told), and the band offers "Dismiss all older
 * than 1 day" when there are such — the Deck had kept eight questions from the day before that nobody would answer.
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
    /** An agent's questions, answered IN PLACE: one array of labels per question, plus one note per question. */
    onAnswerForm?: ((item: DeckItem, selections: string[][], notes: string[]) => void) | undefined;
    /** The last refused form answer: said beside THAT item's Answer button, where the person clicked. */
    formRefusal?: { itemId: string; reason: string } | null | undefined;
    /** The item the reader was SENT to (`genie://deck?item=<id>`, a waiting Dashboard row): marked and scrolled to. */
    focusId?: string | null | undefined;
    /** Dismiss an agent's question without an answer. Absent = not offered. */
    onDismiss?: ((item: DeckItem) => void) | undefined;
    /** "Dismiss all older than 1 day" — the age, in ms, past which the questions go. Absent = not offered. */
    onDismissOlder?: ((olderThanMs: number) => void) | undefined;
    /** The clock the ages are read against; now by default (tests pass a fixed one). */
    now?: number | undefined;
}

export function Deck({ items, signals, answering, onAnswer, onOpenItem, onNavigate, onSignalAction, onAnswerForm, formRefusal = null, focusId = null, onDismiss, onDismissOlder, now = Date.now() }: DeckProps) {
    const band = deckBand(items);
    // SINCE YOU LOOKED (§4.5): finished agents with their handoff notes — read here, newest first; never in the count.
    const looked = sinceYouLooked(items);
    const strip = signalStrip(signals);
    const old = dismissableOlderThan(band, now, DAY_MS);
    const focusRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => { focusRef.current?.scrollIntoView({ block: 'center' }); }, [focusId]);

    return (
        <div data-surface="deck" className="flex h-full min-h-0 flex-col">
            <div data-view-header="" className="flex h-14 shrink-0 items-center gap-4 border-b border-[var(--border-1)] pl-7 pr-5">
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
                {/* The questions nobody is going to answer: put aside in one go, each agent told. Only when there are such. */}
                {onDismissOlder && old.length > 0 ? (
                    <button
                        type="button"
                        data-action="deck-dismiss-older"
                        data-deck-older={old.length}
                        onClick={() => onDismissOlder(DAY_MS)}
                        title="Each agent is told its question was dismissed without an answer"
                        className="ml-auto rounded-md border border-[var(--border-1)] px-2 py-1 text-xs text-[var(--fg-2)] hover:bg-[var(--bg-2)]"
                    >
                        {`Dismiss all older than 1 day (${old.length})`}
                    </button>
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

                <div data-deck-band="needs-you">
                {band.map((item) => {
                    const questions = item.answer.kind === 'form' ? (item.answer.questions ?? null) : null;
                    const dismiss = onDismiss && isDismissable(item) ? () => onDismiss(item) : undefined;
                    return (
                    <div
                        key={item.id}
                        ref={item.id === focusId ? focusRef : undefined}
                        data-deck-item={item.id}
                        {...(item.id === focusId ? { 'data-deck-focus': 'true' } : {})}
                        data-blocking={item.blocking ? 'true' : 'false'}
                        data-priority={item.priority}
                        className={`border-b border-[var(--border-1)] px-7 py-3 ${item.id === focusId ? 'bg-[var(--bg-1)] shadow-[inset_2px_0_0_var(--accent)]' : ''}`}
                    >
                        <div className="flex items-center gap-2 text-[13px]">
                            {/* Blocking is the most important bit on the item, so it is the
                                first thing on the row. An agent has STOPPED. */}
                            {item.blocking ? (
                                <span data-blocking-dot className="size-2 shrink-0 rounded-full bg-[var(--warning)]" />
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

                            {/* An agent's question is titled by its header — short, plain — and set like a title. */}
                            {/* Anything else (a to-do, a message) is its own text: it wraps, read whole — the row is where it is read. */}
                            <span data-deck-title={item.id} className={`min-w-0 flex-1 ${questions ? 'truncate font-semibold text-[var(--fg-1)]' : 'break-words text-[var(--fg-2)]'}`}>{item.title}</span>

                            {/* Where, and how long it has waited: the workspace's NAME (never its id), then the age. */}
                            {item.workspaceName ? (
                                <span data-deck-workspace={item.workspaceId ?? ''} className="shrink-0 text-[12px] text-[var(--fg-3)]">{item.workspaceName}</span>
                            ) : null}
                            {item.source === 'agent-question' && item.at > 0 ? (
                                <time data-deck-age={item.id} dateTime={new Date(item.at).toISOString()} className="shrink-0 text-[12px] text-[var(--fg-4)]">{ageLabel(item.at, now)}</time>
                            ) : null}
                        </div>

                        {/* Answered WHERE IT IS READ. Navigating away is what the acceptance
                            test forbids. */}
                        {/*
                         * A TOOL APPROVAL (an agent-question answered inline) is its card: the command is code, so it is
                         * set as code. A to-do or a message is prose already shown whole in the row — its buttons only,
                         * never its text again in a monospace box.
                         */}
                        {item.answer.kind === 'inline' && item.source === 'agent-question' ? (
                            <ApprovalCard
                                approval={{ question: item.title, options: item.answer.options }}
                                answering={answering}
                                onAnswer={(optionId) => onAnswer(item, optionId)}
                            />
                        ) : null}
                        {item.answer.kind === 'inline' && item.source !== 'agent-question' ? (
                            <InlineOptions options={item.answer.options} answering={answering} onAnswer={(optionId) => onAnswer(item, optionId)} />
                        ) : null}

                        {/*
                         * An agent's questions: the body IS the form — each question rendered from its Markdown, its
                         * options, its note, Answer and Dismiss. Keyed by the revision, so a question its agent updated
                         * starts a clean draft. An item that did not carry its questions has a door to its agent instead.
                         */}
                        {item.answer.kind === 'form' && questions ? (
                            <div className="mt-2 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] px-4 py-3">
                                <QuestionForm
                                    key={`${item.id}:${item.revision ?? 0}`}
                                    item={item}
                                    answering={answering}
                                    refusal={formRefusal?.itemId === item.id ? formRefusal.reason : null}
                                    onSubmit={(selections, notes) => onAnswerForm?.(item, selections, notes)}
                                    onDismiss={dismiss}
                                    showHeaders={questions.length > 1}
                                />
                            </div>
                        ) : null}
                        {item.answer.kind === 'form' && !questions ? (
                            <div className="mt-2 flex items-center gap-2">
                                <button
                                    type="button"
                                    data-deck-expand={item.id}
                                    onClick={() => onOpenItem(item)}
                                    className="flex items-center gap-1.5 rounded-md border border-[var(--border-1)] px-2 py-1 text-xs hover:bg-[var(--bg-2)]"
                                >
                                    <Icon name="list-checks" size="xs" />
                                    {item.answer.fields === 1 ? 'Answer 1 question' : `Answer ${item.answer.fields} questions`}
                                </button>
                                {dismiss ? (
                                    <button type="button" data-action="question-dismiss" data-deck-dismiss={item.id} onClick={dismiss} className="rounded-md border border-[var(--border-1)] px-2 py-1 text-xs text-[var(--fg-2)] hover:bg-[var(--bg-2)]">Dismiss</button>
                                ) : null}
                            </div>
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
                    );
                })}
                </div>

                {looked.length > 0 ? (
                    <div data-deck-band="since-you-looked" className="mt-2">
                        <h2 className="px-7 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Since you looked</h2>
                        {looked.map((item) => (
                            <div key={item.id} data-deck-item={item.id} data-priority={item.priority} className="border-b border-[var(--border-1)] px-7 py-3">
                                <div className="flex items-center gap-2 text-[13px]">
                                    {item.agentName ? (
                                        <button type="button" data-deck-agent={item.agentId} onClick={() => onOpenItem(item)} className="shrink-0 font-medium hover:underline">{item.agentName}</button>
                                    ) : null}
                                    <span className="min-w-0 flex-1 text-[var(--fg-2)]">{item.title}</span>
                                </div>
                                {item.answer.kind === 'inline' ? (
                                    <InlineOptions options={item.answer.options} answering={answering} onAnswer={(optionId) => onAnswer(item, optionId)} />
                                ) : null}
                            </div>
                        ))}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

/** A to-do's, a message's or a finished agent's doors — the buttons alone; the text is the row's. */
function InlineOptions({ options, answering, onAnswer }: { options: readonly { id: string; label: string }[]; answering: string | null; onAnswer: (optionId: string) => void }) {
    return (
        <div className="mt-2 flex flex-wrap gap-2">
            {options.map((option) => (
                <button
                    key={option.id}
                    type="button"
                    data-approval-option={option.id}
                    disabled={answering !== null}
                    onClick={() => onAnswer(option.id)}
                    className="rounded-md border border-[var(--border-2)] px-2.5 py-1 text-xs text-[var(--fg-2)] hover:bg-[var(--bg-2)] disabled:opacity-50"
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}
