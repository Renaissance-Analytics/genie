import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrowserSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * THE GENIE BROWSER'S CHROME (S7): back, forward and reload — enabled only when the pane's own history allows — and
 * this machine's sites, each a button that opens it at its own https origin. Rendered to markup; the page itself is
 * a WebContentsView main places over the box, so it is not here.
 */

const routes = [{ host: 'site-a.gen', target: '127.0.0.1:4101' }, { host: 'site-b.gen', target: '127.0.0.1:4102' }];
const render = (browser: Partial<FeatureData['browser']>) =>
    renderToStaticMarkup(<BrowserSurface data={{ ...EMPTY_FEATURES, browser: { ...EMPTY_FEATURES.browser, ...browser } }} onAction={() => {}} onNavigate={() => {}} />);
const disabled = (html: string, which: string) => new RegExp(`<button[^>]*data-browser-nav="${which}"[^>]*disabled=""`).test(html) || new RegExp(`<button[^>]*disabled=""[^>]*data-browser-nav="${which}"`).test(html);

describe('back, forward, reload', () => {
    it('all three are there; with no page and no history all three are disabled', () => {
        const html = render({});
        expect(html.match(/data-browser-nav="(back|forward|reload)"/g)).toHaveLength(3);
        expect(['back', 'forward', 'reload'].filter((w) => disabled(html, w))).toHaveLength(3);
    });

    it('each is enabled exactly when the pane says so — counted against the same markup', () => {
        const html = render({ url: 'https://site-a.gen/', routes, canGoBack: true, canGoForward: false });
        expect(['back', 'forward', 'reload'].filter((w) => disabled(html, w))).toEqual(['forward']);
    });
});

describe('this machine’s sites', () => {
    it('one button per site, none when there are none; the open one is marked current', () => {
        expect(render({}).match(/data-browser-site=/g)).toBeNull();
        const html = render({ url: 'https://site-b.gen/x', routes });
        expect(html.match(/data-browser-site="[a-z0-9.-]+"/g)).toEqual(['data-browser-site="site-a.gen"', 'data-browser-site="site-b.gen"']);
        expect(html.match(/aria-current="page"[^>]*data-browser-site="([a-z0-9.-]+)"|data-browser-site="([a-z0-9.-]+)"[^>]*aria-current="page"/g)).toHaveLength(1);
        expect(html).toMatch(/data-browser-site="site-b\.gen"[^>]*aria-current="page"|aria-current="page"[^>]*data-browser-site="site-b\.gen"/);
    });
});
