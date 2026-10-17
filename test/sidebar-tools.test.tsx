import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { filterRail, type RailItem } from '../src/core/rail-view.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';

/**
 * THE SIDEBAR'S TOOLS, AND A COLLAPSED STATE THAT STILL WORKS (Tynn #799, #282, #283). The owner, 2026-10-17:
 *  - "get rid of the text for show/hide hibernated. Look at the top of Genie 1 workspace sidebar and how we had access
 *    to System, Adding new workspace, showing hibernated workspaces and filtering the list."
 *  - "the genie sidebar menu should be able to collapse with an intuitive UX in the collapsed state."
 * Genie 1 (Chooser.tsx at v0.7.0-beta.342): a row of icon tools — collapse, System, hibernated (eye / eye-off), Add
 * workspace (+) — over "Search workspaces…"; collapsed, an icon rail with each workspace's name as its tooltip.
 */
const ws = (id: string, over: Partial<RailItem> = {}): RailItem => ({ id, path: `/w/${id}`, name: id, count: 2, alert: null, ...over } as RailItem);
const ALL = ['deck', 'dashboard', 'genie', 'workspace', 'settings'] as const;
function memory(collapsed: boolean): Pick<Storage, 'getItem' | 'setItem'> {
    const data = new Map<string, string>([['genie.rail.collapsed', collapsed ? '1' : '0']]);
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}
const render = (over: Record<string, unknown> = {}) => renderToStaticMarkup(
    <Sidebar route="genie://dashboard" deckCount={3} workspaces={[ws('tynn', { alert: true }), ws('fancy'), ws('old', { asleep: true })]} available={[...ALL]} onNavigate={() => {}} onAddWorkspace={() => {}} railStorage={memory(false)} {...(over as object)} />,
);

describe('the tools row (expanded)', () => {
    it('collapse, System, hibernated and Add workspace — icons with names, no "Show hibernated" text', () => {
        const html = render();
        for (const tool of ['collapse', 'system', 'hibernated', 'add-workspace']) expect(html).toContain(`data-rail-tool="${tool}"`);
        expect(html).toMatch(/data-rail-tool="hibernated"[^>]*aria-label="Show 1 hibernated workspace"/);
        expect(html).not.toContain('Show hibernated');
        expect(html).not.toContain('Hide hibernated');
        expect(html).toMatch(/data-rail-tool="add-workspace"[^>]*aria-label="Add workspace"/);
    });

    it('the filter box is there', () => {
        expect(render()).toMatch(/data-rail-filter=""[^>]*placeholder="Filter workspaces…"|placeholder="Filter workspaces…"[^>]*data-rail-filter=""/);
    });

    it('no add flow given → no + (a control that does nothing is not offered)', () => {
        expect(render({ onAddWorkspace: undefined })).not.toContain('data-rail-tool="add-workspace"');
    });
});

describe('the filter', () => {
    it('narrows by name or path, any case; empty shows all', () => {
        const items = [ws('tynn'), ws('fancy-ui', { path: '/w/packages/fancy' }), ws('moic')];
        expect(filterRail(items, 'FAN').map((w) => w.id)).toEqual(['fancy-ui']);
        expect(filterRail(items, 'packages').map((w) => w.id)).toEqual(['fancy-ui']);
        expect(filterRail(items, '  ').map((w) => w.id)).toEqual(['tynn', 'fancy-ui', 'moic']);
    });
});

describe('collapsed', () => {
    it('an icon rail: every destination still reachable, names as tooltips, the Deck badge as a dot, expand and +', () => {
        const html = render({ railStorage: memory(true) });
        expect(html).toContain('data-rail="collapsed"');
        expect(html).toMatch(/data-rail-tool="expand"[^>]*aria-label="Expand sidebar"/);
        for (const route of ['genie://deck', 'genie://dashboard', 'genie://agent/genie', 'genie://workspace/tynn', 'genie://workspace/fancy']) {
            expect(html).toContain(`data-nav="${route}"`);
        }
        expect(html).toMatch(/data-nav="genie:\/\/workspace\/tynn"[^>]*title="tynn"/);
        expect(html).toContain('data-deck-dot=""');
        expect(html).toContain('data-rail-tool="add-workspace"');
        // the labels are not drawn — the rail is narrow — but each control is still named for a screen reader
        expect(html).not.toContain('>Dashboard</span>');
        expect(html).toMatch(/aria-label="Dashboard"/);
    });

    it('CONTROL: expanded draws the labels and no expand tool', () => {
        const html = render();
        expect(html).toContain('>Dashboard</span>');
        expect(html).not.toContain('data-rail-tool="expand"');
        expect(html).not.toContain('data-rail="collapsed"');
    });
});
