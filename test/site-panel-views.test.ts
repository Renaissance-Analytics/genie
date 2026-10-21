import { describe, expect, it } from 'vitest';
import { SitePanelViews, type PanelViewPort } from '../src/main/site-panel-views.js';

/**
 * LIVE SITE PANELS (beta.35 item 36, step 5; the owner, FTQ q_227d0bb6: site panels are LIVE pages). A workspace tab's
 * `site` panel is a real page — a view in the Genie browser's own session (its .gen routing and Genie's CA), placed over
 * the panel's box in the window — never an iframe (the window's CSP blocks one, and its session has no .gen route).
 * One view per panel; a panel off screen is hidden, one that is gone is closed; only a Genie site this workstation
 * serves is shown.
 */

interface FakeView extends PanelViewPort {
    readonly key: string;
    readonly loads: string[];
    bounds: { x: number; y: number; width: number; height: number } | null;
    visible: boolean | null;
    reloads: number;
    destroyed: boolean;
}

function harness(hosts: string[] = ['tynn.gen', 'moic.gen']) {
    const views: FakeView[] = [];
    const panels = new SitePanelViews({
        enabledHosts: () => hosts,
        createView: (key) => {
            const v: FakeView = {
                key, loads: [], bounds: null, visible: null, reloads: 0, destroyed: false,
                load(url) { this.loads.push(url); }, reload() { this.reloads += 1; },
                setBounds(b) { this.bounds = b; }, setVisible(on) { this.visible = on; }, destroy() { this.destroyed = true; },
            };
            views.push(v);
            return v;
        },
    });
    return { panels, views };
}
const BOX = { x: 300, y: 120, width: 640, height: 480 };

describe('a site panel on screen', () => {
    it('gets ONE view, loading https://<host>/, placed over its box and shown', () => {
        const { panels, views } = harness();
        expect(panels.show('ws1:tab-1:0', 'moic.gen', BOX)).toEqual({ ok: true });
        expect(views).toHaveLength(1);
        expect(views[0]).toMatchObject({ loads: ['https://moic.gen/'], bounds: BOX, visible: true });
    });

    it('the box moving or resizing moves the view — the page is not loaded again', () => {
        const { panels, views } = harness();
        panels.show('ws1:tab-1:0', 'moic.gen', BOX);
        panels.show('ws1:tab-1:0', 'moic.gen', { x: 300.4, y: 90.6, width: 800, height: 500 });
        expect(views).toHaveLength(1);
        expect(views[0]!.loads).toEqual(['https://moic.gen/']);
        expect(views[0]!.bounds).toEqual({ x: 300, y: 91, width: 800, height: 500 });
    });

    it('a different site placed in the same panel loads there', () => {
        const { panels, views } = harness();
        panels.show('ws1:tab-1:0', 'moic.gen', BOX);
        panels.show('ws1:tab-1:0', 'tynn.gen', BOX);
        expect(views).toHaveLength(1);
        expect(views[0]!.loads).toEqual(['https://moic.gen/', 'https://tynn.gen/']);
    });

    it('two panels are two views', () => {
        const { panels, views } = harness();
        panels.show('ws1:tab-1:0', 'moic.gen', BOX);
        panels.show('ws1:tab-1:1', 'tynn.gen', BOX);
        expect(views.map((v) => v.key)).toEqual(['ws1:tab-1:0', 'ws1:tab-1:1']);
    });
});

