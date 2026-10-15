import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem, SignalState } from '../src/core/deck.js';
import { Deck } from '../src/renderer/components/Deck.js';
import { QuestionForm, type QuestionDraft } from '../src/renderer/components/QuestionForm.js';

/**
 * THE FORM IN PLACE (§4.5): "Answer N questions" expands the item into a form where it is read — one fieldset per
 * question with its header chip, radios for a single-select and checkboxes for a multi-select, ONE NOTE PER QUESTION
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
const item: DeckItem = { id: 'q_1', source: 'agent-question', agentId: 'a1', agentName: 'lark', workspaceId: 'moic', title: 'How many workers? (+1 more)', blocking: true, priority: 'normal', at: 1, answer: { kind: 'form', fields: 2, questions }, forwardedFrom: null };
const render = (expanded: string | null) =>
    renderToStaticMarkup(<Deck items={[item]} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} expanded={expanded} onAnswerForm={() => {}} />);
const form = (initial?: QuestionDraft, refusal: string | null = null) =>
    renderToStaticMarkup(<QuestionForm item={item} answering={null} refusal={refusal} onSubmit={() => {}} onCancel={() => {}} {...(initial ? { initial } : {})} />);
const submitTag = (html: string) => html.match(/<button[^>]*data-action="deck-submit"[^>]*>/)?.[0] ?? '';

describe('the in-place form', () => {
    it('collapsed: the "Answer 2 questions" door and no form', () => {
        const html = render(null);
        expect(html).toContain('data-deck-expand="q_1"');
        expect(html).not.toContain('data-deck-form');
    });

    it('expanded: a fieldset per question with the header chip, radios or checkboxes by multiSelect, a note per question, one Answer button — and no navigation', () => {
        const html = render('q_1');
        expect(html).toContain('data-deck-form="q_1"');
        expect((html.match(/data-deck-question="/g) ?? []).length).toBe(2);
        expect(html).toMatch(/data-deck-question="0"[^]*?type="radio"/);
        expect(html).toMatch(/data-deck-question="1"[^]*?type="checkbox"/);
        expect(html).toContain('Workers');
        expect(html).toContain('Scope');
        // COUNTED: one note per question, not one for the form.
        expect((html.match(/data-deck-note="q_1"/g) ?? []).length).toBe(2);
        expect((html.match(/<button[^>]*data-action="deck-submit"[^>]*>Answer</g) ?? []).length).toBe(1);
        expect(html).not.toContain('data-nav=');
        // The door is gone while the form is open — one rendering of one decision.
        expect(html).not.toContain('data-deck-expand="q_1"');
    });

    it('an item that did not carry its questions draws no form even when asked to expand — the door stays, and it opens the agent', () => {
        const bare: DeckItem = { ...item, answer: { kind: 'form', fields: 2 } };
        const html = renderToStaticMarkup(<Deck items={[bare]} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} expanded="q_1" onAnswerForm={() => {}} />);
        expect(html).not.toContain('data-deck-form');
        expect(html).toContain('data-deck-expand="q_1"');
    });

    it('a refused answer is said beside THAT item’s Answer button in the Deck — not only in the console', () => {
        const refused = renderToStaticMarkup(<Deck items={[item]} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} expanded="q_1" onAnswerForm={() => {}} formRefusal={{ itemId: 'q_1', reason: 'Scope needs an option or a note' }} />);
        expect(refused).toMatch(/data-action="deck-submit"[^]*role="alert"[^>]*>Scope needs an option or a note</);
        // Control: a refusal about another item is not said on this one.
        const other = renderToStaticMarkup(<Deck items={[item]} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} expanded="q_1" onAnswerForm={() => {}} formRefusal={{ itemId: 'q_9', reason: 'elsewhere' }} />);
        expect(other).not.toContain('elsewhere');
    });
});

describe('the form says what is left and only lets a ready answer through', () => {
    it('one note textarea per question, each right under its own options, with the placeholder that says when it is optional', () => {
        const html = form();
        expect((html.match(/<textarea[^>]*data-deck-note="q_1"/g) ?? []).length).toBe(2);
        // Inside each question's fieldset, after its options.
        expect(html).toMatch(/data-deck-question="0"(?:(?!<\/fieldset>)[^])*type="radio"(?:(?!<\/fieldset>)[^])*data-question-note="0"/);
        expect(html).toMatch(/data-deck-question="1"(?:(?!<\/fieldset>)[^])*type="checkbox"(?:(?!<\/fieldset>)[^])*data-question-note="1"/);
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
        // Attribute order is the renderer's (React writes `checked` and `value` last, in its own order): find the radio by
        // its value, then require it to be checked — and the other radio of that question not.
        const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
        const four = radios.filter((t) => t.includes('value="4"'));
        expect(four).toHaveLength(1);
        expect(four[0]).toContain('checked=""');
        expect(radios.filter((t) => t.includes('value="8"') && t.includes('checked=""'))).toHaveLength(0);
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
