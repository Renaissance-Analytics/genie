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
        const features = ['knowledge', 'flows', 'hosting', 'toolchain', 'inbox', 'settings'] as const;
        const unreachable = features.filter((s) => SERVABLE.includes(s) && !titleBar.has(`genie://${s}`) && !html.includes(`data-nav="genie://${s}"`));
        expect(unreachable).toEqual([]);
    });

    it('Hosting, Toolchain and AgentInbox are rows, named as their surfaces name themselves', () => {
        const html = rail();
        expect(html).toMatch(/data-nav="genie:\/\/hosting"[\s\S]*?>Hosting</);
        expect(html).toMatch(/data-nav="genie:\/\/toolchain"[\s\S]*?>Toolchain</);
        expect(html).toMatch(/data-nav="genie:\/\/inbox"[\s\S]*?>AgentInbox</);
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
        expect(html).toMatch(/data-toggle-asleep="show"[^>]*>[\s\S]*?Show hibernated · 2/);
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
