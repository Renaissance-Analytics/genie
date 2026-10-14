import { ContentRenderer } from '@particle-academy/react-fancy';
import type { FormEvent } from 'react';
import type { DeckItem } from '../../core/deck.js';

/**
 * ONE AGENT'S QUESTIONS, AS A FORM (§6.3): each question with its options (radio, or checkboxes for multi-select), and the
 * free-text note the form always offers. The Deck shows it in place; the question modal shows it the moment an agent asks
 * — one component, so the two can never ask differently.
 */
export interface QuestionFormProps {
    readonly item: DeckItem;
    /** The item being sent: its submit is disabled meanwhile. */
    readonly answering: string | null;
    readonly onSubmit: (selections: string[][], note: string) => void;
    readonly onCancel: () => void;
    /** "Cancel" in the Deck; "Later" in the modal (the question stays in the Deck). */
    readonly cancelLabel?: string;
}

export function QuestionForm({ item, answering, onSubmit, onCancel, cancelLabel = 'Cancel' }: QuestionFormProps) {
    if (item.answer.kind !== 'form' || !item.answer.questions) return null;
    const questions = item.answer.questions;
    const submit = (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        onSubmit(questions.map((_, i) => data.getAll(`q${i}`).map(String)), String(data.get('note') ?? ''));
    };
    return (
        <form data-deck-form={item.id} onSubmit={submit} className="flex flex-col gap-3 text-xs">
            {questions.map((q, i) => (
                <fieldset key={i} data-deck-question={i} className="flex flex-col gap-1.5">
                    <legend className="w-full">
                        <span className="rounded-sm bg-[var(--bg-3)] px-1.5 py-px font-mono text-[10px] uppercase tracking-wide text-[var(--fg-3)]">{q.header}</span>
                    </legend>
                    {/* The question is Markdown (§6.3): agents write bold, lists and links into it. */}
                    <div data-question-text={i}>
                        <ContentRenderer value={q.question} format="markdown" lineSpacing={1.5} className="text-[13px] text-[var(--fg-1)]" />
                    </div>
                    {q.options.map((o) => (
                        <label key={o.label} className="flex items-start gap-2 text-[12px] text-[var(--fg-2)]">
                            <input type={q.multiSelect ? 'checkbox' : 'radio'} name={`q${i}`} value={o.label} className="mt-0.5" />
                            <span>
                                {o.label}
                                {o.description ? <span className="block text-[11px] text-[var(--fg-4)]">{o.description}</span> : null}
                            </span>
                        </label>
                    ))}
                </fieldset>
            ))}
            {/* The free text the form always offers (§6.3). */}
            <textarea name="note" data-deck-note={item.id} rows={2} placeholder="A note for the agent (optional)" className="rounded-md border border-[var(--border-1)] bg-transparent px-2 py-1 text-[12px]" />
            <div className="flex items-center gap-2">
                <button type="submit" data-action="deck-submit" disabled={answering === item.id} className="rounded-lg border border-[var(--primary-hover)] bg-[var(--primary)] px-3 py-1 text-[12px] font-medium text-white hover:bg-[var(--primary-hover)] disabled:opacity-60">Answer</button>
                <button type="button" data-action="question-cancel" onClick={onCancel} className="rounded-lg border border-[var(--border-1)] px-3 py-1 text-[12px]">{cancelLabel}</button>
            </div>
        </form>
    );
}
