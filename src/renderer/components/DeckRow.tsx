import { Badge, Button, Icon } from '@particle-academy/react-fancy';
import { useState, type ReactNode, type RefObject } from 'react';
import { QuestionForm } from './QuestionForm.js';
import { personText } from '../../core/person-text.js';
import { answeringFor, type ApprovalAnswering } from '../../core/approval-answering.js';
import {
    ageLabel,
    deckBody,
    deckPreview,
    linkParts,
    isDismissable,
    staleLabel,
    type DeckItem,
} from '../../core/deck.js';
import { ApprovalCard, ApprovalMarker } from './ApprovalCard.js';

/**
 * ONE WAITING ITEM, AS A ROW - what used to be the Deck page's row, now drawn under its agent's row on the Dashboard (Tynn #730,
 * the owner's option B; the Deck is not a page). Answered WHERE IT IS READ: inline options as buttons, an agent's questions as
 * their form (QuestionForm), a forwarded one shown with the host it belongs to rather than a button that would mark it done while
 * the real question waits forever.
 *
 * ## A question is READ here (the owner, 2026-10-15: "I can't read this")
 *
 * The row's title is the question's short header - plain text. The body is the question itself, rendered from its Markdown by
 * QuestionForm, the same form the question window shows. Every question has a note of its own, which travels with the answer AND
 * with a Dismiss.
 *
 * ## Stale: kept, and said (the owner, 2026-10-15: "Keep, but mark stale")
 *
 * A question whose agent no longer waits stays, greyed, labelled with why, with a one-click Dismiss; its form opens in place with
 * "Answer anyway". A stale question is not counted as waiting on you: its agent is not waiting.
 *
 * ## An approval a toast carries is not answered here
 *
 * The approval toasts (core/approval-toasts.ts) are the one actionable place; this row shows a marker for them.
 */

export interface RowProps {
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
    initiallyExpanded?: readonly string[] | undefined;
    busy?: { itemId: string; optionId: string } | null | undefined;
    onTrustWorkspace?: ((workspaceId: string) => Promise<unknown>) | undefined;
    /**
     * The approvals a toast carries (Tynn #730, core/approval-toasts.ts): the toast is where they are answered, so this row
     * shows a marker and no second set of buttons. Absent / not in it = the row's own card answers (Do Not Disturb held it back).
     */
    toastIds?: ReadonlySet<string> | undefined;
}


