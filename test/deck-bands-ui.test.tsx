import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { Deck } from '../src/renderer/components/Deck.js';

/**
 * THE DECK'S TWO BANDS ON SCREEN: `Needs you` with its count in the header; below it `Since you looked`, each finished
 * agent with its handoff note and the three doors. The count never includes a finished agent; "Nothing needs you"
 * is said when the first band is empty even while the second has something to read.
 */
const QUIET = { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false };
const question: DeckItem = {
    id: 'q_1', source: 'agent-question', agentId: 'kai', agentName: 'kai', workspaceId: 'tynn', title: 'Which engine?',
    blocking: true, priority: 'normal', at: 10, answer: { kind: 'inline', options: [{ id: 'a', label: 'a', tone: 'neutral' }] }, forwardedFrom: null,
};
const finished: DeckItem = {
    ...question, id: 'fin_1', source: 'finished-handoff', agentId: 'atlas', agentName: 'atlas', title: 'atlas finished: PR #15 is up; the front door is next.', blocking: false, at: 5,
    answer: { kind: 'inline', options: [{ id: 'open', label: 'Open', tone: 'neutral' }, { id: 'restart', label: 'Restart with this', tone: 'neutral' }, { id: 'seen', label: 'mark read', tone: 'neutral' }] },
};
const render = (items: DeckItem[]) =>
    renderToStaticMarkup(<Deck items={items} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} />);

describe('the two bands', () => {
    it('a question in Needs you (counted), a finished agent in Since you looked with its note and three doors', () => {
        const html = render([question, finished]);
        expect(html).toContain('data-deck-count="1"');
        expect(html).toMatch(/data-deck-band="needs-you"[\s\S]*?data-deck-item="q_1"/);
        expect(html).toMatch(/data-deck-band="since-you-looked"[\s\S]*?data-deck-item="fin_1"/);
        expect(html).toContain('>Since you looked<');
        expect(html).toContain('PR #15 is up; the front door is next.');
        for (const label of ['Open', 'Restart with this', 'mark read']) expect(html).toContain(`>${label}<`);
        // The finished agent is NOT in the first band.
        expect(html).not.toMatch(/data-deck-band="needs-you"[\s\S]*?data-deck-item="fin_1"[\s\S]*?data-deck-band="since-you-looked"/);
    });

    it('nothing waiting but something finished: the first band says so, the second still reads; no count', () => {
        const html = render([finished]);
        expect(html).toContain('Nothing needs you');
        expect(html).not.toContain('data-deck-count');
        expect(html).toContain('data-deck-band="since-you-looked"');
    });

    it('no finished agents → no second band at all', () => {
        expect(render([question])).not.toContain('data-deck-band="since-you-looked"');
    });
});
