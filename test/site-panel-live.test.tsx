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
    const code = readFileSync('src/main/site-panels-electron.ts', 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    it('the Genie browser’s own session — its .gen routing and Genie’s CA — not the window’s', () => {
        expect(code).toMatch(/genieBrowserSession\(/);
        expect(code).not.toMatch(/defaultSession|fromPartition/);
    });
    it('a page isolated from Node, with no preload, not sandboxed (a sandboxed child view renders blank, electron#44897)', () => {
        const prefs = /new WebContentsView\(\{ webPreferences: \{([^}]*)\} \}\)/.exec(code)?.[1] ?? '';
        expect(prefs).toMatch(/contextIsolation: true/);
        expect(prefs).toMatch(/nodeIntegration: false/);
        expect(prefs).toMatch(/sandbox: false/);
        expect(prefs).not.toMatch(/preload/);
    });
    it('a page’s new window opens in the Genie browser window, never a window of its own', () => {
        expect(code).toMatch(/setWindowOpenHandler\(\(\{ url \}\) => \{\s*options\.openInWindow\(url\);\s*return \{ action: 'deny' \};/);
    });
});
