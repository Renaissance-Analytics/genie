import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { siteLabel, sitesThatFit } from '../src/core/browser-sites.js';
import { BrowserSitesRow } from '../src/renderer/components/BrowserSitesRow.js';
import { GenieBrowserChrome } from '../src/renderer/components/GenieBrowserChrome.js';
import type { BrowserSnapshot } from '../src/main/genie-browser-window.js';

/**
 * THE GENIE BROWSER'S SITE BAR IS ONE ROW (Tynn #709): what does not fit goes behind a "»" dropdown at the right edge; it
 * re-measures on resize; the current site stays marked; sites are labelled by workspace name, never by a raw host.
 */
describe('sitesThatFit: how many chips the row holds', () => {
    it('all of them when they fit, no "»" needed', () => {
        expect(sitesThatFit({ widths: [60, 60, 60], available: 200, moreWidth: 28, gap: 6 })).toBe(3);
    });
    it('else as many as leave room for the "»"', () => {
        // 60+6+60 = 126, + gap 6 + 28 = 160 <= 170; a third would need 226 + 34
        expect(sitesThatFit({ widths: [60, 60, 60], available: 170, moreWidth: 28, gap: 6 })).toBe(2);
    });
    it('none when not even one fits with the "»"; never negative; empty is zero', () => {
        expect(sitesThatFit({ widths: [90, 90], available: 100, moreWidth: 28, gap: 6 })).toBe(0);
        expect(sitesThatFit({ widths: [], available: 100, moreWidth: 28, gap: 6 })).toBe(0);
        expect(sitesThatFit({ widths: [60], available: 0, moreWidth: 28, gap: 6 })).toBe(0);
    });
    it('CONTROL: the exact fit of every chip with no "»" is all of them', () => {
        expect(sitesThatFit({ widths: [60, 60], available: 126, moreWidth: 28, gap: 6 })).toBe(2);
        expect(sitesThatFit({ widths: [60, 60], available: 125, moreWidth: 28, gap: 6 })).toBe(1);
    });
});

describe('siteLabel: the workspace name', () => {
    it('drops the .gen address suffix', () => {
        expect(siteLabel('tynn.gen')).toBe('tynn');
        expect(siteLabel('api.tynn.gen')).toBe('api.tynn');
        expect(siteLabel('plain')).toBe('plain');
    });
});

describe('the row', () => {
    const sites = ['tynn.gen', 'moic.gen', 'fancy.gen', 'genie.gen'];
    const html = (over: Partial<Parameters<typeof BrowserSitesRow>[0]> = {}) => renderToStaticMarkup(<BrowserSitesRow onMore={async () => null} sites={sites} current="moic.gen" onOpen={() => {}} {...over} />);

    it('is ONE row: no wrapping, clipped', () => {
        const h = html();
        expect(h).toContain('data-browser-sites=""');
        expect(h).toMatch(/data-browser-sites=""[^>]*class="[^"]*flex-nowrap[^"]*"/);
        expect(h).not.toMatch(/data-browser-sites=""[^>]*class="[^"]*flex-wrap/);
    });
    it('chips by workspace name, never the raw address as the label', () => {
        const h = html({ fit: 4 });
        expect(h.match(/data-browser-site="/g)).toHaveLength(4);
        expect(h).toMatch(/data-browser-site="tynn\.gen"[^>]*>[\s\S]*?>tynn</);
        expect(h).not.toMatch(/>tynn\.gen</);
    });
    it('the current site is marked', () => {
        expect(html({ fit: 4 })).toMatch(/data-browser-site="moic\.gen"[^>]*aria-current="page"/);
    });
    it('what does not fit sits behind a » at the right edge, saying how many', () => {
        const h = html({ fit: 2 });
        expect(h.match(/data-browser-site="/g)).toHaveLength(2);
        expect(h).toMatch(/data-browser-sites-more=""[^>]*aria-label="2 more sites"/);
        expect(h).toContain('»');
    });
    it('CONTROL: everything fits, no »', () => {
        expect(html({ fit: 4 })).not.toContain('data-browser-sites-more');
    });
    it('the » is marked when the current site is behind it', () => {
        expect(html({ fit: 1, current: 'genie.gen' })).toMatch(/data-browser-sites-more=""[^>]*data-current="true"/);
        expect(html({ fit: 1, current: 'tynn.gen' })).not.toMatch(/data-browser-sites-more=""[^>]*data-current/);
    });
});

describe('the chrome uses it', () => {
    const presets = [{ id: 'fit', label: 'Fit' }];
    const snap: BrowserSnapshot = { notice: null, tabs: [], active: null, presetId: 'fit', presets, sites: ['tynn.gen', 'moic.gen'] };
    it('one sites row inside the chrome, the same data hook', () => {
        const h = renderToStaticMarkup(<GenieBrowserChrome onSitesMenu={async () => null} snapshot={snap} refusal={null} onNavigate={() => {}} onOpen={() => {}} onActivate={() => {}} onClose={() => {}} onNewTab={() => {}} onBack={() => {}} onForward={() => {}} onReload={() => {}} onPreset={() => {}} />);
        expect(h.match(/data-browser-sites=""/g)).toHaveLength(1);
    });
});
