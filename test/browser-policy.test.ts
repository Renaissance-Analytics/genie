import { describe, expect, it } from 'vitest';
import { browserRoute, classifyNavigation, type GenRoute } from '../src/core/browser-policy.js';

/**
 * THE GENIE BROWSER (§6, the owner's list) — the pure half: what the in-app browser may open and
 * where a `.gen` navigation actually goes. The engine is Electron's own `WebContentsView` (there
 * is no second engine inside Electron, so that is not a decision); the policy is Genie's.
 *
 * Two rules carry the weight. A `.gen` host is a site at ITS OWN https origin (S7): the pane loads
 * `https://<name>.gen/…` — never the site's loopback target, whose 127.0.0.1 cookie jar every site
 * shared. And the browser opens WEB content only — `file:`, `javascript:`, `chrome:` and the app's
 * own `genie:` scheme are refused by name, because a browser pane that could load `file:///` is a
 * file reader with a renderer attached.
 */

const routes: GenRoute[] = [{ host: 'tynn.gen', target: '127.0.0.1:4101' }];

describe('what a navigation is', () => {
    it('a .gen site Genie serves → `site`, loaded at https://<name>.gen with its path and query — not its loopback target', () => {
        expect(classifyNavigation('https://tynn.gen/dashboard?x=1', routes)).toEqual({ kind: 'site', host: 'tynn.gen', url: 'https://tynn.gen/dashboard?x=1' });
        // http and a port on a .gen name are the same site at the same origin: the front door serves https on 443.
        expect(classifyNavigation('http://TYNN.gen:8080/a#b', routes)).toEqual({ kind: 'site', host: 'tynn.gen', url: 'https://tynn.gen/a#b' });
        expect(classifyNavigation('tynn.gen', routes)).toEqual({ kind: 'site', host: 'tynn.gen', url: 'https://tynn.gen/' });
    });

    it('two sites open at two origins whose HOSTS differ — cookies are kept per host, so a port apart is not apart', () => {
        const two: GenRoute[] = [{ host: 'site-a.gen', target: '127.0.0.1:4101' }, { host: 'site-b.gen', target: '127.0.0.1:4102' }];
        const [a, b] = ['site-a.gen', 'site-b.gen'].map((h) => new URL((classifyNavigation(h, two) as { url: string }).url));
        expect([a!.origin, b!.origin]).toEqual(['https://site-a.gen', 'https://site-b.gen']);
        expect(a!.hostname).not.toBe(b!.hostname);
        // Control: the same input is the same origin (the check above is not "everything differs").
        expect(new URL((classifyNavigation('https://site-a.gen/x', two) as { url: string }).url).origin).toBe(a!.origin);
    });

    it('control: a URL that is not .gen is loaded exactly as written — nothing about it is changed', () => {
        for (const url of ['https://example.com/docs?q=1#h', 'http://example.org/', 'http://localhost:5173/', 'http://127.0.0.1:4101/']) {
            expect(classifyNavigation(url, routes)).toEqual({ kind: 'web', url });
        }
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
