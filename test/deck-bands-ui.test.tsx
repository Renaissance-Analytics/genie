import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { DeckOnDashboard } from './helpers/deck-on-dashboard.js';

/**
 * THE DECK ON SCREEN: `Needs you` with its count in the header, and nothing below it for handoffs. A finished agent's
 * handoff is for agents (Tynn #658, the owner: "Handoffs are for agents, not humans. I should not have to mark them as
 * read."), so the Deck has no "Since you looked" band and no `mark read` door; the person sees the agent's state and chat.
 */
const QUIET = { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false };
const question: DeckItem = {
    id: 'q_1', source: 'agent-question', agentId: 'kai', agentName: 'kai', workspaceId: 'tynn', title: 'Which engine?',
    blocking: true, priority: 'normal', at: 10, answer: { kind: 'inline', options: [{ id: 'a', label: 'a', tone: 'neutral' }] }, forwardedFrom: null,
};
const render = (items: DeckItem[]) =>
    renderToStaticMarkup(<DeckOnDashboard items={items} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} />);

describe('what waits on the Dashboard (Tynn #730: the Deck is not a page)', () => {
    it('a question on its agent, counted in the chip; no band of handoffs to read, no mark read', () => {
        const html = render([question]);
        expect(html).toMatch(/data-dashboard-filter="needsYou"[^>]*>[\s\S]*?Needs you 1/);
        expect(html).toMatch(/data-waiting-items="kai"[\s\S]*?data-deck-item="q_1"/);
        expect(html).not.toContain('data-deck-band="since-you-looked"');
        expect(html).not.toContain('Since you looked');
        expect(html).not.toContain('>mark read<');
    });

    it('nothing waiting: no badges, no items, and the chip says 0', () => {
        const html = render([]);
        expect(html).toContain('Needs you 0');
        expect(html).not.toContain('data-waiting-badge');
        expect(html).not.toContain('data-waiting-items');
    });
});