export function DeckRow({ item, answering, onAnswer, onOpenItem, onAnswerForm, formRefusal, focusId, focusRef, onDismiss, now, initiallyExpanded, busy, onTrustWorkspace, toastIds }: RowProps & { item: DeckItem }) {
    // A stale question's form is folded away until the person chooses to answer it anyway — its agent is not waiting.
    const [opened, setOpened] = useState(false);
    // A long to-do or message shows its first line; a click opens the whole text (the owner, 2026-10-18).
    const [expanded, setExpanded] = useState(initiallyExpanded?.includes(item.id) === true);
    const stale = item.stale;
    const questions = item.answer.kind === 'form' ? (item.answer.questions ?? null) : null;
    const dismissable = onDismiss !== undefined && isDismissable(item);
    const focused = item.id === focusId;
    const showForm = item.answer.kind === 'form' && questions !== null && (stale === undefined || opened);
    // This row's own flight: an agent parks one approval at a time, so the agent is the identity (core/approval-answering.ts).
    // Any other row stays live — one answer used to grey every row in the window for good.
    const answeringHere = answeringFor(answering, item.agentId ?? '', null);
    // The title as the person reads it (Tynn #696): no internal id. An approval's own card still shows its command whole.
    const title = personText(item.title);
    return (
        <div
            ref={focused ? focusRef : undefined}
            data-deck-item={item.id}
            {...(focused ? { 'data-deck-focus': 'true' } : {})}
            {...(stale ? { 'data-deck-item-stale': stale } : {})}
            data-blocking={item.blocking && !stale ? 'true' : 'false'}
            data-priority={item.priority}
            className={`border-b border-[var(--border-1)] px-7 py-3 ${focused ? 'bg-[var(--bg-1)] shadow-[inset_2px_0_0_var(--accent)]' : ''}`}
        >
            <div className="flex items-center gap-2 text-[13px]">
                {/* Blocking is the most important bit on the item, so it is the first thing on the row. An agent has
                    STOPPED — unless it no longer waits, and then the row says that instead. */}
                {item.blocking && !stale ? <span data-blocking-dot className="size-2 shrink-0 rounded-full bg-[var(--warning)]" /> : null}

                {item.agentName ? (
                    <Button size="xs" type="button" data-deck-agent={item.agentId} onClick={() => onOpenItem(item)} className="shrink-0 font-medium">
                        {item.agentName}
                    </Button>
                ) : null}

                {/* An agent's question is titled by its header — short, plain — and set like a title. */}
                {/* Anything else (a to-do, a message) is its own text: it wraps, read whole — the row is where it is read. */}
                {questions ? (
                    <span data-deck-title={item.id} className="min-w-0 flex-1 truncate font-semibold text-[var(--fg-1)]">{title}</span>
                ) : (() => {
                    // A short bold title (Tynn #602): the item's first line, and all the closed row shows.
                    // The folded detail (Tynn #693) is something to open too, even under a title that fits.
                    const { preview, more: longer } = deckPreview(title);
                    const more = longer || Boolean(item.detail);
                    if (!more) return <span data-deck-title={item.id} className="min-w-0 flex-1 break-words font-semibold text-[var(--fg-1)]">{preview}</span>;
                    return (
                        <span data-deck-title={item.id} className="flex min-w-0 flex-1 items-baseline gap-2">
                            {expanded ? <span className="min-w-0 break-words font-semibold text-[var(--fg-1)]">{deckBody(title).title}</span> : (
                                <Button size="xs" type="button" data-deck-preview={item.id} onClick={() => setExpanded(true)} className="min-w-0 truncate text-left font-semibold text-[var(--fg-1)] justify-start">{preview}</Button>
                            )}
                            <Button size="xs" type="button" data-action="deck-expand" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)} className="shrink-0 text-[12px] text-[var(--accent)]">{expanded ? 'Show less' : 'Show all'}</Button>
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
                    <Button size="xs" type="button" data-action="deck-open" data-deck-open={item.id} onClick={() => onOpenItem(item)} className="shrink-0 rounded px-1.5 text-[12px] text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)]">
                        Open
                    </Button>
                ) : null}
                {/* Done (a to-do's answer, a message's) ends the row, beside Open (Tynn #602): not a row of its own. */}
                {item.answer.kind === 'inline' && item.source !== 'agent-question' ? (
                    <InlineOptions options={item.answer.options} answering={answeringHere} busy={busy?.itemId === item.id ? busy.optionId : null} onAnswer={(optionId) => onAnswer(item, optionId)} inRow />
                ) : null}
                {/* A stale question goes in one click (its form is folded; once opened, its own Dismiss carries the notes). */}
                {stale && dismissable && !showForm ? (
                    <Button size="xs" type="button" data-action="question-dismiss" data-deck-dismiss={item.id} onClick={() => onDismiss?.(item, [])} title="Put this question aside; the agent is told" className="shrink-0 rounded-md border border-[var(--border-1)] px-2 py-0.5 text-[12px] text-[var(--fg-2)] hover:bg-[var(--bg-2)]">
                        Dismiss
                    </Button>
                ) : null}
            </div>

            {/* The whole text, opened (its line breaks kept): instructions read step by step, not as one run-on line. */}
            {expanded && !questions ? <DeckItemBody item={item} /> : null}

            {/* Answered WHERE IT IS READ. Navigating away is what the acceptance test forbids. */}
            {/*
             * A TOOL APPROVAL (an agent-question answered inline) is its card: the command is code, so it is
             * set as code. A to-do or a message is prose already shown whole in the row — its buttons only,
             * never its text again in a monospace box.
             */}
            {item.answer.kind === 'inline' && item.source === 'agent-question' && toastIds?.has(item.id) ? (
                <ApprovalMarker where="the toast at the bottom left" />
            ) : null}
            {item.answer.kind === 'inline' && item.source === 'agent-question' && !toastIds?.has(item.id) ? (
                <ApprovalCard approval={{ question: item.title, options: item.answer.options, why: item.why ?? null }} answering={answeringHere} onAnswer={(optionId, note) => onAnswer(item, optionId, note)} onTrustWorkspace={onTrustWorkspace && item.workspaceId ? () => onTrustWorkspace(item.workspaceId!) : undefined} />
            ) : null}

            {/*
             * An agent's questions: the body IS the form — each question rendered from its Markdown, its options, its
             * note, Answer and Dismiss (which carries the notes too). Keyed by the revision, so a question its agent
             * updated starts a clean draft. A stale one is folded behind "Answer anyway".
             */}
            {item.answer.kind === 'form' && questions && stale && !opened ? (
                <div className="mt-2">
                    <Button size="xs" type="button" data-action="deck-answer-anyway" data-deck-answer-anyway={item.id} onClick={() => setOpened(true)} className="rounded-md border border-[var(--border-1)] px-2 py-1 text-xs text-[var(--fg-2)] hover:bg-[var(--bg-2)]">
                        Answer
                    </Button>
                </div>
            ) : null}
            {/* A refused action on this row is said here (Tynn #600); an open form says it beside its own buttons. */}
            {formRefusal?.itemId === item.id && !showForm ? (
                <p data-deck-refusal={item.id} role="alert" className="mt-2 text-xs text-[var(--danger)]">{formRefusal.reason}</p>
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
                    <Button size="xs" labelClassName="contents"
                        type="button"
                        data-deck-expand={item.id}
                        onClick={() => onOpenItem(item)}
                        className="flex items-center gap-1.5 rounded-md border border-[var(--border-1)] px-2 py-1 text-xs hover:bg-[var(--bg-2)]"
                    >
                        <Icon name="list-checks" size="xs" />
                        {item.answer.fields === 1 ? 'Answer 1 question' : `Answer ${item.answer.fields} questions`}
                    </Button>
                    {dismissable && !stale ? (
                        <Button size="xs" type="button" data-action="question-dismiss" data-deck-dismiss={item.id} onClick={() => onDismiss?.(item, [])} className="rounded-md border border-[var(--border-1)] px-2 py-1 text-xs text-[var(--fg-2)] hover:bg-[var(--bg-2)]">Dismiss</Button>
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
/**
 * An item opened (Tynn #602): its text, then its steps as a numbered list, each web address a link that opens in the
 * browser (the window sends every new-window link out, main/external-links.ts). One long line with no steps is shown whole.
 */
function DeckItemBody({ item }: { item: DeckItem }) {
    const body = deckBody(personText(item.title));
    // ONLY what the title does not already say (Tynn #693): an item that is one long line is whole in its opened title, and
    // was drawn a second time here.
    const paragraphs = body.text;
    if (paragraphs.length === 0 && body.steps.length === 0 && !item.detail) return null;
    return (
        <div data-deck-body={item.id} data-deck-full={item.id} className="mt-2 flex max-w-[72ch] flex-col gap-2 break-words text-[13px] leading-relaxed text-[var(--fg-2)]">
            {paragraphs.map((p, i) => <p key={i}>{linked(p)}</p>)}
            {body.steps.length > 0 ? (
                <ol data-deck-steps={item.id} className="flex list-decimal flex-col gap-1 pl-5">
                    {body.steps.map((step, i) => <li key={i} data-deck-step={i + 1}>{linked(step)}</li>)}
                </ol>
            ) : null}
            {/* The technical detail (an error, its paths): once, here, as it was written. */}
            {item.detail ? <pre data-deck-detail={item.id} className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] p-2 font-mono text-[12px] text-[var(--fg-3)]">{personText(item.detail)}</pre> : null}
        </div>
    );
}

function linked(text: string): ReactNode[] {
    return linkParts(text).map((part, i) => (typeof part === 'string' ? part : (
        <Button key={i} variant="ghost" size="xs" href={part.url} target="_blank" rel="noreferrer" data-deck-link="" className="inline h-auto break-all p-0 align-baseline text-[13px] text-[var(--accent)] underline">{part.url}</Button>
    )));
}

function InlineOptions({ options, answering, busy = null, onAnswer, inRow = false }: { options: readonly { id: string; label: string }[]; answering: string | null; busy?: string | null; onAnswer: (optionId: string) => void; inRow?: boolean }) {
    return (
        <div {...(busy ? { 'data-deck-busy': busy } : {})} className={inRow ? 'flex shrink-0 gap-1' : 'mt-2 flex flex-wrap gap-2'}>
            {options.map((option) => (
                <Button size="xs"
                    key={option.id}
                    type="button"
                    data-approval-option={option.id}
                    loading={busy === option.id}
                    disabled={answering !== null || busy !== null}
                    onClick={() => (busy !== null ? undefined : onAnswer(option.id))}
                    className="rounded-md border border-[var(--border-2)] px-2.5 py-1 text-xs text-[var(--fg-2)] hover:bg-[var(--bg-2)] disabled:opacity-50"
                >
                    {option.label}
                </Button>
            ))}
        </div>
    );
}
