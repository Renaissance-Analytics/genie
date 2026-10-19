import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem, SignalState } from '../src/core/deck.js';
import { Deck } from '../src/renderer/components/Deck.js';
import { QuestionForm, type QuestionDraft } from '../src/renderer/components/QuestionForm.js';

/**
 * THE FORM IN PLACE (§4.5): an agent's questions are their form, right in the Deck row where they are read (the body IS
 * the form since the owner's "I can't read this", 2026-10-15 — no door to click first) — one fieldset per
 * question with its header chip, Genie 1's TOGGLE options (the owner, 2026-10-19: "I should be able to unselect a
 * choice" — a radio cannot be unpicked; a picked option clicked again clears), ONE NOTE PER QUESTION
 * right under its options, and one Answer button. No modal, no navigation: the acceptance test for the Deck is clearing
 * the whole band without navigating once.
 *
 * The owner on beta.26 (2026-10-14): "I should have a note section for every question asked … Look at the old FTQ
 * interface", and "I had to give an answer to every question or I couldn't submit the answer. That was not obvious due to
 * the button being enabled." So: a note under every question; Answer DISABLED until each question has an option or a
 * note, with a line beside it counting what is left; and a refusal from main said beside the buttons.
 */
const QUIET: SignalState = { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false } as SignalState;
const questions = [
    { header: 'Workers', question: 'How many workers?', options: [{ label: '4' }, { label: '8' }] },
    { header: 'Scope', question: 'Which suites?', options: [{ label: 'unit' }, { label: 'e2e' }], multiSelect: true },
];
const item: DeckItem = { id: 'q_1', source: 'agent-question', agentId: 'a1', agentName: 'lark', workspaceId: 'moic', title: 'Workers + 1 more', blocking: true, priority: 'normal', at: 1, answer: { kind: 'form', fields: 2, questions }, forwardedFrom: null };
const render = () =>
    renderToStaticMarkup(<Deck items={[item]} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} onAnswerForm={() => {}} />);
const form = (initial?: QuestionDraft, refusal: string | null = null) =>
    renderToStaticMarkup(<QuestionForm item={item} answering={null} refusal={refusal} onSubmit={() => {}} onCancel={() => {}} {...(initial ? { initial } : {})} />);
const submitTag = (html: string) => html.match(/<button[^>]*data-action="deck-submit"[^>]*>/)?.[0] ?? '';

describe('the in-place form', () => {
    it('the body IS the form — no door to open it first (a question is read where it waits)', () => {
        const html = render();
        expect(html).toContain('data-deck-form="q_1"');
        expect(html).not.toContain('data-deck-expand');
    });

    it('a fieldset per question with the header chip, toggle options marked single or multi, a note per question, one Answer button — and no navigation', () => {
        const html = render();
        expect(html).toContain('data-deck-form="q_1"');
        expect((html.match(/data-deck-question="/g) ?? []).length).toBe(2);
        expect(html).toMatch(/data-deck-question="0"[^]*?data-question-option="4"[^>]*data-select="single"/);
        expect(html).toMatch(/data-deck-question="1"[^]*?data-question-option="unit"[^>]*data-select="multi"/);
        // No radio or checkbox: neither can be unpicked by clicking it again.
        expect(html).not.toMatch(/type="radio"|type="checkbox"/);
        expect(html).toContain('Workers');
        expect(html).toContain('Scope');
        // COUNTED: one note per question, not one for the form.
        expect((html.match(/data-deck-note="q_1"/g) ?? []).length).toBe(2);
        expect((html.match(/<button[^>]*data-action="deck-submit"[^>]*>Answer</g) ?? []).length).toBe(1);
        expect(html).not.toContain('data-nav=');
        // The door is gone while the form is open — one rendering of one decision.
        expect(html).not.toContain('data-deck-expand="q_1"');
    });

    it('an item that did not carry its questions draws no form — its door opens the agent', () => {
        const bare: DeckItem = { ...item, answer: { kind: 'form', fields: 2 } };
        const html = renderToStaticMarkup(<Deck items={[bare]} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} onAnswerForm={() => {}} />);
        expect(html).not.toContain('data-deck-form');
        expect(html).toContain('data-deck-expand="q_1"');
    });

    it('a refused answer is said beside THAT item’s Answer button in the Deck — not only in the console', () => {
        const refused = renderToStaticMarkup(<Deck items={[item]} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} onAnswerForm={() => {}} formRefusal={{ itemId: 'q_1', reason: 'Scope needs an option or a note' }} />);
        expect(refused).toMatch(/data-action="deck-submit"[^]*role="alert"[^>]*>Scope needs an option or a note</);
        // Control: a refusal about another item is not said on this one.
        const other = renderToStaticMarkup(<Deck items={[item]} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} onAnswerForm={() => {}} formRefusal={{ itemId: 'q_9', reason: 'elsewhere' }} />);
        expect(other).not.toContain('elsewhere');
    });
});

