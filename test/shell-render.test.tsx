import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Shell } from '../src/renderer/Shell.js';
import { EMPTY_SNAPSHOT, type GenieSnapshot } from '../src/renderer/bridge.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { AgentDetail } from '../src/renderer/bridge.js';

/**
 * THE WHOLE SURFACE AT ONCE — chrome, rail and Dashboard in one render.
 *
 * ## Why this file exists separately from the component tests
 *
 * Because the component tests pass with the pieces wired to nothing. §0.4 is a Conversation UI
 * that was BUILT, shipped, and unreachable: one condition hid a finished feature, and every
 * test of that feature was green. The composed render is the cheapest thing that would have
 * caught it — not proof the app works, but proof the parts are connected to each other.
 *
 * It still only reads markup. It does not prove the window opens, the layout holds at any
 * width, or that a click navigates; §8.1's smoke path on a VM owns those.
 */

function row(over: Partial<AgentRow> = {}): AgentRow {
    return {
        id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'tynn',
        fidelity: 'declared', state: 'working', duration: '12m',
        ask: null, reason: null, fixes: [], step: '4/7', target: 'Passkey enrolment endpoint',
        activity: null, delivery: null, collaborators: 4, commsAgeSeconds: 8,
        contextUsed: null, contextSize: 200_000,
        ...over,
    };
}

const LIVE: GenieSnapshot = {
    agents: [
        row({ id: 'kai', name: 'kai', state: 'waiting', ask: 'Allow php artisan migrate --force?' }),
        row({ id: 'wren', name: 'wren', workspaceId: 'fancy', contextUsed: 182_000 }),
    ],
    workspaces: [
        { id: 'tynn', path: 'C:/_Projects/tynn.ai', agentsKnown: true },
        { id: 'fancy', path: 'C:/_Projects/fancy', agentsKnown: true },
    ],
    deckCount: 1,
    workstation: { name: 'alphar', healthy: true },
};

function render(over: Partial<Parameters<typeof Shell>[0]> = {}): string {
    return renderToStaticMarkup(
        <Shell
            route="genie://dashboard?group=workspace"
            snapshot={LIVE}
            servable={['dashboard', 'deck', 'agent', 'workspace']}
            agentDetail={null}
            agentResolved={false}
            selectedRowId={null}
            onNavigate={() => {}}
            onOpenAgent={() => {}}
            onAddAgent={() => {}}
            onOpenPalette={() => {}}
            onSelectRow={() => {}}
            {...over}
        />,
    );
}

describe('the default route lands on a populated Dashboard', () => {
    it('renders the bar, the rail and real agent rows together', () => {
        const html = render();

        expect(html).toContain('data-surface="dashboard"');
        expect(html).toContain('data-agent="kai"');
        expect(html).toContain('data-agent="wren"');

        // The chrome is there and it is reading from the same snapshot.
        expect(html).toContain('alphar');
        expect(html).toContain('data-deck-badge="1"');
        expect(html).toContain('data-workspace="tynn"');
    });

    it('needs no keyboard shortcut to reach \u2014 the Dashboard IS the default route', () => {
        /**
         * The owner's acceptance bar: a person with no instructions reaches the Dashboard and
         * opens an agent inside thirty seconds, and **if that needs a shortcut it fails.**
         *
         * What a markup test can honestly assert is the two halves of that: the default route
         * already renders the board, and the way to an agent is a clickable row rather than a
         * key. Whether a human manages it in thirty seconds is a question for a person on a VM.
         */
        const html = render({ route: 'genie://dashboard?group=workspace' });

        expect(html).toContain('data-surface="dashboard"');
        // A row a pointer can hit, and a labelled route home in the bar.
        expect(html).toMatch(/data-agent="kai"[^>]*role="row"|role="row"[^>]*data-agent="kai"/);
        expect(html).toContain('data-nav="genie://dashboard"');
    });

    it('shows the route in the bar and the matching surface in the body', () => {
        // One copy of "where am I". The failure this guards is a rail highlighting one surface
        // while the body shows another, which is unfixable once two places track it.
        const html = render({ route: 'genie://dashboard?group=status' });

        expect(html).toContain('genie://dashboard?group=status');
        expect(html).toMatch(/data-nav="genie:\/\/dashboard"[^>]*data-active="true"/);
    });
});

describe('a surface this build cannot serve', () => {
    it('renders an empty body rather than a frame pretending to be a surface', () => {
        // `App` redirects it; the Shell's job is to not invent a screen. Asserted because the
        // alternative — a header over nothing — reads as a load that failed.
        const html = render({ route: 'genie://deck', servable: ['dashboard'] });

        expect(html).not.toContain('data-surface="dashboard"');
        expect(html).not.toContain('data-agent=');
        // POSITIVE CONTROL: the chrome is still rendered, so this is not an empty document.
        expect(html).toContain('data-route');
        expect(html).toContain('alphar');
    });
});

