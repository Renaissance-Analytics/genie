import { ContentRenderer } from '@particle-academy/react-fancy';
import { genieClipboardWriter } from '../clipboard.js';
import { useState, type FormEvent } from 'react';
import type { DeckItem } from '../../core/deck.js';
import { toggleChoice, unansweredCount } from '../../core/deck-resolve.js';
import type { QuestionDraft } from '../../core/question-drafts.js';

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
 * Beside Answer: the question is put aside WITHOUT an answer and its agent is told so (attention-store.ts) — with the
 * notes written in the form, so a person can say why, or what to do instead (the owner, 2026-10-15: "I NEED THE ABILITY TO
 * ADD NOTES TO ANY AND ALL QUESTIONS"). A note is never required to dismiss. Offered only where the surface wires it.
 *
 * ## The draft outlives the form
 *
 * `initial` starts it and `onDraft` hears every change, so a surface that shows several questions (the question window's
 * queue) keeps each one's draft by question id and hands it back when the person returns to it — nothing typed is lost
 * to another agent's question arriving, or to looking at another question (the owner, 2026-10-15).
 */
// The draft is the question's, not the form's (core/question-drafts.ts): the question window keeps one per question id.
export type { QuestionDraft };

export interface QuestionFormProps {
    readonly item: DeckItem;
    /** The item being sent: its submit is disabled meanwhile. */
    readonly answering: string | null;
    readonly onSubmit: (selections: string[][], notes: string[]) => void;
    /** "Later" in the question window (the question stays in the Deck). Absent = no such button (the Deck's form is always open). */
    readonly onCancel?: (() => void) | undefined;
    readonly cancelLabel?: string;
    /** The key that does what the cancel button does (the FTQ window's Esc is Later); named in its title. */
    readonly cancelKey?: string | undefined;
    /** Dismiss without an answer, with the notes written so far (one per question); absent = not offered here. */
    readonly onDismiss?: ((notes: string[]) => void) | undefined;
    /** Why main refused the last answer — said beside the buttons. */
    readonly refusal?: string | null;
    /** A starting draft (tests render a filled-in form with it). */
    readonly initial?: QuestionDraft;
    /** Show each question's header chip. The Deck hides it for a single question: the row's title is that header. */
    readonly showHeaders?: boolean;
    /** Every change to the draft (an option picked or cleared, a note written), as the whole draft. */
    readonly onDraft?: ((draft: QuestionDraft) => void) | undefined;
}

export function QuestionForm({ item, answering, onSubmit, onCancel, cancelLabel = 'Cancel', cancelKey, onDismiss, refusal = null, initial, showHeaders = true, onDraft }: QuestionFormProps) {
    const questions = item.answer.kind === 'form' ? (item.answer.questions ?? null) : null;
    const count = questions?.length ?? 0;
    const [selections, setSelections] = useState<string[][]>(() => Array.from({ length: count }, (_, i) => [...(initial?.selections[i] ?? [])]));
    const [notes, setNotes] = useState<string[]>(() => Array.from({ length: count }, (_, i) => initial?.notes[i] ?? ''));
    if (!questions) return null;

    const remaining = unansweredCount(count, selections, notes);
    const sending = answering === item.id;
    // Computed from this render's values (one change per event), so the draft handed to `onDraft` is exactly what is shown.
    // Genie 1's toggle (core/deck-resolve.ts `toggleChoice`): a picked option clicked again clears.
    const pick = (i: number, label: string, multi: boolean) => {
        const next = selections.map((s, j) => (j !== i ? s : toggleChoice(s, label, multi)));
        setSelections(next);
        onDraft?.({ selections: next, notes });
    };
    const write = (i: number, text: string) => {
        const next = notes.map((n, j) => (j === i ? text : n));
        setNotes(next);
        onDraft?.({ selections, notes: next });
    };
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
                        <ContentRenderer clipboardWriter={genieClipboardWriter} value={q.question} format="markdown" lineSpacing={1.6} className="font-sans text-[13px] text-[var(--fg-1)]" />
                    </div>
                    {/* TOGGLE OPTIONS (Genie 1's): a button per option, pressed when picked; a picked option clicked again clears.
                        A radio could not be unpicked. */}
                    <div role="group" aria-label={q.header} className="flex flex-wrap gap-1.5">
                        {q.options.map((o) => {
                            const on = (selections[i] ?? []).includes(o.label);
                            return (
                                <button
                                    key={o.label}
                                    type="button"
                                    data-question-option={o.label}
                                    data-select={q.multiSelect ? 'multi' : 'single'}
                                    aria-pressed={on}
                                    onClick={() => pick(i, o.label, q.multiSelect === true)}
                                    title={o.description ?? undefined}
                                    className={`max-w-full rounded-lg border px-2.5 py-1 text-left text-[13px] leading-snug ${on ? 'border-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_18%,transparent)] text-[var(--fg-1)]' : 'border-[var(--border-1)] text-[var(--fg-2)] hover:bg-[var(--bg-2)]'}`}
                                >
                                    <span className="font-medium">{o.label}</span>
                                    {o.description ? <span className="block text-[12px] text-[var(--fg-3)]">{o.description}</span> : null}
                                </button>
                            );
                        })}
                    </div>
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
                {onCancel ? <button type="button" data-action="question-cancel" onClick={onCancel} {...(cancelKey ? { title: `${cancelLabel} (${cancelKey})`, 'aria-keyshortcuts': cancelKey === 'Esc' ? 'Escape' : cancelKey } : {})} className="rounded-lg border border-[var(--border-1)] px-3 py-1 text-[12px]">{cancelLabel}</button> : null}
                {onDismiss ? (
                    <button type="button" data-action="question-dismiss" data-deck-dismiss={item.id} disabled={sending} onClick={() => onDismiss([...notes])} title="Put this question aside without an answer; the agent is told, with any note you wrote" className="rounded-lg border border-[var(--border-1)] px-3 py-1 text-[12px] text-[var(--fg-2)] hover:bg-[var(--bg-2)] disabled:opacity-60">Dismiss</button>
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
