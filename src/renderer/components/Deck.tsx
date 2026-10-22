import { Badge, Icon } from '@particle-academy/react-fancy';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { QuestionForm } from './QuestionForm.js';
import { answeringFor, type ApprovalAnswering } from '../../core/approval-answering.js';
import {
    ageLabel,
    DAY_MS,
    deckBand,
    deckPreview,
    deckSections,
    dismissableOlderThan,
    dismissableStale,
    isDismissable,
    needsYouCount,
    signalStrip,
    sinceYouLooked,
    staleLabel,
    type DeckItem,
    type DeckSection,
    type SignalAction,
    type SignalState,
} from '../../core/deck.js';
import { ApprovalCard } from './ApprovalCard.js';

/**
 * THE DECK — "does anything need me?"
 *
 * ## Grouped by workspace (the owner, 2026-10-15)
 *
 * Sections per workspace — its NAME, as the rail says it, in the Dashboard's group header — then rows. Genie's own items
 * (a main-process error, trusting the certificate) are Genie's section. The band's ranking decides both orders
 * (`core/deck.ts deckSections`): the section holding the most-worth-doing item comes first, and inside it the rows are in
 * rank order. A row is each thing that needs the person — an agent's question, an approval, Genie's own item — with the
 * agent, the question or request, how long it has waited, and its answer IN PLACE, Open (its agent) and Dismiss.
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
 * The row's title is the question's short header — plain text. The body is the question itself, rendered from its
 * Markdown by QuestionForm, the same form the question window shows: sans, 13px, a reading width, never a monospace
 * dump and never cut off. Every question has a note of its own, which travels with the answer AND with a Dismiss (the
 * owner: "I NEED THE ABILITY TO ADD NOTES TO ANY AND ALL QUESTIONS").
 *
 * ## Stale: kept, and said (the owner, 2026-10-15: "Keep, but mark stale")
 *
 * A question whose agent no longer waits — the agent is gone, its session ended, or an earlier run asked it — stays,
 * greyed, after the live rows of its section, labelled with why, with a one-click Dismiss; its form opens in place with
 * "Answer anyway". The header offers "Dismiss all stale" with how many. A stale question is not counted as waiting on
 * you: its agent is not waiting.
 *
 * ## Nothing waits forever
 *
 * Every agent question can be Dismissed without an answer (its agent is told), and the header offers "Dismiss all older
 * than 1 day" when there are such.
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
    /** The answer in flight, if any — which agent's (core/approval-answering.ts): only THAT agent's row refuses a second press. */
    answering: ApprovalAnswering | null;
    /** `note`: the person's words with an approval's answer (beta.33 item 16); absent = none. */
    onAnswer: (item: DeckItem, optionId: string, note?: string) => void;
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
    /** Dismiss an agent's question without an answer, with the notes written in its form (none from a one-click Dismiss). Absent = not offered. */
    onDismiss?: ((item: DeckItem, notes: string[]) => void) | undefined;
    /** "Dismiss all older than 1 day" — the age, in ms, past which the questions go. Absent = not offered. */
    onDismissOlder?: ((olderThanMs: number) => void) | undefined;
    /** "Dismiss all stale" — exactly the ids shown marked stale. Absent = not offered. */
    onDismissStale?: ((ids: string[]) => void) | undefined;
    /** The clock the ages are read against; now by default (tests pass a fixed one). */
    now?: number | undefined;
}

const HEADER_BUTTON = 'rounded-md border border-[var(--border-1)] px-2 py-1 text-xs text-[var(--fg-2)] hover:bg-[var(--bg-2)]';

