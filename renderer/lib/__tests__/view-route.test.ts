import { describe, expect, it } from 'vitest';
import { mergeViewRoute, parseViewRoute, viewRouteQuery, type GenieView } from '../view-route';

/**
 * The route is the navigational truth: which SUBJECT is on screen. Genie has had
 * none — 11 independent flyout booleans in `master.tsx` and no router, so refresh
 * loses your place, there is no back, and nothing is linkable. These tests pin the
 * decisions that make it addressable before any surface is built on it.
 */
describe('parseViewRoute', () => {
    it('defaults to THE DECK when nothing is in the url', () => {
        // THE GENIE 2 FLIP. It defaulted to the grid while the Deck was a parallel surface.
        // The Deck now opens, and the grid is reached with `?view=grid`.
        //
        // The earlier attempt at this failed on all three platforms because the grid was
        // HIDDEN under the Deck on every window that opened without a query string. That is
        // survivable now for one reason: `floorSurface` CONCEALS the grid rather than
        // unmounting it, so no live xterm is destroyed, and the E2E specs that need the grid
        // now ask for it by name.
        expect(parseViewRoute({})).toEqual({ kind: 'deck' });
    });

    it('still reaches the grid, by name', () => {
        expect(parseViewRoute({ view: 'grid' })).toEqual({ kind: 'grid' });
    });

    it('reaches the Deck explicitly', () => {
        expect(parseViewRoute({ view: 'deck' })).toEqual({ kind: 'deck' });
    });

    it('lets an explicit Deck win over a leftover workspace param', () => {
        // Otherwise navigating to the Deck from a Workbench would silently stay put.
        expect(parseViewRoute({ view: 'deck', ws: 'w1' })).toEqual({ kind: 'deck' });
    });

    it('reads a workspace as the Workbench', () => {
        expect(parseViewRoute({ ws: 'w1' })).toEqual({ kind: 'workbench', workspaceId: 'w1' });
    });

    it('reads an agent, with no tab chosen yet', () => {
        // `tab: null` is NOT 'session'. Which tab an agent opens on depends on its
        // FIDELITY (a Declared agent opens on Conversation, an Observed one on
        // Terminal), and the route must not pre-empt a decision it cannot make.
        expect(parseViewRoute({ agent: 'a1' })).toEqual({ kind: 'agent', agentId: 'a1', tab: null });
    });

    it('reads an agent tab', () => {
        expect(parseViewRoute({ agent: 'a1', tab: 'terminal' })).toEqual({
            kind: 'agent',
            agentId: 'a1',
            tab: 'terminal',
        });
    });

    it('prefers the agent when both an agent and a workspace are present', () => {
        // An agent is the more specific subject, and an agent link carries its
        // workspace implicitly. Without this rule a deep link from an agent that
        // also names its workspace would land on the Workbench.
        expect(parseViewRoute({ agent: 'a1', ws: 'w1' })).toEqual({
            kind: 'agent',
            agentId: 'a1',
            tab: null,
        });
    });

    it('drops an unknown tab rather than guessing or throwing', () => {
        expect(parseViewRoute({ agent: 'a1', tab: 'bogus' })).toEqual({
            kind: 'agent',
            agentId: 'a1',
            tab: null,
        });
    });

    it('takes the first value when a param repeats', () => {
        // Next hands back `string[]` for `?ws=a&ws=b`. Picking one beats rendering
        // a workspace whose id is the literal string "a,b".
        expect(parseViewRoute({ ws: ['w1', 'w2'] })).toEqual({ kind: 'workbench', workspaceId: 'w1' });
    });

    it('falls back to the default for a blank id', () => {
        // `?ws=` must not open a Workbench for the workspace named "".
        expect(parseViewRoute({ ws: '' })).toEqual({ kind: 'deck' });
        expect(parseViewRoute({ ws: '   ' })).toEqual({ kind: 'deck' });
        expect(parseViewRoute({ agent: '' })).toEqual({ kind: 'deck' });
    });

    it('falls back to the default for a view it cannot satisfy', () => {
        // A Workbench with no workspace is not a thing. Never a blank screen.
        expect(parseViewRoute({ view: 'workbench' })).toEqual({ kind: 'deck' });
        expect(parseViewRoute({ view: 'nonsense' })).toEqual({ kind: 'deck' });
    });
});

