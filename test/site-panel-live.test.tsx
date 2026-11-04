import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SitePanel } from '../src/renderer/components/SitePanel.js';

/**
 * THE LIVE SITE PANEL IN THE WINDOW (beta.35 item 36, step 5): a small bar — the site, Reload, Open in the Genie browser
 * — over a box the live page is placed on (main's view, by the box's bounds). Never an iframe. With no site chosen, the
 * panel asks which (as before).
 */

const noop = () => {};
const render = (host: string | null, live = true) => renderToStaticMarkup(
    <SitePanel host={host} onPick={noop} {...(live ? { live: { panelKey: 'ws1:tab-1:0', onBounds: noop, onHide: noop, onReload: noop, onOpenInWindow: noop } } : {})} />,
);

describe('a site panel with a site', () => {
    it('the bar names the site and offers Reload and Open in the Genie browser; the box the page goes over — no iframe', () => {
        const html = render('moic.gen');
        expect(html).toMatch(/data-site-panel="ws1:tab-1:0"/);
        expect(html).toContain('moic.gen');
        expect(html).toMatch(/data-site-panel-action="reload"/);
        expect(html).toMatch(/data-site-panel-action="open-window"[^>]*>[\s\S]*?Open in browser/);
        expect(html).toMatch(/data-site-panel-box=""/);
        expect(html).not.toContain('<iframe');
    });

    it('CONTROL: a window with no live panels (driving another machine) says where to open it — still no iframe', () => {
        const html = render('moic.gen', false);
        expect(html).not.toContain('<iframe');
        expect(html).not.toContain('data-site-panel-box');
        expect(html).toContain('moic.gen');
    });
});

describe('with no site chosen', () => {
    it('it asks which, as before', () => {
        expect(render(null)).toContain('data-site-pick');
    });
});

describe('the Electron half (read from source)', () => {
    const strip = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    const code = strip('src/main/site-panels-electron.ts');

    it('no view of main\u2019s: the page is a <webview> in the window, so no bounds or show cross to main', () => {
        expect(code).not.toMatch(/WebContentsView|site-panel:show|site-panel:hide|site-panel:reload/);
    });

    it('each main window is guarded as it is built, and its guests are driven as any page', () => {
        expect(code).toMatch(/guardSiteWebviews\(window\.webContents, /);
        expect(code).toMatch(/attachPageNavigation\(/);
    });

    it('the session is the site\u2019s workspace\u2019s store, from main\u2019s own list, and routed before the renderer may load', () => {
        expect(code).toMatch(/workspaceBrowserSession\(/);
        expect(code).toMatch(/options\.workspaceOfHost\(/);
        expect(code).toMatch(/'site-panel:prepare'[\s\S]*?await [^\n]*routed/);
        expect(code).not.toMatch(/defaultSession|fromPartition|panelKey/);
    });

    it('webviewTag is on for the main window alone, and never for a window driving another machine', () => {
        const main = strip('src/main/main.ts');
        expect(main.match(/webviewTag/g) ?? []).toHaveLength(1);
        expect(main).toMatch(/webviewTag: !search,/);
    });

    it('a workspace store comes from a chosen path, and is guarded and routed like the browser\u2019s', () => {
        const browser = strip('src/main/genie-browser-electron.ts');
        const fn = browser.slice(browser.indexOf('export function workspaceBrowserSession'));
        expect(fn).toMatch(/session\.fromPath\(browserStorePath\(/);
        expect(fn).toMatch(/guardSession\(/);
        expect(fn).toMatch(/routeSession\(/);
    });

    it('the renderer keeps its panels in step with the tabs, from the layer', () => {
        const workspace = strip('src/renderer/components/Workspace.tsx');
        expect(workspace).toMatch(/tabsChanged\(seenTabs\.current, now\)\) siteWebviewLayerFor\(sitePanels\)\.retainIn\(workspace\.id, sitePanelKeys\(workspace\.id, /);
    });
});