describe('first paint, before the bridge has answered', () => {
    it('claims NOTHING \u2014 no agents, no zeros, no fault light', () => {
        /**
         * The single most dangerous render in the application, because it is the one that
         * happens before any data exists and the one nobody looks at twice.
         *
         * *"No agents"* and *"we have not heard yet"* are different claims. The empty snapshot
         * must make the second one, which means **no counts, no zero badge, and no workstation
         * dot** — a red dot here would assert the machine is unwell before anything checked.
         */
        const html = renderToStaticMarkup(
            <Shell
                route="genie://dashboard?group=workspace"
                snapshot={EMPTY_SNAPSHOT}
                servable={['dashboard']}
                agentDetail={null}
                agentResolved={false}
                selectedRowId={null}
                onNavigate={() => {}}
                onOpenAgent={() => {}}
                onAddAgent={() => {}}
                onOpenPalette={() => {}}
                onSelectRow={() => {}}
            />,
        );

        expect(html).not.toContain('data-agent=');
        expect(html).not.toContain('data-deck-badge');
        expect(html).not.toContain('data-workstation-health');
        expect([...html.matchAll(/>\s*0\s*</g)]).toEqual([]);

        // POSITIVE CONTROL: it is a real window, not a blank one — the chrome and the column
        // headers are there, so the test is not passing on an empty render.
        expect(html).toContain('data-route');
        expect(html).toContain('Dashboard');
        expect(html).toContain('Current target');

        // And the SAME component with a real snapshot does show all three, which is what makes
        // the absences above mean something.
        // Full availability, because the Deck badge needs the Deck row to live in.
        const live = render();
        expect(live).toContain('data-agent="kai"');
        expect(live).toContain('data-deck-badge="1"');
        expect(live).toContain('data-workstation-health="healthy"');
    });
});

describe('twenty agents on one board', () => {
    it('renders all twenty through the shell, not just through the table', () => {
        // The density budget, asserted on the composed surface. Twenty at 32px fit a 900px
        // screen; what a markup test can prove is that none of them is dropped on the way.
        const agents = Array.from({ length: 20 }, (_, i) =>
            row({ id: `a${i}`, name: `agent-${i}`, workspaceId: i % 2 === 0 ? 'tynn' : 'fancy' }));

        const html = render({ snapshot: { ...LIVE, agents } });

        expect([...html.matchAll(/data-agent="/g)]).toHaveLength(20);
        expect(html).not.toMatch(/\+\d+ more/);
        // Both workspace groups rendered, and the rail agrees on the counts.
        expect(html).toMatch(/data-workspace="tynn"[\s\S]*?>10</);
    });
});

const DETAIL: AgentDetail = {
    agent: { id: 'kai', name: 'kai', provider: 'claude', fidelity: 'declared', cwd: 'repos/genie2' },
    session: {
        running: true, turnState: 'working', startedAt: null, pendingAsk: null, failure: null,
        contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null,
        commsAgeSeconds: null, plan: null,
    },
    rows: [{ id: 'r1', event: { kind: 'message', speaker: 'you', peerName: null, text: 'go' }, at: null }],
    turns: 3,
    cost: null,
    refusal: null,
};

describe('the agent route', () => {
    it('renders the Agent view for the agent the route names', () => {
        const html = render({ route: 'genie://agent/kai?tab=stream', agentDetail: DETAIL, agentResolved: true });

        expect(html).toContain('data-surface="agent"');
        expect(html).toContain('data-agent="kai"');
        expect(html).toContain('data-tab="stream"');
        // The chrome is still there and still shows where you are.
        expect(html).toContain('genie://agent/kai?tab=stream');
    });

    it('distinguishes NOT ASKED YET from NO SUCH AGENT', () => {
        /**
         * `agentDetail === null` is both states, and they must not share a rendering. Showing
         * the not-found while the detail loads would flash an error on **every** navigation to
         * a perfectly good agent — and once someone has seen that twice they stop trusting it
         * when it is real.
         */
        const loading = render({ route: 'genie://agent/kai', agentDetail: null, agentResolved: false });
        expect(loading).not.toContain('data-surface="agent-unknown"');
        expect(loading).not.toContain('No agent is registered');

        const missing = render({ route: 'genie://agent/ghost', agentDetail: null, agentResolved: true });
        expect(missing).toContain('data-surface="agent-unknown"');
        expect(missing).toContain('ghost');
        // And it offers the way back, rather than being a dead end.
        expect(missing).toContain('Back to the Dashboard');
    });

    it('does not render the Dashboard underneath the Agent view', () => {
        // One surface at a time. Two surfaces in one body is how a rail ends up disagreeing
        // with what is on screen.
        const html = render({ route: 'genie://agent/kai', agentDetail: DETAIL, agentResolved: true });
        expect(html).not.toContain('data-surface="dashboard"');
    });

    it('offers the genie rail row only because the AGENT surface is servable', () => {
        /**
         * The rail's rows are derived from `servable`, so the OS agent's row cannot exist
         * without the surface it navigates to. One source of truth: two lists drift, and the
         * failure is silent both ways.
         */
        const withAgent = render({ servable: ['dashboard', 'agent'] });
        expect(withAgent).toContain('data-nav="genie://agent/genie"');

        const without = render({ servable: ['dashboard'] });
        expect(without).not.toContain('data-nav="genie://agent/genie"');
    });
});
