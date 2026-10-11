import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Deck } from '../src/renderer/components/Deck.js';
import { signalStrip, type SignalState } from '../src/core/deck.js';

/**
 * THE DRAIN ROSTER ON THE DECK (§7.5). While Genie waits for agents to write their handoffs, the
 * update signal says who it is waiting for, the roster lists each agent with its state — a quiet
 * agent AMBER, not mistaken for a slow one — and Cancel is always there and always abandons.
 */

const base: SignalState = { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false };
const draining: SignalState = {
    ...base,
    update: {
        phase: 'draining', version: '2.0.0-beta.5', percent: 100,
        drain: { startedAt: 1_000, entries: [
            { agentId: 'agent_a', name: 'atlas', state: 'answered', askedAt: 1_000, answeredAt: 1_500 },
            { agentId: 'agent_b', name: 'bolt', state: 'quiet', askedAt: 1_000, answeredAt: null },
            { agentId: 'agent_c', name: 'cass', state: 'asked', askedAt: 1_000, answeredAt: null },
        ] },
    },
};
const render = (signals: SignalState, actions: string[] = []) =>
    renderToStaticMarkup(<Deck items={[]} signals={signals} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} onSignalAction={(a) => { actions.push(a); }} />);

describe('draining', () => {
    it('the strip names the wait and the quiet count; the door is Cancel', () => {
        const strip = signalStrip(draining);
        expect(strip.find((s) => s.kind === 'update')).toMatchObject({ label: 'Upgrading to Genie 2.0.0-beta.5: waiting for 2 of 3 agents (1 quiet)', action: 'update-cancel' });
    });

    it('the roster lists each agent with its state; quiet is amber; Cancel is offered', () => {
        const html = render(draining);
        expect(html).toContain('data-drain-roster');
        expect(html).toContain('data-drain-agent="agent_a" data-drain-state="answered"');
        expect(html).toContain('data-drain-agent="agent_b" data-drain-state="quiet"');
        expect(html).toContain('data-drain-agent="agent_c" data-drain-state="asked"');
        expect(html).toMatch(/bolt/);
        expect(html).toMatch(/quiet/);
        expect(html).toContain('data-action="update-cancel"');
    });

    it('no roster when not draining', () => {
        expect(render({ ...base, update: { phase: 'downloaded', version: '2.0.0-beta.5', percent: 100, drain: null } })).not.toContain('data-drain-roster');
        expect(render(base)).not.toContain('data-drain-roster');
    });
});
