import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Deck } from '../src/renderer/components/Deck.js';
import type { DeckItem, SignalState } from '../src/core/deck.js';

/**
 * THE DECK, RENDERED.
 *
 * The acceptance test is *"you can clear the entire band without navigating once"*, and these
 * assert the markup half of it: every item carries its answer, and the one item that cannot be
 * answered here says where it belongs instead of offering a button that lies.
 */

const QUIET: SignalState = {
    flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false,
};

const item = (over: Partial<DeckItem> = {}): DeckItem => ({
    id: 'i1',
    source: 'agent-question',
    agentId: 'kai',
    agentName: 'kai',
    workspaceId: 'tynn',
    title: 'Allow php artisan migrate --force?',
    blocking: true,
    priority: 'normal',
    at: 1_760_000_000_000,
    answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }] },
    forwardedFrom: null,
    ...over,
});

function render(over: Partial<Parameters<typeof Deck>[0]> = {}): string {
    return renderToStaticMarkup(
        <Deck
            items={[item()]}
            signals={QUIET}
            answering={null}
            onAnswer={() => {}}
            onOpenItem={() => {}}
            onNavigate={() => {}}
            {...over}
        />,
    );
}

describe('clearing the band without navigating', () => {
    it('puts the answer ON the item', () => {
        const html = render();
        expect(html).toContain('data-deck-item="i1"');
        expect(html).toContain('data-approval-option="allow"');
    });

    it('offers an in-place expansion for a multi-part question, not a navigation', () => {
        const html = render({ items: [item({ answer: { kind: 'form', fields: 3 } })] });

        expect(html).toContain('data-deck-expand="i1"');
        expect(html).toContain('Answer 3 questions');
        // No inline buttons, because inline is not the whole answer here.
        expect(html).not.toContain('data-approval-option');
    });

    it('shows a FORWARDED question without a button that would lie', () => {
        /**
         * Answering the local copy marks it done while the real question waits forever — an
         * agent blocked on a decision somebody believes they already made. So it is visible,
         * named, and not answerable.
         */
        const html = render({ items: [item({ forwardedFrom: 'alphar' })] });

        expect(html).toContain('data-deck-elsewhere="alphar"');
        expect(html).toContain('answered there');
        expect(html).not.toContain('data-approval-option');

        // POSITIVE CONTROL: it is still on the band. Hiding it would leave the agent blocked
        // with the only clue removed from the surface whose job is showing what needs a human.
        expect(html).toContain('data-deck-item="i1"');
    });

    it('renders the band in RANK order, blocking first', () => {
        const html = render({
            items: [
                item({ id: 'urgent-idle', blocking: false, priority: 'urgent' }),
                item({ id: 'blocked', blocking: true, priority: 'low' }),
            ],
        });

        const order = [...html.matchAll(/data-deck-item="([^"]+)"/g)].map((m) => m[1]);
        expect(order).toEqual(['blocked', 'urgent-idle']);
    });

    it('marks a blocking item so it reads as stopped rather than merely urgent', () => {
        expect(render()).toContain('data-blocking-dot');
        expect(render({ items: [item({ blocking: false })] })).not.toContain('data-blocking-dot');
    });
});

describe('the signal strip', () => {
    it('is ABSENT when nothing is true', () => {
        // Not an empty strip — absent. A strip reading "0 waiting · no flows · GitHub fine" is
        // furniture that teaches people to stop reading it.
        expect(render()).not.toContain('data-signal-strip');
    });

    it('appears with a door per signal when something IS true', () => {
        const html = render({
            signals: { flowsRunning: 2, uncollectedMail: 0, githubBlocked: true, osAgentWorking: false },
        });

        expect(html).toContain('data-signal-strip');
        expect(html).toContain('data-signal="flows"');
        expect(html).toContain('data-signal="github"');
        expect(html).not.toContain('data-signal="mail"');

        // Every signal carries its route, so it is a door rather than an announcement.
        expect(html).toMatch(/data-signal="flows"[^>]*data-nav="genie:\/\/flows"/);
    });
});

describe('an empty Deck', () => {
    it('says so, which is a claim this surface IS entitled to make', () => {
        /**
         * Unlike the Dashboard's first run, where "no workspaces" before the bridge answers
         * would be a claim about a machine nobody had looked at. Here the band is the whole
         * subject and an empty band is the answer to the question the surface asks.
         */
        const html = render({ items: [] });

        expect(html).toContain('data-deck="empty"');
        expect(html).toContain('Nothing needs you');
        // And no count in the header: the Deck being empty is said in words, not with a zero.
        expect(html).not.toContain('data-deck-count');
    });

    it('counts in the header when there IS something', () => {
        expect(render()).toContain('data-deck-count="1"');
    });
});
