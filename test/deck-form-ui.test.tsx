import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem, SignalState } from '../src/core/deck.js';
import { Deck } from '../src/renderer/components/Deck.js';

/**
 * THE FORM IN PLACE (§4.5): "Answer N questions" expands the item into a form where it is read — one fieldset per
 * question with its header chip, radios for a single-select and checkboxes for a multi-select, the free-text note the
 * protocol always allows, and one Answer button. No modal, no navigation: the acceptance test for the Deck is clearing
 * the whole band without navigating once.
 */
const QUIET: SignalState = { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false } as SignalState;
const questions = [
    { header: 'Workers', question: 'How many workers?', options: [{ label: '4' }, { label: '8' }] },
    { header: 'Scope', question: 'Which suites?', options: [{ label: 'unit' }, { label: 'e2e' }], multiSelect: true },
];
const item: DeckItem = { id: 'q_1', source: 'agent-question', agentId: 'a1', agentName: 'lark', workspaceId: 'moic', title: 'How many workers? (+1 more)', blocking: true, priority: 'normal', at: 1, answer: { kind: 'form', fields: 2, questions }, forwardedFrom: null };
const render = (expanded: string | null) =>
    renderToStaticMarkup(<Deck items={[item]} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} expanded={expanded} onAnswerForm={() => {}} />);

describe('the in-place form', () => {
    it('collapsed: the "Answer 2 questions" door and no form', () => {
        const html = render(null);
        expect(html).toContain('data-deck-expand="q_1"');
        expect(html).not.toContain('data-deck-form');
    });

    it('expanded: a fieldset per question with the header chip, radios or checkboxes by multiSelect, the note, one Answer button — and no navigation', () => {
        const html = render('q_1');
        expect(html).toContain('data-deck-form="q_1"');
        expect((html.match(/data-deck-question="/g) ?? []).length).toBe(2);
        expect(html).toMatch(/data-deck-question="0"[^]*?type="radio"/);
        expect(html).toMatch(/data-deck-question="1"[^]*?type="checkbox"/);
        expect(html).toContain('Workers');
        expect(html).toContain('Scope');
        expect(html).toContain('data-deck-note="q_1"');
        expect(html).toMatch(/<button[^>]*data-action="deck-submit"[^>]*>Answer</);
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
});
