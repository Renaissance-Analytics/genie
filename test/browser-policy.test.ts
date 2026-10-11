import { describe, expect, it } from 'vitest';
import { browserRoute, classifyNavigation, type GenRoute } from '../src/core/browser-policy.js';

/**
 * THE GENIE BROWSER (§6, the owner's list) — the pure half: what the in-app browser may open and
 * where a `.gen` navigation actually goes. The engine is Electron's own `WebContentsView` (there
 * is no second engine inside Electron, so that is not a decision); the policy is Genie's.
 *
 * Two rules carry the weight. A `.gen` host is served by the front door, so the browser rewrites
 * it to the site's loopback target and keeps the `.gen` name in the address bar. And the browser
 * opens WEB content only — `file:`, `javascript:`, `chrome:` and the app's own `genie:` scheme are
 * refused by name, because a browser pane that could load `file:///` is a file reader with a
 * renderer attached.
 */

const routes: GenRoute[] = [{ host: 'tynn.gen', target: '127.0.0.1:4101' }];

describe('what a navigation is', () => {
    it('a .gen site Genie serves → `site`, rewritten to its loopback target with the Host kept', () => {
        expect(classifyNavigation('http://tynn.gen/dashboard?x=1', routes)).toEqual({
            kind: 'site',
            host: 'tynn.gen',
            url: 'http://127.0.0.1:4101/dashboard?x=1',
            hostHeader: 'tynn.gen',
        });
        // https on a .gen name is the same site — the front door is loopback http.
        expect(classifyNavigation('https://TYNN.gen/', routes)).toMatchObject({ kind: 'site', url: 'http://127.0.0.1:4101/' });
    });

    it('a .gen site nobody serves → `no-site`, naming it, so the pane can offer to create it', () => {
        expect(classifyNavigation('http://ghost.gen/', routes)).toEqual({ kind: 'no-site', host: 'ghost.gen' });
    });

    it('ordinary web content → `web`, as written', () => {
        expect(classifyNavigation('https://example.com/docs', routes)).toEqual({ kind: 'web', url: 'https://example.com/docs' });
        expect(classifyNavigation('http://localhost:5173/', routes)).toEqual({ kind: 'web', url: 'http://localhost:5173/' });
    });

    it('bare text becomes an https URL or a .gen site; it is never guessed into a file path', () => {
        expect(classifyNavigation('example.com', routes)).toEqual({ kind: 'web', url: 'https://example.com/' });
        expect(classifyNavigation('tynn.gen', routes)).toMatchObject({ kind: 'site', host: 'tynn.gen' });
    });

    it('refuses non-web schemes BY NAME — counted, so one missing from the list fails here', () => {
        const refused = ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'genie://dashboard', 'data:text/html,<b>x</b>', 'about:blank'].map((u) => classifyNavigation(u, routes));
        expect(refused.filter((r) => r.kind === 'refused')).toHaveLength(6);
        expect(refused[0]).toMatchObject({ kind: 'refused', scheme: 'file', reason: expect.stringMatching(/file/) });
    });

    it('a .gen route to a non-loopback target is NOT followed — the policy trusts the front door’s rule', () => {
        expect(classifyNavigation('http://evil.gen/', [{ host: 'evil.gen', target: '10.0.0.5:80' }])).toEqual({ kind: 'no-site', host: 'evil.gen' });
    });
});

describe('the browser route — state in the URL, back-button compatible', () => {
    it('encodes the page the pane shows, and parses it back', () => {
        expect(browserRoute.format({ url: 'http://tynn.gen/dashboard?x=1' })).toBe('genie://browser?url=http%3A%2F%2Ftynn.gen%2Fdashboard%3Fx%3D1');
        expect(browserRoute.parse('genie://browser?url=http%3A%2F%2Ftynn.gen%2Fdashboard%3Fx%3D1')).toEqual({ url: 'http://tynn.gen/dashboard?x=1' });
    });

    it('an empty browser is a route with no url, and a malformed one parses to null', () => {
        expect(browserRoute.format({})).toBe('genie://browser');
        expect(browserRoute.parse('genie://browser')).toEqual({});
        expect(browserRoute.parse('genie://deck')).toBeNull();
    });
});
