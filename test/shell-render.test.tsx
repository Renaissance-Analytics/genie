import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Shell } from '../src/renderer/Shell.js';
import { EMPTY_SNAPSHOT, type GenieSnapshot } from '../src/renderer/bridge.js';
import type { AgentRow } from '../src/core/dashboard-view.js';

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
            available={['dashboard', 'deck', 'genie', 'workspace']}
            onNavigate={() => {}}
            onOpenAgent={() => {}}
            onAddAgent={() => {}}
            onOpenPalette={() => {}}
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
        const html = render({ route: 'genie://deck', available: ['dashboard'] });

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
                available={['dashboard']}
                onNavigate={() => {}}
                onOpenAgent={() => {}}
                onAddAgent={() => {}}
                onOpenPalette={() => {}}
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