describe('the form says what is left and only lets a ready answer through', () => {
    it('one note textarea per question, each right under its own options, with the placeholder that says when it is optional', () => {
        const html = form();
        expect((html.match(/<textarea[^>]*data-deck-note="q_1"/g) ?? []).length).toBe(2);
        // Inside each question's fieldset, after its options.
        expect(html).toMatch(/data-deck-question="0"(?:(?!<\/fieldset>)[^])*data-question-option=(?:(?!<\/fieldset>)[^])*data-question-note="0"/);
        expect(html).toMatch(/data-deck-question="1"(?:(?!<\/fieldset>)[^])*data-question-option=(?:(?!<\/fieldset>)[^])*data-question-note="1"/);
        expect(html).toContain('placeholder="Add a note (optional if you picked an option)"');
    });

    it('nothing filled in: Answer is DISABLED and the line beside it counts both questions', () => {
        const html = form();
        expect(submitTag(html)).toContain('disabled=""');
        expect(html).toMatch(/data-question-remaining="2"[^>]*>2 of 2 still need an option or a note</);
    });

    it('one answered by an option, one still empty: still disabled, "1 of 2"', () => {
        const html = form({ selections: [['4'], []], notes: ['', ''] });
        expect(submitTag(html)).toContain('disabled=""');
        expect(html).toMatch(/data-question-remaining="1"[^>]*>1 of 2 still needs an option or a note</);
        // The chosen option shows as chosen.
        // The option tag found by its label, then required to be pressed — and the other option of that question not.
        const options = html.match(/<button[^>]*data-question-option="[^"]*"[^>]*>/g) ?? [];
        const four = options.filter((t) => t.includes('data-question-option="4"'));
        expect(four).toHaveLength(1);
        expect(four[0]).toContain('aria-pressed="true"');
        expect(options.filter((t) => t.includes('data-question-option="8"') && t.includes('aria-pressed="true"'))).toHaveLength(0);
    });

    it('a NOTE alone answers its question: every question answered → Answer ENABLED and the count line is gone', () => {
        const html = form({ selections: [['4'], []], notes: ['', 'only the fast ones'] });
        expect(submitTag(html)).not.toContain('disabled=""');
        expect(html).not.toContain('data-question-remaining');
        expect(html).toContain('only the fast ones');
    });

    it('a blank note is no note — the control for the case above', () => {
        const html = form({ selections: [['4'], []], notes: ['', '   '] });
        expect(submitTag(html)).toContain('disabled=""');
        expect(html).toContain('data-question-remaining="1"');
    });

    it('a refusal is said BESIDE the buttons (role="alert"), once, and nothing is said without one', () => {
        const html = form({ selections: [['4'], ['unit']], notes: ['', ''] }, 'that question was already answered');
        expect((html.match(/role="alert"/g) ?? []).length).toBe(1);
        expect(html).toMatch(/data-action="deck-submit"[^]*data-action="question-cancel"[^]*role="alert"[^>]*>that question was already answered</);
        expect(form({ selections: [['4'], ['unit']], notes: ['', ''] })).not.toContain('role="alert"');
    });
});