export function Deck({ items, signals, answering, onAnswer, onOpenItem, onNavigate, onSignalAction, onAnswerForm, formRefusal = null, focusId = null, onDismiss, onDismissOlder, onDismissStale, now = Date.now() }: DeckProps) {
    const band = deckBand(items);
    const sections = deckSections(items);
    const waiting = needsYouCount(items);
    const staleItems = dismissableStale(band);
    const staleCount = band.length - waiting;
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
                 * band below, in words — not by a zero in the header. Stale questions are not
                 * waiting on anybody, so they are said beside it, not in it.
                 */}
                {waiting > 0 ? (
                    <span data-deck-count={waiting} className="font-mono text-xs text-[var(--fg-3)]">
                        {waiting} waiting on you
                    </span>
                ) : null}
                {staleCount > 0 ? (
                    <span data-deck-stale-count={staleCount} className="font-mono text-xs text-[var(--fg-4)]">
                        {staleCount} stale
                    </span>
                ) : null}
                <div className="ml-auto flex items-center gap-2">
                    {/* The questions nobody waits for any more: exactly the ones on screen, put aside in one go. */}
                    {onDismissStale && staleItems.length > 0 ? (
                        <button
                            type="button"
                            data-action="deck-dismiss-stale"
                            data-deck-stale={staleItems.length}
                            onClick={() => onDismissStale(staleItems.map((i) => i.id))}
                            title="Every question whose agent no longer waits; each agent is told"
                            className={HEADER_BUTTON}
                        >
                            {`Dismiss all stale (${staleItems.length})`}
                        </button>
                    ) : null}
                    {/* The questions nobody is going to answer: put aside in one go, each agent told. Only when there are such. */}
                    {onDismissOlder && old.length > 0 ? (
                        <button
                            type="button"
                            data-action="deck-dismiss-older"
                            data-deck-older={old.length}
                            onClick={() => onDismissOlder(DAY_MS)}
                            title="Each agent is told its question was dismissed without an answer"
                            className={HEADER_BUTTON}
                        >
                            {`Dismiss all older than 1 day (${old.length})`}
                        </button>
                    ) : null}
                </div>
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
                {band.length > 0 && waiting === 0 ? (
                    <p data-deck="only-stale" className="px-7 pt-3 text-[13px] text-[var(--fg-3)]">
                        Nothing is waiting on you. The questions below were asked by agents that no longer wait for them.
                    </p>
                ) : null}

                <div data-deck-band="needs-you">
                    {sections.map((section) => (
                        <DeckSectionView
                            key={section.key}
                            section={section}
                            answering={answering}
                            onAnswer={onAnswer}
                            onOpenItem={onOpenItem}
                            onAnswerForm={onAnswerForm}
                            formRefusal={formRefusal}
                            focusId={focusId}
                            focusRef={focusRef}
                            onDismiss={onDismiss}
                            now={now}
                        />
                    ))}
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
                                    <InlineOptions options={item.answer.options} answering={answeringFor(answering, item.agentId ?? '', null)} onAnswer={(optionId) => onAnswer(item, optionId)} />
                                ) : null}
                            </div>
                        ))}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

interface RowProps {
    answering: ApprovalAnswering | null;
    /** `note`: the person's words with an approval's answer (beta.33 item 16); absent = none. */
    onAnswer: (item: DeckItem, optionId: string, note?: string) => void;
    onOpenItem: (item: DeckItem) => void;
    onAnswerForm?: ((item: DeckItem, selections: string[][], notes: string[]) => void) | undefined;
    formRefusal: { itemId: string; reason: string } | null;
    focusId: string | null;
    focusRef: RefObject<HTMLDivElement | null>;
    onDismiss?: ((item: DeckItem, notes: string[]) => void) | undefined;
    now: number;
}

/** One workspace's section: the Dashboard's group header (name, then how many wait and how many are stale), then its rows. */
function DeckSectionView({ section, ...row }: RowProps & { section: DeckSection }) {
    const summary = [section.live > 0 ? `${section.live} waiting` : null, section.stale > 0 ? `${section.stale} stale` : null].filter(Boolean).join(' · ');
    return (
        <section data-deck-section={section.key} data-deck-section-live={section.live} data-deck-section-stale={section.stale}>
            <div className="flex h-7 items-center border-b border-[var(--border-1)] bg-[var(--bg-1)] pl-7 pr-5 text-xs">
                {/* The workspace's NAME (never its id — that is an attribute for tests); Genie's own items are Genie's. */}
                <span data-deck-workspace={section.workspaceId ?? ''} className="font-semibold">{section.label}</span>
                {summary ? <span className="ml-2.5 shrink-0 text-[var(--fg-3)]">{summary}</span> : null}
            </div>
            {section.items.map((item) => <DeckRow key={item.id} item={item} {...row} />)}
        </section>
    );
}

