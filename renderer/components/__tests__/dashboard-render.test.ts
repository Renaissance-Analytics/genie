import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Dashboard } from '../Master/Dashboard';
import type { AgentSession } from '../../../main/agentsession/model';

/**
 * THE DASHBOARD IS A PLACE YOU CAN LEAVE.
 *
 * This file exists because of a shipped defect, not a hypothetical. `v2.0.0-beta.1` made the
 * Deck the default surface; the owner launched it and could not reach a single agent:
 *
 *   "I am fucking stuck on this damn screen. Nothing is clicklable."
 *
 * The cause was that the surface rendered rows and nothing else — `RosterLine` was a bare
 * `<div>`, and `Dashboard` was mounted `<Dashboard sessions workspaces />` with no handler
 * props at all. Both read correctly in review and in a screenshot. Neither could be used.
 *
 * A typecheck cannot catch this, because "no handler" is not a type error — it is a missing
 * prop that nobody passed. `dashboard-view.test.ts` cannot catch it either: the projection
 * was right the whole time. The defect lives exactly in the gap between a correct model and
 * a rendered surface, which is why it is asserted against the MARKUP.
 *
 * The rule: a surface that can hold the default must offer a mouse path to its subject.
 */

const NOW = 1_000_000;

const session = (over: Partial<AgentSession> = {}): AgentSession => ({
    agentId: 'a1',
    specId: 's1',
    session: { provider: 'claude', name: 'kai', cwd: 'repos/genie', workspaceId: 'w1', sessionId: 'sess' },
    turn: { state: 'idle', since: NOW },
    thoughts: [],
    liveThought: null,
    rateLimit: null,
    rateLimitUnavailable: null,
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

const WORKSPACES = [{ id: 'w1', name: 'Genie', path: 'repos/genie' }];

/**
 * Rendered WITH a handler, which is the state the app mounts it in.
 *
 * The component is deliberately inert without one — a row with nothing behind it stays a
 * `<div>` rather than becoming a control that does nothing. That rule is what makes these
 * assertions meaningful, and it is why this file alone cannot catch the original defect:
 * beta.1's `Dashboard` declared no handler prop at all, so there was nothing to leave out.
 * `surface-handlers-wired.test.ts` closes that half by failing when `master.tsx` declines to
 * pass what the component declares.
 */
const render = (sessions: AgentSession[]): string =>
    renderToStaticMarkup(
        React.createElement(Dashboard, {
            sessions,
            workspaces: WORKSPACES,
            now: NOW,
            onOpenAgent: () => {},
        }),
    );

/** The same board with NOTHING wired — the contrast the idiom promises. */
const renderUnwired = (sessions: AgentSession[]): string =>
    renderToStaticMarkup(React.createElement(Dashboard, { sessions, workspaces: WORKSPACES, now: NOW }));

describe('the Dashboard renders its agents', () => {
    it('POSITIVE CONTROL: the agent reaches the markup at all', () => {
        // Without this, every assertion below would also pass against a component that threw
        // its rows away — "no inert divs" is trivially true of an empty screen.
        const html = render([session()]);
        expect(html).toContain('kai');
        expect(html).toContain('dash-row');
    });
});

describe('every agent row is reachable with a mouse', () => {
    it('renders a BUTTON per agent, not an inert div', () => {
        const html = render([
            session({ agentId: 'a1', session: { ...session().session, name: 'kai' } }),
            session({ agentId: 'a2', session: { ...session().session, name: 'vale' } }),
        ]);

        // Two agents, two activation targets. A count, not a boolean: "contains a button"
        // would pass on a surface where only the first row is clickable, which is a worse
        // failure than none being clickable because it looks like it works.
        const buttons = html.match(/<button/g) ?? [];
        expect(buttons.length).toBeGreaterThanOrEqual(2);
    });

    it('names the AGENT on its own activation target', () => {
        // The handler must not be able to open the wrong agent. Carrying the id on the
        // element is what makes a mis-wired row a visible defect rather than a silent one.
        const html = render([
            session({ agentId: 'a1', session: { ...session().session, name: 'kai' } }),
            session({ agentId: 'a2', session: { ...session().session, name: 'vale' } }),
        ]);

        expect(html).toContain('data-agent="a1"');
        expect(html).toContain('data-agent="a2"');
    });

    it('stays an inert div when nothing is wired, rather than faking a control', () => {
        // The other half of the idiom, asserted rather than assumed. A surface that renders
        // buttons with no handler is worse than one that renders none: it looks like it
        // works. This is also the contrast that proves the button assertions above are
        // measuring the handler and not some unrelated markup.
        const html = renderUnwired([session()]);
        expect(html).toContain('kai');
        expect(html).not.toContain('<button');
    });

    it('offers the row even when the agent is one Genie can only WATCH', () => {
        // An Observed agent has no declared transcript, which is a reason for its row to be
        // thinner -- never a reason for it to be unreachable. The Agent view still has its
        // Terminal, Activity, Files and Changes tabs for exactly this case.
        const observed = session({ composer: null, agentId: 'a9' });
        const html = render([observed]);
        expect(html).toContain('data-agent="a9"');
        expect((html.match(/<button/g) ?? []).length).toBeGreaterThanOrEqual(1);
    });
});