describe('viewRouteQuery', () => {
    it('gives the DEFAULT a clean url — and that is now the Deck', () => {
        // The view you sit on most carries no params. This moved with the default, exactly
        // as the previous version of this test said it would.
        expect(viewRouteQuery({ kind: 'deck' })).toEqual({});
    });

    it('names the GRID explicitly, because it is no longer the default', () => {
        // It must be named, or parsing its own url would hand back the Deck and the two
        // halves of this module would disagree.
        expect(viewRouteQuery({ kind: 'grid' })).toEqual({ view: 'grid' });
    });

    it('omits a tab that has not been chosen', () => {
        expect(viewRouteQuery({ kind: 'agent', agentId: 'a1', tab: null })).toEqual({ agent: 'a1' });
    });

    const cases: GenieView[] = [
        { kind: 'grid' },
        { kind: 'deck' },
        { kind: 'workbench', workspaceId: 'w1' },
        { kind: 'agent', agentId: 'a1', tab: null },
        { kind: 'agent', agentId: 'a1', tab: 'session' },
        { kind: 'agent', agentId: 'a1', tab: 'terminal' },
        { kind: 'agent', agentId: 'a1', tab: 'files' },
        { kind: 'agent', agentId: 'a1', tab: 'changes' },
        { kind: 'agent', agentId: 'a1', tab: 'activity' },
    ];

    it.each(cases)('round-trips %j', (view) => {
        expect(parseViewRoute(viewRouteQuery(view))).toEqual(view);
    });
});

/**
 * The master window is ALREADY loaded with query params that are not the route:
 * `?stage=<workspaceId>` for a workspace-scoped window and `?host=<connKey>` for a
 * remote host window (`main/background.ts:720,780`, via `loadFile(..., {search})`).
 * So navigation must REWRITE the route keys and leave everything else alone — a
 * naive `router.replace({ query: viewRouteQuery(v) })` would drop `host=` and
 * quietly turn a remote window into a local one.
 */
describe('mergeViewRoute', () => {
    it('keeps a remote window remote', () => {
        // The DEFAULT (now the Deck) adds nothing; the grid names itself. Either way `host`
        // survives, which is the point — it is bound before load and decides whether the
        // renderer talks to a remote machine.
        expect(mergeViewRoute({ host: 'h1' }, { kind: 'deck' })).toEqual({ host: 'h1' });
        expect(mergeViewRoute({ host: 'h1' }, { kind: 'grid' })).toEqual({ host: 'h1', view: 'grid' });
    });

    it('keeps a stage window staged', () => {
        expect(mergeViewRoute({ stage: 'w1' }, { kind: 'agent', agentId: 'a1', tab: null })).toEqual({
            stage: 'w1',
            agent: 'a1',
        });
    });

    it('replaces the previous route instead of accumulating it', () => {
        // Leaving `ws` behind would make the url say two subjects at once, and
        // parseViewRoute's agent-wins rule would hide the contradiction.
        expect(mergeViewRoute({ ws: 'w1' }, { kind: 'agent', agentId: 'a1', tab: 'session' })).toEqual({
            agent: 'a1',
            tab: 'session',
        });
    });

    it('drops a stale tab when the new view has none', () => {
        expect(mergeViewRoute({ agent: 'a1', tab: 'terminal' }, { kind: 'workbench', workspaceId: 'w1' })).toEqual(
            { ws: 'w1' },
        );
        // And a stale `view=deck` is dropped when navigating away from it.
        expect(mergeViewRoute({ view: 'deck' }, { kind: 'deck' })).toEqual({});
    });

    it('preserves a param it has never heard of', () => {
        // Route ownership is a CLOSED list; everything else belongs to whoever put
        // it there, including params added after this module was written.
        expect(mergeViewRoute({ somethingNew: 'x' }, { kind: 'deck' })).toEqual({ somethingNew: 'x' });
    });

    it('preserves a repeated non-route param verbatim', () => {
        expect(mergeViewRoute({ tags: ['a', 'b'] }, { kind: 'deck' })).toEqual({ tags: ['a', 'b'] });
    });
});


/**
 * THE DASHBOARD ROUTE — `?view=dashboard`.
 *
 * Added with the surface itself. Named rather than made the default: the Deck is what opens,
 * and the board's own title bars read `genie://dashboard?group=workspace`, so the Dashboard is
 * a view you ask for. Making it the default is the owner's call and a separate change — the
 * comment on `GenieView['grid']` records what happened the last time a default moved before
 * the surface behind it was ready (E2E red on all three platforms).
 */
describe('the Dashboard route', () => {
    it('parses ?view=dashboard', () => {
        expect(parseViewRoute({ view: 'dashboard' })).toEqual({ kind: 'dashboard' });
    });

    it('round-trips through viewRouteQuery', () => {
        // The two halves must agree or a link built by one is misread by the other — the
        // failure mode the `grid` comment in `view-route.ts` warns about by name.
        expect(viewRouteQuery({ kind: 'dashboard' })).toEqual({ view: 'dashboard' });
        expect(parseViewRoute(viewRouteQuery({ kind: 'dashboard' }))).toEqual({ kind: 'dashboard' });
    });

    it('is beaten by an explicit agent, like every other named view', () => {
        // A deep link naming an agent is the more specific subject. Asserted so the new branch
        // cannot be inserted ahead of that rule by accident.
        expect(parseViewRoute({ view: 'dashboard', agent: 'a1' })).toEqual({ kind: 'dashboard' });
        expect(parseViewRoute({ agent: 'a1' })).toEqual({ kind: 'agent', agentId: 'a1', tab: null });
    });
});