function DeckRow({ item, answering, onAnswer, onOpenItem, onAnswerForm, formRefusal, focusId, focusRef, onDismiss, now }: RowProps & { item: DeckItem }) {
    // A stale question's form is folded away until the person chooses to answer it anyway — its agent is not waiting.
    const [opened, setOpened] = useState(false);
    // A long to-do or message shows its first line; a click opens the whole text (the owner, 2026-10-18).
    const [expanded, setExpanded] = useState(false);
    const stale = item.stale;
    const questions = item.answer.kind === 'form' ? (item.answer.questions ?? null) : null;
    const dismissable = onDismiss !== undefined && isDismissable(item);
    const focused = item.id === focusId;
    const showForm = item.answer.kind === 'form' && questions !== null && (stale === undefined || opened);
    // This row's own flight: an agent parks one approval at a time, so the agent is the identity (core/approval-answering.ts).
    // Any other row stays live — one answer used to grey every row in the window for good.
    const answeringHere = answeringFor(answering, item.agentId ?? '', null);
    return (
        <div
            ref={focused ? focusRef : undefined}
            data-deck-item={item.id}
            {...(focused ? { 'data-deck-focus': 'true' } : {})}
            {...(stale ? { 'data-deck-item-stale': stale } : {})}
            data-blocking={item.blocking && !stale ? 'true' : 'false'}
            data-priority={item.priority}
            className={`border-b border-[var(--border-1)] px-7 py-3 ${focused ? 'bg-[var(--bg-1)] shadow-[inset_2px_0_0_var(--accent)]' : ''} ${stale && !opened ? 'opacity-60' : ''}`}
        >
            <div className="flex items-center gap-2 text-[13px]">
                {/* Blocking is the most important bit on the item, so it is the first thing on the row. An agent has
                    STOPPED — unless it no longer waits, and then the row says that instead. */}
                {item.blocking && !stale ? <span data-blocking-dot className="size-2 shrink-0 rounded-full bg-[var(--warning)]" /> : null}

                {item.agentName ? (
                    <button type="button" data-deck-agent={item.agentId} onClick={() => onOpenItem(item)} className="shrink-0 font-medium hover:underline">
                        {item.agentName}
                    </button>
                ) : null}

                {/* An agent's question is titled by its header — short, plain — and set like a title. */}
                {/* Anything else (a to-do, a message) is its own text: it wraps, read whole — the row is where it is read. */}
                {questions ? (
                    <span data-deck-title={item.id} className="min-w-0 flex-1 truncate font-semibold text-[var(--fg-1)]">{item.title}</span>
                ) : (() => {
                    const { preview, more } = deckPreview(item.title);
                    if (!more) return <span data-deck-title={item.id} className="min-w-0 flex-1 break-words text-[var(--fg-2)]">{item.title}</span>;
                    return (
                        <span data-deck-title={item.id} className="flex min-w-0 flex-1 items-baseline gap-2">
                            {expanded ? null : (
                                <button type="button" data-deck-preview={item.id} onClick={() => setExpanded(true)} className="min-w-0 truncate text-left text-[var(--fg-2)] hover:text-[var(--fg-1)]">{preview}</button>
                            )}
                            <button type="button" data-action="deck-expand" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)} className="shrink-0 text-[12px] text-[var(--accent)] hover:underline">{expanded ? 'Show less' : 'Show all'}</button>
                        </span>
                    );
                })()}

                {stale ? (
                    <span data-deck-stale-reason={stale} className="shrink-0">
                        <Badge color="zinc" variant="soft" size="sm">{staleLabel(stale)}</Badge>
                    </span>
                ) : null}
                {/* How long it has waited. */}
                {item.source === 'agent-question' && item.at > 0 ? (
                    <time data-deck-age={item.id} dateTime={new Date(item.at).toISOString()} className="shrink-0 text-[12px] text-[var(--fg-4)]">{ageLabel(item.at, now)}</time>
                ) : null}
                {/* Open: the agent it is about — a door, for when the answer needs its context. */}
                {item.agentId && item.source !== 'genie' ? (
                    <button type="button" data-action="deck-open" data-deck-open={item.id} onClick={() => onOpenItem(item)} className="shrink-0 rounded px-1.5 text-[12px] text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)]">
                        Open
                    </button>
                ) : null}
                {/* A stale question goes in one click (its form is folded; once opened, its own Dismiss carries the notes). */}
                {stale && dismissable && !showForm ? (
                    <button type="button" data-action="question-dismiss" data-deck-dismiss={item.id} onClick={() => onDismiss?.(item, [])} title="Put this question aside; the agent is told" className="shrink-0 rounded-md border border-[var(--border-1)] px-2 py-0.5 text-[12px] text-[var(--fg-2)] hover:bg-[var(--bg-2)]">
                        Dismiss
                    </button>
                ) : null}
            </div>

            {/* The whole text, opened (its line breaks kept): instructions read step by step, not as one run-on line. */}
            {expanded && !questions ? (
                <p data-deck-full={item.id} className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--fg-2)]">{item.title}</p>
            ) : null}

            {/* Answered WHERE IT IS READ. Navigating away is what the acceptance test forbids. */}
            {/*
             * A TOOL APPROVAL (an agent-question answered inline) is its card: the command is code, so it is
             * set as code. A to-do or a message is prose already shown whole in the row — its buttons only,
             * never its text again in a monospace box.
             */}
            {item.answer.kind === 'inline' && item.source === 'agent-question' ? (
                <ApprovalCard approval={{ question: item.title, options: item.answer.options }} answering={answeringHere} onAnswer={(optionId, note) => onAnswer(item, optionId, note)} />
            ) : null}
            {item.answer.kind === 'inline' && item.source !== 'agent-question' ? (
                <InlineOptions options={item.answer.options} answering={answeringHere} onAnswer={(optionId) => onAnswer(item, optionId)} />
            ) : null}

            {/*
             * An agent's questions: the body IS the form — each question rendered from its Markdown, its options, its
             * note, Answer and Dismiss (which carries the notes too). Keyed by the revision, so a question its agent
             * updated starts a clean draft. A stale one is folded behind "Answer anyway".
             */}
            {item.answer.kind === 'form' && questions && stale && !opened ? (
                <div className="mt-2">
                    <button type="button" data-action="deck-answer-anyway" data-deck-answer-anyway={item.id} onClick={() => setOpened(true)} className="rounded-md border border-[var(--border-1)] px-2 py-1 text-xs text-[var(--fg-2)] hover:bg-[var(--bg-2)]">
                        Answer anyway
                    </button>
                </div>
            ) : null}
            {showForm && questions ? (
                <div className="mt-2 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] px-4 py-3">
                    <QuestionForm
                        key={`${item.id}:${item.revision ?? 0}`}
                        item={item}
                        answering={answeringHere}
                        refusal={formRefusal?.itemId === item.id ? formRefusal.reason : null}
                        onSubmit={(selections, notes) => onAnswerForm?.(item, selections, notes)}
                        onDismiss={dismissable ? (notes) => onDismiss?.(item, notes) : undefined}
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
                    {dismissable && !stale ? (
                        <button type="button" data-action="question-dismiss" data-deck-dismiss={item.id} onClick={() => onDismiss?.(item, [])} className="rounded-md border border-[var(--border-1)] px-2 py-1 text-xs text-[var(--fg-2)] hover:bg-[var(--bg-2)]">Dismiss</button>
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
