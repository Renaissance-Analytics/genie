import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RailItem } from '../src/core/rail-view.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';
import { control } from './helpers/control-markup.js';

/**
 * THE RAIL IS A MENU (the owner, 2026-11-01, on beta.55's rail: "those should not be buttons, it's a menu").
 *
 * Its destinations — Deck, Dashboard, genie, Hosting, Browser, Settings and each workspace — are items of react-fancy's
 * Sidebar inside a `<nav aria-label="Genie">`, not Buttons: left-aligned, the current one marked `aria-current="page"`
 * with Sidebar's selected style (beta.55 drew a near-black focus ring there instead), ringed only on KEYBOARD focus.
 * Every attention mark survives in BOTH modes: the Deck's count, the rate-limit dot, the Settings alert, a workspace's
 * "needs you". The collapsed (icons-only) rail shows them on the icon (react-fancy Sidebar.Item's collapsed badge).
 * The processes/sites pill stays as real Buttons — actions — beside its workspace's item, never inside it.
 *
 * Markup claims (docs/decisions.md D3).
 */
const memory = (collapsed: boolean): Pick<Storage, 'getItem' | 'setItem'> => {
    const data = new Map([['genie.rail.collapsed', collapsed ? '1' : '0']]);
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
};
const ws = (over: Partial<RailItem>): RailItem => ({ id: 'tynn', path: '/w/tynn', name: 'tynn', count: 2, alert: true, working: 0, processes: 'running', processesTitle: 'Background processes (1)', sites: 'none', sitesTitle: 'No hosted sites yet', ...over } as RailItem);
const rail = (collapsed: boolean) => renderToStaticMarkup(
    <Sidebar
        route="genie://dashboard"
        deckCount={3}
        workspaces={[ws({}), ws({ id: 'fancy', path: '/w/fancy', name: 'fancy', alert: false })]}
        available={['deck', 'dashboard', 'genie', 'hosting', 'browser', 'workspace', 'settings']}
        onNavigate={() => {}}
        onOpenBrowser={() => {}}
        onOpenProcesses={() => {}}
        onOpenSites={() => {}}
        railStorage={memory(collapsed)}
        rateLimitAlert={{ level: 'warning', label: 'Claude Code: 30% left in the 5-hour window' } as never}
        settingsAlert={{ label: 'Sign in to Tynn' }}
    />,
);
const DESTINATIONS = ['data-nav="genie://deck"', 'data-nav="genie://dashboard"', 'data-nav="genie://agent/genie"', 'data-nav="genie://hosting"', 'data-open-browser-window=""', 'data-nav="genie://settings"', 'data-workspace="tynn"', 'data-workspace="fancy"'];
const classes = (open: string) => (/\sclass="([^"]*)"/.exec(open)?.[1] ?? '').split(/\s+/);

for (const collapsed of [false, true]) {
    const mode = collapsed ? 'collapsed' : 'expanded';
    describe(`the ${mode} rail`, () => {
        const html = rail(collapsed);

        it('is a navigation landmark holding a react-fancy Sidebar', () => {
            expect(html).toMatch(/<nav\b[^>]*aria-label="Genie"/);
            expect(html).toContain('data-react-fancy-sidebar=""');
        });

        it('every destination is a Sidebar item, not a Button (COUNTED)', () => {
            for (const d of DESTINATIONS) {
                const c = control(html, d);
                expect(c, d).not.toBeNull();
                expect(c!.open, d).toContain('data-react-fancy-sidebar-item=""');
                expect(c!.fancy, d).toBe(false); // not react-fancy's Button
            }
        });

        it('the current destination, and only it, is aria-current="page" in the selected style; no ring on mouse focus', () => {
            expect(html.match(/aria-current="page"/g) ?? []).toHaveLength(1);
            expect(control(html, 'data-nav="genie://dashboard"')!.open).toContain('aria-current="page"');
            for (const d of DESTINATIONS) {
                const k = classes(control(html, d)!.open);
                expect(k.filter((c) => /^focus:ring-(?!0$)/.test(c)), d).toEqual([]);
            }
        });

        it('every attention mark is drawn: the Deck, the rate limit, Settings, a workspace that needs you', () => {
            expect(control(html, 'data-nav="genie://deck"')!.inner).toMatch(collapsed ? /data-deck-dot=""/ : /data-deck-badge="3"/);
            expect(control(html, 'data-nav="genie://dashboard"')!.inner).toMatch(/data-rate-limit-dot="warning"/);
            expect(control(html, 'data-nav="genie://settings"')!.inner).toMatch(/data-settings-alert/);
            expect(control(html, 'data-workspace="tynn"')!.inner).toMatch(/aria-label="needs you"/);
            // CONTROL: a workspace that does not need you draws no dot.
            expect(control(html, 'data-workspace="fancy"')!.inner).not.toMatch(/aria-label="needs you"/);
        });

        it('the processes/sites pill: real Buttons BESIDE the workspace item, never inside it', () => {
            expect(control(html, 'data-workspace="tynn"')!.inner).not.toMatch(/data-ws-processes|data-ws-sites|<button\b/);
            if (!collapsed) {
                expect(control(html, 'data-ws-processes="tynn"')).toMatchObject({ tag: 'button', fancy: true });
                expect(control(html, 'data-ws-sites="tynn"')).toMatchObject({ tag: 'button', fancy: true });
            }
        });
    });
}

describe('the expanded rail is left-aligned', () => {
    it('no destination centres its content', () => {
        const html = rail(false);
        for (const d of DESTINATIONS) expect(classes(control(html, d)!.open), d).not.toContain('justify-center');
    });
});
