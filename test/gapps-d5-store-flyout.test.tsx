// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gappRibbon, type GAppListing } from '../src/core/gapps.js';
import { TitleBar } from '../src/renderer/components/TitleBar.js';

/**
 * GAPPS D5 (Tynn #468; spec .ai/plans/specs/adf-sdk.md, story D5): THE TITLE-BAR GAPPS ICON OPENS THE GAPP STORE. The icon
 * (core/rail-view.ts FEATURE_ICONS) routed to genie://gapps, which nothing serves: a click did nothing a person could see.
 * It now opens the GApp Store flyout, a react-fancy Drawer, over the window: the installed apps and the launchers of the
 * workspaces that build one. A dev launcher always carries its ribbon; the ribbon comes from what Genie knows (`dev`),
 * never from anything an app declares, so nothing an app ships can remove it.
 *
 * Until the install book (D2) supplies apps, the list is empty and says so. Interaction is a claim about a live DOM, so
 * this renders in happy-dom (docs/decisions.md D4).
 */
const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
let routes: string[];
beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    routes = [];
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const draw = (apps: readonly GAppListing[] | null) => act(() => {
    root.render(<TitleBar route="genie://dashboard" workstation={{ name: 'alphar', healthy: true }} onNavigate={(r) => { routes.push(r); }} onOpenPalette={() => {}} gapps={{ apps }} />);
});
const store = () => document.querySelector('[data-gapp-store]');
const clickIcon = () => act(() => { (document.querySelector('[data-feature="GApps"]') as HTMLElement).click(); });

const notes: GAppListing = { id: 'com.example.notes', name: 'Notes', version: '1.2.0', state: 'installed', dev: false };
const builder: GAppListing = { id: 'ws-shop', name: 'Shop', version: null, state: 'installed', dev: true, workspace: 'shop' };

describe('the title-bar GApps icon', () => {
    it('opens the GApp Store flyout, rather than routing to genie://gapps, which nothing serves', () => {
        draw([]);
        expect(store()).toBeNull();
        clickIcon();
        expect(store()).not.toBeNull();
        expect(routes).toEqual([]);
    });

    it('with no apps yet, the flyout says so in words', () => {
        draw([]);
        clickIcon();
        expect(store()?.textContent).toMatch(/No GApps yet/);
    });

    it('lists each app by name and version; the icon again, or the flyout\'s close, closes it', () => {
        draw([notes, builder]);
        clickIcon();
        expect(document.querySelector('[data-gapp="com.example.notes"]')?.textContent).toMatch(/Notes.*1\.2\.0/);
        expect(document.querySelector('[data-gapp="ws-shop"]')?.textContent).toMatch(/Shop/);
        clickIcon();
        expect(store()).toBeNull();
    });

    it('while the store is loading, it shows that it is loading, not an empty list', () => {
        draw(null);
        clickIcon();
        expect(store()?.querySelector('[data-gapp-store-loading]')).not.toBeNull();
        expect(store()?.textContent).not.toMatch(/No GApps yet/);
    });
});

describe('a dev launcher always carries its ribbon', () => {
    it('the dev launcher is ribboned; an installed app is not', () => {
        draw([notes, builder]);
        clickIcon();
        expect(document.querySelector('[data-gapp="ws-shop"] [data-gapp-dev-ribbon]')?.textContent).toBe('Dev');
        expect(document.querySelector('[data-gapp="com.example.notes"] [data-gapp-dev-ribbon]')).toBeNull();
    });

    it('nothing an app declares removes it: the ribbon comes from `dev` alone', () => {
        const declaresNoRibbon = { ...builder, ribbon: false, hideRibbon: true, badge: null } as unknown as GAppListing;
        expect(gappRibbon(declaresNoRibbon)).toBe('Dev');
        draw([declaresNoRibbon]);
        clickIcon();
        expect(document.querySelector('[data-gapp="ws-shop"] [data-gapp-dev-ribbon]')?.textContent).toBe('Dev');
        // CONTROL: not a dev launcher, no ribbon, whatever it declares.
        expect(gappRibbon({ ...notes, ribbon: true } as unknown as GAppListing)).toBeNull();
    });
});

describe('a window with no GApp Store', () => {
    it('CONTROL: the icon still routes, as before', () => {
        act(() => {
            root.render(<TitleBar route="genie://dashboard" workstation={{ name: 'alphar', healthy: true }} onNavigate={(r) => { routes.push(r); }} onOpenPalette={() => {}} />);
        });
        clickIcon();
        expect(routes).toEqual(['genie://gapps']);
        expect(store()).toBeNull();
    });
});
