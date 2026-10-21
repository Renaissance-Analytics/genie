import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GenieBrowserChrome } from '../src/renderer/components/GenieBrowserChrome.js';
import type { BrowserSnapshot } from '../src/main/genie-browser-window.js';

/**
 * THE GENIE BROWSER WINDOW'S CHROME (beta.35 item 36, step 2 — Genie 1's renderer/pages/testing-browser.tsx): the title
 * row (the window's drag area), the tabs with × and +, back / forward / reload, the lock and the address, the device
 * presets, a row of the Genie sites, the load error, and the page box the view is placed over — with Genie 1's empty
 * states. Everything it shows comes from main's snapshot; every click is a call back to main.
 */

const presets = [{ id: 'fit', label: 'Fit' }, { id: 'desktop', label: 'Desktop 1280' }, { id: 'laptop', label: 'Laptop 1024' }, { id: 'tablet', label: 'Tablet 768' }, { id: 'mobile', label: 'Mobile 390' }];
const tab = (id: string, over: Partial<BrowserSnapshot['tabs'][number]> = {}) => ({ id, url: `https://${id}.gen/`, title: null, loading: false, canGoBack: false, canGoForward: false, error: null, ...over });
const snap = (over: Partial<BrowserSnapshot> = {}): BrowserSnapshot => ({ tabs: [], active: null, presetId: 'fit', presets, sites: ['tynn.gen', 'moic.gen'], ...over });
const noop = () => {};
const handlers = { onNavigate: noop, onOpen: noop, onActivate: noop, onClose: noop, onNewTab: noop, onBack: noop, onForward: noop, onReload: noop, onPreset: noop };
const render = (s: BrowserSnapshot, extra: { refusal?: string | null } = {}) => renderToStaticMarkup(<GenieBrowserChrome snapshot={s} refusal={extra.refusal ?? null} {...handlers} />);

describe('the tabs', () => {
    it('each tab by its title (else its address), the active one marked, a × each, and +', () => {
        const html = render(snap({ tabs: [tab('tynn', { title: 'Tynn' }), tab('moic')], active: 'moic' }));
        expect(html.match(/data-browser-tab="/g)).toHaveLength(2);
        expect(html).toMatch(/data-browser-tab="tynn"[^>]*>[\s\S]*?Tynn/);
        expect(html).toMatch(/data-browser-tab="moic"[^>]*data-current="true"/);
        expect(html).toContain('https://moic.gen/');
        expect(html.match(/data-browser-close="/g)).toHaveLength(2);
        expect(html).toContain('data-browser-new-tab');
    });
});

describe('the toolbar follows the ACTIVE tab', () => {
    it('back and forward as the page allows; the address is the page’s, in a text field with the lock', () => {
        const html = render(snap({ tabs: [tab('tynn', { canGoBack: true, url: 'https://tynn.gen/deals' })], active: 'tynn' }));
        expect(html).not.toMatch(/data-browser-nav="back"[^>]*disabled=""/);
        expect(html).toMatch(/data-browser-nav="forward"[^>]*disabled=""/);
        expect(html).toMatch(/<input[^>]*data-browser-address[^>]*/);
        expect(html).toMatch(/data-browser-address[^>]*value="https:\/\/tynn\.gen\/deals"|value="https:\/\/tynn\.gen\/deals"[^>]*data-browser-address/);
        expect(html).not.toMatch(/data-browser-address[^>]*type="url"|type="url"[^>]*data-browser-address/);
        expect(html).toContain('data-browser-lock');
    });

    it('the five device presets, the chosen one selected', () => {
        const html = render(snap({ tabs: [tab('tynn')], active: 'tynn', presetId: 'mobile' }));
        for (const p of presets) expect(html).toContain(p.label);
        expect(html).toMatch(/data-browser-presets[\s\S]*Mobile 390/);
    });
});

describe('the sites and what went wrong', () => {
    it('a chip per Genie site, the one on screen marked', () => {
        const html = render(snap({ tabs: [tab('tynn')], active: 'tynn' }));
        expect(html.match(/data-browser-site="/g)).toHaveLength(2);
        expect(html).toMatch(/data-browser-site="tynn\.gen"[^>]*aria-current="page"/);
    });

    it('the active tab’s failed load, and an address refused, are said in one line', () => {
        expect(render(snap({ tabs: [tab('tynn', { error: "Couldn't load https://tynn.gen/ (ERR_CONNECTION_REFUSED)." })], active: 'tynn' }))).toMatch(/data-browser-error[^>]*>Couldn(&#x27;|')t load https:\/\/tynn\.gen\/ \(ERR_CONNECTION_REFUSED\)\./);
        expect(render(snap(), { refusal: 'example.com is not an enabled tunnel on this host.' })).toMatch(/data-browser-error[^>]*>example\.com is not an enabled tunnel on this host\./);
        expect(render(snap({ tabs: [tab('tynn')], active: 'tynn' }))).not.toContain('data-browser-error');
    });
});

describe('the page box and the empty states (Genie 1)', () => {
    it('the box the view is placed over is always there', () => {
        expect(render(snap({ tabs: [tab('tynn')], active: 'tynn' }))).toContain('data-browser-page');
        expect(render(snap())).toContain('data-browser-page');
    });

    it('no tab: "No site open." with the way forward — pick a site, or that there are none yet', () => {
        const some = render(snap());
        expect(some).toContain('No site open.');
        expect(some).toContain('Pick a site above to open it.');
        const none = render(snap({ sites: [] }));
        expect(none).toContain('No site open.');
        expect(none).toContain('No Genie sites are being served.');
        expect(none).not.toContain('data-browser-site=');
    });

    it('CONTROL: with a tab open, no empty state', () => {
        expect(render(snap({ tabs: [tab('tynn')], active: 'tynn' }))).not.toContain('No site open.');
    });
});
