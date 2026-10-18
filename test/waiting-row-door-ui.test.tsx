import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { Shell } from '../src/renderer/Shell.js';
import { EMPTY_SNAPSHOT, type GenieSnapshot } from '../src/renderer/bridge.js';
import { Deck } from '../src/renderer/components/Deck.js';

/**
 * THE DECK OPENS ON THE NAMED ITEM: `genie://deck?item=<id>` marks that item as the focus (the row the reader was
 * sent to) and is scrolled to. Its form is open — as every agent question's is now (the body IS the form, 2026-10-15).
 */
const QUIET = { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false };
const inline: DeckItem = {
    id: 'approval:kai', source: 'agent-question', agentId: 'kai', agentName: 'kai', workspaceId: 'tynn',
    title: 'Allow php artisan migrate --force?', blocking: true, priority: 'normal', at: 1,
    answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }] }, forwardedFrom: null,
};
const form: DeckItem = {
    ...inline, id: 'q_7', agentId: 'wren', agentName: 'wren', title: 'Workers + 1 more', at: 2,
    answer: { kind: 'form', fields: 2, questions: [{ header: 'Workers', question: 'How many?', options: [{ label: '4' }, { label: '8' }] }, { header: 'Scope', question: 'Which?', options: [{ label: 'unit' }, { label: 'e2e' }], multiSelect: true }] },
};

describe('the Deck with a named item', () => {
    it('marks it as the focus; its form is there; the others are untouched', () => {
        const html = renderToStaticMarkup(<Deck items={[inline, form]} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} focusId="q_7" />);
        expect(html).toMatch(/data-deck-item="q_7"[^>]*data-deck-focus="true"/);
        expect(html).toContain('data-deck-form="q_7"');
        expect(html).not.toMatch(/data-deck-item="approval:kai"[^>]*data-deck-focus/);
    });

    it('no item named → nothing focused; the question is still read in its form (no door to open first)', () => {
        const html = renderToStaticMarkup(<Deck items={[inline, form]} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} />);
        expect(html).not.toContain('data-deck-focus');
        // COUNTED: one form, the question's — the approval is answered by its card, not a form.
        expect(html.match(/data-deck-form="/g) ?? []).toHaveLength(1);
        expect(html).toContain('data-deck-form="q_7"');
    });
});

describe('the Shell on the deck route', () => {
    const snapshot: GenieSnapshot = { ...EMPTY_SNAPSHOT, workspaces: [{ id: 'tynn', path: 'C:/_Projects/tynn.ai', agentsKnown: true }], deckItems: [inline, form], workstation: { name: 'alphar', healthy: true } };
    const render = (route: string) =>
        renderToStaticMarkup(
            <Shell route={route} snapshot={snapshot} servable={['dashboard', 'deck', 'agent', 'workspace']} agentDetail={null} agentResolved={false} selectedRowId={null} chatThread={null} pinned={null}
                onNavigate={() => {}} onOpenAgent={() => {}} onAddAgent={() => {}} onAddWorkspace={() => {}} onOpenPalette={() => {}} onSelectRow={() => {}} onSend={() => {}} onCloseChat={() => {}} answeringApproval={null} onAnswerApproval={() => {}} onAnswerDeckItem={() => {}} />,
        );

    it('passes the named item through: focused on the Deck, the route shown in the title bar', () => {
        const html = render('genie://deck?item=approval:kai');
        expect(html).toMatch(/data-deck-item="approval:kai"[^>]*data-deck-focus="true"/);
        expect(html).toContain('genie://deck?item=approval:kai');
    });
});
