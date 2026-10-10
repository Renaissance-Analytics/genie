import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import {
    FEATURE_ICONS,
    deckBadge,
    railSurfacesFor,
    railWorkspaces,
    type RailWorkspace,
} from '../src/core/rail-view.js';

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

const ws = (id: string, over: Partial<RailWorkspace> = {}): RailWorkspace => ({
    id, path: `C:/_Projects/${id}`, agentsKnown: true, ...over,
});

describe('the workspace rail', () => {
    it('carries a count and an alert dot per workspace', () => {
        const items = railWorkspaces([ws('tynn'), ws('fancy')], [
            row({ id: '1', workspaceId: 'tynn' }),
            row({ id: '2', workspaceId: 'tynn', state: 'waiting', ask: 'ok?' }),
            row({ id: '3', workspaceId: 'fancy' }),
        ]);

        expect(items).toEqual([
            { id: 'tynn', path: 'C:/_Projects/tynn', count: 2, alert: true },
            { id: 'fancy', path: 'C:/_Projects/fancy', count: 1, alert: false },
        ]);
    });

    it('raises the dot for BROKEN as well as waiting \u2014 both mean this workspace needs a look', () => {
        const [broken] = railWorkspaces([ws('tynn')], [row({ state: 'broken', fixes: ['Restart'] })]);
        expect(broken?.alert).toBe(true);

        // POSITIVE CONTROL: the dot is not simply always on.
        const [quiet] = railWorkspaces([ws('tynn')], [row({ state: 'idle' })]);
        expect(quiet?.alert).toBe(false);
    });

    it('does NOT raise the dot for an unreachable remote agent', () => {
        // A workstation being offline is not work waiting on you, and a dot that fires for it
        // teaches the reader to ignore the dot. It belongs on the Deck's signal strip.
        const [item] = railWorkspaces([ws('tynn')], [row({ state: 'remote', fidelity: 'remote' })]);
        expect(item?.alert).toBe(false);
    });

    it('reports a MEASURED zero for a workspace Genie has looked at and found empty', () => {
        const [item] = railWorkspaces([ws('empty')], []);
        expect(item).toEqual({ id: 'empty', path: 'C:/_Projects/empty', count: 0, alert: false });
    });

    it('reports NOTHING \u2014 not zero \u2014 for a workspace whose agents have not been read yet', () => {
        // First paint is skeletons, never zeros. "No agents" and "we have not heard yet" are
        // different claims, and a `0` in the rail on launch is the second one wearing the
        // first one's clothes.
        const [item] = railWorkspaces([ws('cold', { agentsKnown: false })], []);
        expect(item).toEqual({ id: 'cold', path: 'C:/_Projects/cold', count: null, alert: null });
    });

    it('never emits a zero count OR a false alert while knowledge is missing, across a mixed rail', () => {
        // COUNT, not a spot-check: one unknown workspace handled correctly while another
        // leaks a 0 is the exact shape that keeps shipping here.
        const items = railWorkspaces(
            [ws('a'), ws('b', { agentsKnown: false }), ws('c', { agentsKnown: false }), ws('d')],
            [row({ id: '1', workspaceId: 'a', state: 'waiting', ask: 'ok?' })],
        );

        expect(items.filter((i) => i.count === null)).toHaveLength(2);
        expect(items.filter((i) => i.alert === null)).toHaveLength(2);
        // POSITIVE CONTROL: the known ones DID produce numbers, including a real zero.
        expect(items.map((i) => i.count)).toEqual([1, null, null, 0]);
        expect(items.map((i) => i.alert)).toEqual([true, null, null, false]);
    });

    it('keeps the rail\u2019s order \u2014 it is the order Genie was given, not alphabetical', () => {
        const items = railWorkspaces([ws('tynn'), ws('genie'), ws('fancy')], []);
        expect(items.map((i) => i.id)).toEqual(['tynn', 'genie', 'fancy']);
    });
});

describe('the Deck badge \u2014 the only badge in the application', () => {
    it('reports the number of things waiting on a human', () => {
        expect(deckBadge(3)).toBe(3);
    });

    it('reports NOTHING at zero rather than a badge reading 0', () => {
        // A badge that is sometimes 0 is furniture, and furniture trains people not to look at
        // it. The Deck being empty is said by the Deck, not by a zero in the rail.
        expect(deckBadge(0)).toBeNull();
    });

    it('reports nothing when the queue has not been read yet', () => {
        expect(deckBadge(null)).toBeNull();
    });
});

describe('the four feature icons', () => {
    it('names all four, each with a tooltip \u2014 no unlabelled mystery glyph', () => {
        /**
         * The owner's decision, and the one thing the design board does not carry because it
         * predates it: GApps, the Knowledge Graph, Flows and Genie OSA live in the title bar,
         * right of the logo.
         *
         * The assertion that matters is the LABEL. Four unexplained glyphs in the chrome is
         * how a feature ships and nobody finds it, which is §0.4's whole story.
         */
        expect(FEATURE_ICONS).toHaveLength(4);
        expect(FEATURE_ICONS.map((f) => f.label)).toEqual(['GApps', 'Knowledge Graph', 'Flows', 'Genie OSA']);

        expect(FEATURE_ICONS.filter((f) => f.label.trim() === '')).toEqual([]);
        expect(FEATURE_ICONS.filter((f) => f.icon.trim() === '')).toEqual([]);
        // Each goes somewhere. An icon with no route is a decoration.
        expect(FEATURE_ICONS.filter((f) => !f.route.startsWith('genie://'))).toEqual([]);
    });

    it('gives each a DISTINCT icon and route, because four of the same glyph is no signpost', () => {
        expect(new Set(FEATURE_ICONS.map((f) => f.icon)).size).toBe(4);
        expect(new Set(FEATURE_ICONS.map((f) => f.route)).size).toBe(4);
    });
});

describe('the rail’s rows are DERIVED from what the shell can serve', () => {
    it('offers a row only for a surface that renders', () => {
        /**
         * One source of truth, because two lists drift and the failure is silent in BOTH
         * directions: a row navigating to a surface the shell cannot render leaves a blank
         * body, and a surface that renders with no row pointing at it is §0.4 again — built,
         * shipped and unreachable.
         */
        expect(railSurfacesFor(['dashboard'])).toEqual(['dashboard']);
        expect(railSurfacesFor(['dashboard', 'agent'])).toEqual(['dashboard', 'genie']);
        expect(railSurfacesFor(['dashboard', 'deck', 'agent', 'workspace']))
            .toEqual(['deck', 'dashboard', 'genie', 'workspace']);
    });

    it('rides the genie row on the AGENT surface, because that is what it navigates to', () => {
        // The OS agent is an agent. Giving it a surface of its own would mean a row that can
        // render while the thing it renders cannot.
        expect(railSurfacesFor(['agent'])).toEqual(['genie']);
        expect(railSurfacesFor(['dashboard'])).not.toContain('genie');
    });

    it('offers nothing for a build that serves nothing', () => {
        // Degenerate, and worth pinning: the empty case must be empty rather than defaulting
        // to the full rail.
        expect(railSurfacesFor([])).toEqual([]);
    });

    it('keeps the rail’s own order regardless of the order it is told', () => {
        // The rail reads top to bottom in a fixed order. Deriving it from the caller's array
        // order would let a refactor reshuffle somebody's navigation.
        expect(railSurfacesFor(['workspace', 'agent', 'dashboard', 'deck']))
            .toEqual(['deck', 'dashboard', 'genie', 'workspace']);
    });
});
