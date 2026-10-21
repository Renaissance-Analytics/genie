import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FEATURE_ICONS, railSurfacesFor, railWorkspaces } from '../src/core/rail-view.js';
import { SERVABLE } from '../src/renderer/bridge.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';

/**
 * EVERY SURFACE HAS A LABELLED WAY IN (spec §4.0: "Navigation is persistent and labelled. ⌘K is an accelerator, never
 * the only route"). The owner, 2026-10-14: "WTF happened to all of our genie sites and bg processes features? Why is
 * none of that available?" — Hosting (Sites / Processes / Services), Toolchain and AgentInbox were built and servable,
 * and nothing pointed at them: no rail row, no title-bar icon. Built and unreachable, §0.4 again.
 *
 * And the rail hides HIBERNATED workspaces by default, with a button to show them (the owner, the same day: "I still
 * see all of the hibernated workspaces (I should have a button to show and hide and they are hidden by default)").
 */

const rail = (over: Partial<Parameters<typeof Sidebar>[0]> = {}) =>
    renderToStaticMarkup(
        <Sidebar route="genie://dashboard" deckCount={0} workspaces={[]} available={railSurfacesFor(SERVABLE)} onNavigate={() => {}} {...over} />,
    );

describe('every servable feature surface is reachable by a labelled control', () => {
    it('COUNTED: no feature surface the shell serves is left without a rail row or a title-bar icon', () => {
        const html = rail();
        const titleBar = new Set(FEATURE_ICONS.map((f) => f.route));
        // DERIVED, not typed: every servable surface that is not reached through an agent or a workspace row. A typed
        // list left the Genie Browser out, and the owner found it missing (2026-10-14) — a new surface must not need
        // someone to remember to add it here.
        const reachedOtherwise = new Set(['dashboard', 'deck', 'agent', 'workspace', 'takeover', 'files']);
        const features = SERVABLE.filter((s) => !reachedOtherwise.has(s));
        expect(features).toContain('browser');
        const unreachable = features.filter((s) => !titleBar.has(`genie://${s}`) && !html.includes(`data-nav="genie://${s}"`));
        expect(unreachable).toEqual([]);
    });

    // REWRITTEN for beta.33 item 20 (the owner: "Tool chain is a Settings thing, it should not be its own page in the
    // menu"): Toolchain is Settings → Toolchain now, reached through the Settings row — no row of its own.
    it('Hosting is a row, named as its surface names itself; Toolchain is not (it is in Settings)', () => {
        const html = rail();
        expect(html).toMatch(/data-nav="genie:\/\/hosting"[\s\S]*?>Hosting</);
        expect(html).not.toContain('data-nav="genie://toolchain"');
        expect(html).toContain('data-nav="genie://settings"');
    });

    // The owner (beta.33 item 19): "the agentinbox should not be a page and it should be accessible from the header system
    // icons just like it was in genie 1". Its way in is the title bar's icon (test/inbox-flyout-ui.test.tsx), not a row.
    it('the AgentInbox is NOT a rail row any more (positive control: Hosting still is)', () => {
        const html = rail();
        expect(html).not.toContain('genie://inbox');
        expect(html).not.toMatch(/>AgentInbox</);
        expect(html).toContain('data-nav="genie://hosting"');
    });

    it('the Genie Browser is a row — .gen sites, tailnet and Tynn addresses open inside Genie', () => {
        expect(rail()).toMatch(/data-nav="genie:\/\/browser"[\s\S]*?>Browser</);
    });

    it('a row exists only when its surface is served — CONTROL: absent from a build that cannot serve it', () => {
        expect(rail({ available: railSurfacesFor(['dashboard']) })).not.toContain('genie://hosting');
    });
});

describe('hibernated workspaces', () => {
    const snapshotWorkspaces = [
        { id: 'awake', path: '/w/awake', name: 'awake', agentsKnown: true, asleep: false },
        { id: 'sleepy', path: '/w/sleepy', name: 'sleepy', agentsKnown: true, asleep: true },
        { id: 'dozy', path: '/w/dozy', name: 'dozy', agentsKnown: true, asleep: true },
    ];
    const items = railWorkspaces(snapshotWorkspaces, []);

    it('the rail item says which are asleep', () => {
        expect(items.map((w) => [w.id, w.asleep === true])).toEqual([['awake', false], ['sleepy', true], ['dozy', true]]);
    });

    it('are HIDDEN by default, with a button that says how many it hides', () => {
        const html = rail({ workspaces: items });
        expect(html.match(/data-workspace="/g) ?? []).toHaveLength(1);
        expect(html).toContain('data-workspace="awake"');
        // An eye, no words (Tynn #282): the count is its accessible name and tooltip.
        expect(html).toMatch(/data-toggle-asleep="show"[^>]*aria-label="Show 2 hibernated workspaces"/);
        expect(html).not.toContain('Show hibernated');
    });

    it('the one you are looking at stays visible even while the rest are hidden', () => {
        const html = rail({ workspaces: items, route: 'genie://workspace/sleepy' });
        expect(html.match(/data-workspace="/g) ?? []).toHaveLength(2);
        expect(html).toContain('data-workspace="sleepy"');
    });

    it('no button when nothing is asleep', () => {
        expect(rail({ workspaces: railWorkspaces([snapshotWorkspaces[0]!], []) })).not.toContain('data-toggle-asleep');
    });
});
