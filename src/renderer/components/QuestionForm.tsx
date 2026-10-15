import { ContentRenderer } from '@particle-academy/react-fancy';
import { useState, type FormEvent } from 'react';
import type { DeckItem } from '../../core/deck.js';
import { unansweredCount } from '../../core/deck-resolve.js';

/**
 * ONE AGENT'S QUESTIONS, AS A FORM (§6.3): each question with its options (radio, or checkboxes for multi-select) and ITS
 * OWN note right under them — Genie 1's FTQ, which the owner asked for back (2026-10-14: "I should have a note section for
 * every question asked and this automatically provided"). A question is answered by an option OR a note; the Answer button
 * stays disabled until every question is, and the line beside it says how many still need one (the owner: "I had to give
 * an answer to every question or I couldn't submit … That was not obvious due to the button being enabled"). A refusal
 * from main is said beside the buttons, where the person clicked — never only at the top of a scrolled window. The Deck
 * shows it in place; the question window shows it the moment an agent asks — one component, so the two never differ.
 *
 * ## It is READ before it is answered
 *
 * The owner, 2026-10-15, on the Deck: "I can't read this." The question is prose an agent wrote in Markdown, so it is
 * rendered (ContentRenderer), in the sans face at 13px with room between lines, at a reading width — never monospace,
 * never cut off. The options read at the same size as the question. The header chip labels a question among several; a
 * surface whose title already IS the one header (the Deck) leaves it out.
 *
 * ## Dismiss
 *
 * Beside Answer: the question is put aside WITHOUT an answer and its agent is told so (attention-store.ts). Offered only
 * where the surface wires it.
 */
export interface QuestionDraft {
    /** Chosen labels, one array per question. */
    readonly selections: readonly (readonly string[])[];
    /** One note per question ('' where none). */
    readonly notes: readonly string[];
}

export interface QuestionFormProps {
    readonly item: DeckItem;
    /** The item being sent: its submit is disabled meanwhile. */
    readonly answering: string | null;
    readonly onSubmit: (selections: string[][], notes: string[]) => void;
    /** "Later" in the question window (the question stays in the Deck). Absent = no such button (the Deck's form is always open). */
    readonly onCancel?: (() => void) | undefined;
    readonly cancelLabel?: string;
    /** Dismiss without an answer; absent = not offered here. */
    readonly onDismiss?: (() => void) | undefined;
    /** Why main refused the last answer — said beside the buttons. */
    readonly refusal?: string | null;
    /** A starting draft (tests render a filled-in form with it). */
    readonly initial?: QuestionDraft;
    /** Show each question's header chip. The Deck hides it for a single question: the row's title is that header. */
    readonly showHeaders?: boolean;
}

export function QuestionForm({ item, answering, onSubmit, onCancel, cancelLabel = 'Cancel', onDismiss, refusal = null, initial, showHeaders = true }: QuestionFormProps) {
    const questions = item.answer.kind === 'form' ? (item.answer.questions ?? null) : null;
    const count = questions?.length ?? 0;
    const [selections, setSelections] = useState<string[][]>(() => Array.from({ length: count }, (_, i) => [...(initial?.selections[i] ?? [])]));
    const [notes, setNotes] = useState<string[]>(() => Array.from({ length: count }, (_, i) => initial?.notes[i] ?? ''));
    if (!questions) return null;

    const remaining = unansweredCount(count, selections, notes);
    const sending = answering === item.id;
    const pick = (i: number, label: string, multi: boolean, on: boolean) =>
        setSelections((prev) => prev.map((s, j) => (j !== i ? s : multi ? (on ? [...s.filter((l) => l !== label), label] : s.filter((l) => l !== label)) : on ? [label] : [])));
    const write = (i: number, text: string) => setNotes((prev) => prev.map((n, j) => (j === i ? text : n)));
    const submit = (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (remaining > 0 || sending) return;
        onSubmit(selections.map((s) => [...s]), [...notes]);
    };
    return (
        <form data-deck-form={item.id} onSubmit={submit} className="flex max-w-[72ch] flex-col gap-4 font-sans text-[13px]">
            {questions.map((q, i) => (
                <fieldset key={i} data-deck-question={i} className="flex flex-col gap-2">
                    {showHeaders ? (
                        <legend className="mb-1 w-full">
                            <span data-question-header={i} className="rounded-sm bg-[var(--bg-3)] px-1.5 py-px text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-3)]">{q.header}</span>
                        </legend>
                    ) : null}
                    {/* The question is Markdown (§6.3): agents write bold, lists and links into it. Prose: sans, 13px, 1.6. */}
                    <div data-question-text={i} className="min-w-0 break-words">
                        <ContentRenderer value={q.question} format="markdown" lineSpacing={1.6} className="font-sans text-[13px] text-[var(--fg-1)]" />
                    </div>
                    {q.options.map((o) => (
                        <label key={o.label} className="flex items-start gap-2 text-[13px] leading-snug text-[var(--fg-2)]">
                            <input
                                type={q.multiSelect ? 'checkbox' : 'radio'}
                                name={`q${i}`}
                                value={o.label}
                                checked={(selections[i] ?? []).includes(o.label)}
                                onChange={(e) => pick(i, o.label, q.multiSelect === true, e.currentTarget.checked)}
                                className="mt-0.5"
                            />
                            <span>
                                {o.label}
                                {o.description ? <span className="block text-[12px] text-[var(--fg-3)]">{o.description}</span> : null}
                            </span>
                        </label>
                    ))}
                    {/* This question's own note (§6.3; Genie 1's FTQ had one per question). A note alone answers it. */}
                    <textarea
                        name={`note${i}`}
                        data-deck-note={item.id}
                        data-question-note={i}
                        rows={2}
                        value={notes[i] ?? ''}
                        onChange={(e) => write(i, e.currentTarget.value)}
                        placeholder="Add a note (optional if you picked an option)"
                        className="rounded-md border border-[var(--border-1)] bg-transparent px-2 py-1 font-sans text-[13px]"
                    />
                </fieldset>
            ))}
            <div className="flex flex-wrap items-center gap-2">
                <button type="submit" data-action="deck-submit" disabled={sending || remaining > 0} className="rounded-lg border border-[var(--primary-hover)] bg-[var(--primary)] px-3 py-1 text-[12px] font-medium text-white hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-60">Answer</button>
                {onCancel ? <button type="button" data-action="question-cancel" onClick={onCancel} className="rounded-lg border border-[var(--border-1)] px-3 py-1 text-[12px]">{cancelLabel}</button> : null}
                {onDismiss ? (
                    <button type="button" data-action="question-dismiss" data-deck-dismiss={item.id} disabled={sending} onClick={onDismiss} title="Put this question aside without an answer; the agent is told" className="rounded-lg border border-[var(--border-1)] px-3 py-1 text-[12px] text-[var(--fg-2)] hover:bg-[var(--bg-2)] disabled:opacity-60">Dismiss</button>
                ) : null}
                {remaining > 0 ? (
                    <span data-question-remaining={remaining} className="text-[11px] text-[var(--fg-3)]">
                        {`${remaining} of ${count} still ${remaining === 1 ? 'needs' : 'need'} an option or a note`}
                    </span>
                ) : null}
            </div>
            {refusal ? <p role="alert" data-question-refusal="" className="rounded-md border border-[var(--danger)] px-2 py-1 text-[12px] text-[var(--danger)]">{refusal}</p> : null}
        </form>
    );
}