describe('off screen and gone', () => {
    it('a panel whose tab is not shown is hidden, and shown again where its box is, without a reload', () => {
        const { panels, views } = harness();
        panels.show('ws1:tab-1:0', 'moic.gen', BOX);
        panels.hide('ws1:tab-1:0');
        expect(views[0]!.visible).toBe(false);
        panels.show('ws1:tab-1:0', 'moic.gen', BOX);
        expect(views[0]!.visible).toBe(true);
        expect(views[0]!.loads).toHaveLength(1);
    });

    it('a zero-sized box is off screen: hidden, not painted over another surface', () => {
        const { panels, views } = harness();
        panels.show('ws1:tab-1:0', 'moic.gen', BOX);
        panels.show('ws1:tab-1:0', 'moic.gen', { x: 0, y: 0, width: 0, height: 0 });
        expect(views[0]!.visible).toBe(false);
    });

    it('a panel removed or cleared closes its page; every panel closes with the window', () => {
        const { panels, views } = harness();
        panels.show('ws1:tab-1:0', 'moic.gen', BOX);
        panels.show('ws1:tab-1:1', 'tynn.gen', BOX);
        panels.remove('ws1:tab-1:0');
        expect(views[0]!.destroyed).toBe(true);
        panels.closeAll();
        expect(views[1]!.destroyed).toBe(true);
    });

    it('a workspace’s tabs changed: its panels no longer there close; another workspace’s are untouched', () => {
        const { panels, views } = harness();
        panels.show('ws1:tab-1:0', 'moic.gen', BOX);
        panels.show('ws1:tab-1:1', 'tynn.gen', BOX);
        panels.show('ws2:tab-1:0', 'moic.gen', BOX);
        panels.retainIn('ws1', new Set(['ws1:tab-1:1']));
        expect(views.map((v) => v.destroyed)).toEqual([true, false, false]);
    });

    it('reload reloads that panel only', () => {
        const { panels, views } = harness();
        panels.show('ws1:tab-1:0', 'moic.gen', BOX);
        panels.show('ws1:tab-1:1', 'tynn.gen', BOX);
        panels.reload('ws1:tab-1:1');
        expect(views.map((v) => v.reloads)).toEqual([0, 1]);
    });
});

describe('only a Genie site this workstation serves', () => {
    it('anything else is refused in words, and no view is made', () => {
        const { panels, views } = harness();
        expect(panels.show('ws1:tab-1:0', 'example.com', BOX)).toEqual({ ok: false, error: 'example.com is not an enabled tunnel on this host.' });
        expect(panels.show('ws1:tab-1:0', 'other.gen', BOX)).toEqual({ ok: false, error: 'other.gen is not an enabled tunnel on this host.' });
        expect(views).toHaveLength(0);
    });

    it('a site that stops being served closes the panel’s page rather than show a stale one', () => {
        const hosts = ['tynn.gen', 'moic.gen'];
        const { panels, views } = harness(hosts);
        panels.show('ws1:tab-1:0', 'moic.gen', BOX);
        hosts.splice(1, 1);
        expect(panels.show('ws1:tab-1:0', 'moic.gen', BOX).ok).toBe(false);
        expect(views[0]!.destroyed).toBe(true);
    });

    it('CONTROL: unknown keys change nothing', () => {
        const { panels, views } = harness();
        panels.hide('nope');
        panels.remove('nope');
        panels.reload('nope');
        expect(views).toHaveLength(0);
    });
});

describe('which panels a workspace’s tabs have (core/workspace-tabs.ts sitePanelKeys)', () => {
    it('every site panel with a site, as workspace:tab:cell — not an empty one, not another kind', async () => {
        const { sitePanelKeys } = await import('../src/core/workspace-tabs.js');
        const state = { tabs: [
            { id: 'tab-1', name: 'Ops', layout: 'columns-2' as const, cells: [{ kind: 'site' as const, ref: 'moic.gen' }, { kind: 'site' as const, ref: null }] },
            { id: 'tab-2', name: 'Dev', layout: 'columns-2' as const, cells: [{ kind: 'terminal' as const, ref: 't1' }, { kind: 'site' as const, ref: 'tynn.gen' }] },
        ] };
        expect([...sitePanelKeys('ws1', state)]).toEqual(['ws1:tab-1:0', 'ws1:tab-2:1']);
    });
});
