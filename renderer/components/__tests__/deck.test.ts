import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentSession } from '../../../main/agentsession/model';
import { Deck } from '../Master/Deck';

/**
 * Rendered assertions through `react-dom/server` — the lane `vitest.config.mts`
 * opened for exactly this ("Renderer components ARE tested here now ... since the env
 * has no DOM"), and `React.createElement` rather than JSX because the suite's include
 * globs only collect `*.test.ts`.
 *
 * It matters for this component because its most important behaviours are things it
 * must NOT draw, and an absence is invisible to every other kind of check. Every such
 * assertion here is paired with a POSITIVE CONTROL, because "no $0.00 in the markup"
 * would otherwise also pass for a component that never renders cost at all.
 */

const session = (over: Partial<AgentSession> = {}): AgentSession => ({
    agentId: 'a1',
    specId: 's1',
    session: { provider: 'claude', name: 'kai', cwd: '/w', workspaceId: 'w1', sessionId: null },
    turn: { state: 'idle', since: 1_000 },
    composer: null,
    transcript: [],
    live: null,
    tools: [],
    approvals: [],
    plan: null,
    usage: null,
    commands: null,
    error: null,
    ...over,
});

const NOW = 10_000_000;
const render = (sessions: AgentSession[]): string =>
    renderToStaticMarkup(React.createElement(Deck, { sessions, now: NOW }));

describe('what the Deck draws', () => {
    it('names each agent and its state', () => {
        const html = render([session({ turn: { state: 'awaiting-input', since: NOW - 120_000 } })]);
        expect(html).toContain('kai');
        expect(html).toContain('awaiting you');
    });

    it('says what to do next when there are no agents', () => {
        const html = render([]);
        expect(html).toContain('No agents registered yet');
        expect(html).toContain('Add one from a workspace');
    });

    it('renders the heading, which would be SILENT with the wrong prop', () => {
        // Heading takes `as`, not `level`. Passing `level` type-checks — the component
        // spreads HTMLAttributes — and draws no heading at all. That is genie#320
        // (`<Modal title=...>` swallowed, no header rendered), so this asserts the
        // ELEMENT rather than trusting the prop name.
        expect(render([session()])).toMatch(/<h3[^>]*>Agents<\/h3>/);
    });
});

describe('what the Deck REFUSES to draw', () => {
    it('shows NO dash and NO zero for a cost it cannot see', () => {
        const html = render([session()]);
        expect(html).not.toContain('$0.00');
        expect(html).not.toContain('—');
        expect(html).not.toContain('&#x2014;');
    });

    it('POSITIVE CONTROL: shows a real zero when the session reports one', () => {
        const html = render([session({ usage: { contextUsed: 0, contextMax: 200_000, costUsd: 0 } })]);
        expect(html).toContain('$0.00');
    });

    it('draws no context figure for a session that cannot report one', () => {
        expect(render([session()])).not.toContain('k/');
    });

    it('POSITIVE CONTROL: draws the context figure when it can', () => {
        const html = render([
            session({ usage: { contextUsed: 38_000, contextMax: 200_000, costUsd: null } }),
        ]);
        expect(html).toContain('38k/200k');
    });

    it('suppresses the band totals entirely when nothing can report them', () => {
        const html = render([session()]);
        expect(html).toContain('live');
        // Matched against the FIGURE, not the bare word: an earlier version asserted
        // `not.toContain('ctx')` and failed on this component's own `deck-row-ctx`
        // class name — a loose assertion catching its own markup rather than the
        // behaviour it names.
        expect(html).not.toMatch(/\d+k ctx/);
        expect(html).not.toMatch(/\$\d/);
    });

    it('POSITIVE CONTROL: shows the band totals when something can', () => {
        const html = render([
            session({ usage: { contextUsed: 12_000, contextMax: 200_000, costUsd: 0.5 } }),
        ]);
        expect(html).toContain('12k ctx');
    });
});

describe('honest fidelity', () => {
    it('labels an Observed agent terminal-only rather than disabling anything', () => {
        expect(render([session()])).toContain('terminal only');
    });

    it('does not label a Declared agent at all', () => {
        const html = render([session({ composer: { text: '', cursor: 0, busy: false } })]);
        expect(html).not.toContain('terminal only');
    });

    it('says so when the provider cannot be resolved, because the repair is the point', () => {
        const html = render([session({ session: { ...session().session, provider: null } })]);
        expect(html).toContain('provider unknown');
    });
});

describe('the state the product could not see before', () => {
    it('calls a mid-turn agent that has not moved "not moving"', () => {
        const html = render([session({ turn: { state: 'thinking', since: NOW - 10 * 60_000 } })]);
        expect(html).toContain('not moving');
    });

    it('still calls a recently-active one working', () => {
        const html = render([session({ turn: { state: 'thinking', since: NOW - 30_000 } })]);
        expect(html).toContain('working');
        expect(html).not.toContain('not moving');
    });

    it('surfaces an error instead of showing the agent as merely idle', () => {
        expect(render([session({ error: 'pty-exited' })])).toContain('pty-exited');
    });
});
