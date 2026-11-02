import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RailItem } from '../src/core/rail-view.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';
import { control } from './helpers/control-markup.js';

/**
 * THE RAIL IS A MENU (the owner, 2026-11-01, on beta.55's rail: "those should not be buttons, it's a menu").
 *
 * Its destinations — Deck, Dashboard, genie, Hosting, Browser, Settings and each workspace — are items of react-fancy's
 * Sidebar (6.1.0), which wraps them in its own `<nav aria-label="Genie">` (`navLabel`) and moves focus with the arrow
 * keys (`keyboardNav`, test/rail-keyboard.test.tsx). The current item is `aria-current="page"` in Sidebar's selected
 * style (beta.55 drew a near-black focus ring there instead); rings are keyboard-only.
 * Every attention mark is Sidebar's item DOT, drawn at the icon's corner in BOTH modes, with words for a screen reader
 * (`dotLabel`): the Deck (what is waiting), the rate limit, the Settings alert, a workspace that needs you.
 * The processes/sites pill stays as real Buttons — actions — beside its workspace's item, never inside it.
 *
 * Markup claims (docs/decisions.md D3).
 */
const memory = (collapsed: boolean): Pick<Storage, 'getItem' | 'setItem'> => {
    const data = new Map([['genie.rail.collapsed', collapsed ? '1' : '0']]);
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
};
const ws = (over: Partial<RailItem>): RailItem => ({ id: 'tynn', path: '/w/tynn', name: 'tynn', count: 2, alert: true, working: 0, processes: 'running', processesTitle: 'Background processes (1)', sites: 'none', sitesTitle: 'No hosted sites yet', ...over } as RailItem);
const rail = (collapsed: boolean, rateLevel: 'warning' | 'danger' = 'warning') => renderToStaticMarkup(
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
        rateLimitAlert={{ level: rateLevel, label: 'Claude Code: 30% left in the 5-hour window' } as never}
        settingsAlert={{ label: 'Sign in to Tynn' }}
    />,
);
const DESTINATIONS = ['data-nav="genie://deck"', 'data-nav="genie://dashboard"', 'data-nav="genie://agent/genie"', 'data-nav="genie://hosting"', 'data-open-browser-window=""', 'data-nav="genie://settings"', 'data-workspace="tynn"', 'data-workspace="fancy"'];
const classes = (open: string) => (/\sclass="([^"]*)"/.exec(open)?.[1] ?? '').split(/\s+/);
/** The item's dot: its colour, and the words a screen reader hears with the item's name. */
const dotOf = (html: string, attr: string): { color: string; words: string } | null => {
    const inner = control(html, attr)!.inner;
    const color = /data-react-fancy-sidebar-dot=""[^>]*data-color="([^"]+)"|data-color="([^"]+)"[^>]*data-react-fancy-sidebar-dot=""/.exec(inner);
    if (!color) return null;
    const words = /data-react-fancy-sidebar-dot-label=""[^>]*>([^<]*)</.exec(inner)?.[1]?.trim() ?? '';
    return { color: (color[1] ?? color[2])!, words };
};

for (const collapsed of [false, true]) {
    const mode = collapsed ? 'collapsed' : 'expanded';
    describe(`the ${mode} rail`, () => {
        const html = rail(collapsed);

        it('is react-fancy Sidebar’s navigation landmark, labelled Genie', () => {
            expect(html).toContain('data-react-fancy-sidebar=""');
            expect(html).toMatch(/<nav\b[^>]*data-react-fancy-sidebar-nav=""[^>]*aria-label="Genie"|<nav\b[^>]*aria-label="Genie"[^>]*data-react-fancy-sidebar-nav=""/);
        });

        it('every destination is a Sidebar item, not a Button (COUNTED)', () => {
            for (const d of DESTINATIONS) {
                const c = control(html, d);
                expect(c, d).not.toBeNull();
                expect(c!.open, d).toContain('data-react-fancy-sidebar-item=""');
                expect(c!.fancy, d).toBe(false); // not react-fancy's Button
            }
        });

        it('the current destination, and only it, is aria-current="page"; no ring on mouse focus', () => {
            expect(html.match(/aria-current="page"/g) ?? []).toHaveLength(1);
            expect(control(html, 'data-nav="genie://dashboard"')!.open).toContain('aria-current="page"');
            for (const d of DESTINATIONS) expect(classes(control(html, d)!.open).filter((c) => /^focus:ring-(?!0$)/.test(c)), d).toEqual([]);
        });

        it('every attention mark is the item’s dot, in colour and in words', () => {
            expect(dotOf(html, 'data-nav="genie://deck"')).toEqual({ color: 'amber', words: '3 waiting' });
            expect(dotOf(html, 'data-nav="genie://dashboard"')).toEqual({ color: 'amber', words: 'Claude Code: 30% left in the 5-hour window' });
            expect(dotOf(html, 'data-nav="genie://settings"')).toEqual({ color: 'amber', words: 'Sign in to Tynn' });
            expect(dotOf(html, 'data-workspace="tynn"')).toEqual({ color: 'amber', words: 'needs you' });
            // CONTROLS: nothing needs you in `fancy`; nothing is wrong with Hosting.
            expect(dotOf(html, 'data-workspace="fancy"')).toBeNull();
            expect(dotOf(html, 'data-nav="genie://hosting"')).toBeNull();
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

describe('the rate-limit dot', () => {
    it('is red when the limit is nearly spent (danger), amber before that (CONTROL above)', () => {
        expect(dotOf(rail(false, 'danger'), 'data-nav="genie://dashboard"')!.color).toBe('red');
        expect(dotOf(rail(true, 'danger'), 'data-nav="genie://dashboard"')!.color).toBe('red');
    });
});

describe('the expanded rail', () => {
    it('is left-aligned: no destination centres its content', () => {
        const html = rail(false);
        for (const d of DESTINATIONS) expect(classes(control(html, d)!.open), d).not.toContain('justify-center');
    });

    it('still shows how many wait in the Deck — seen, not read twice (the dot says it in words)', () => {
        const deck = control(rail(false), 'data-nav="genie://deck"')!.inner;
        expect(deck).toMatch(/data-deck-badge="3"[^>]*aria-hidden="true"|aria-hidden="true"[^>]*data-deck-badge="3"/);
    });
});
