import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HostingSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData, type FrontDoorStatus } from '../src/renderer/features.js';

/**
 * THE FRONT DOOR'S LINES IN HOSTING — each a fact with its fix beside it, shown ONLY when true
 * (§4.5's signal rule): the certificate not yet trusted offers the one-click trust; a declined
 * hosts-file prompt shows the error, the block to paste and where, and a retry; no bundled Caddy
 * says so. All quiet → no line at all, never "everything fine" furniture.
 */

const running: FrontDoorStatus = { running: true, caddyfile: '/h/.genie/runtime/caddy/Caddyfile', hostsPath: '/etc/hosts', hosts: { changed: false, elevated: false }, trusted: true };
const render = (frontDoor: FrontDoorStatus) =>
    renderToStaticMarkup(<HostingSurface data={{ ...EMPTY_FEATURES, hosting: { sites: [], processes: [], adding: null, frontDoor } } as FeatureData} onAction={() => {}} onNavigate={() => {}} />);
const lines = (html: string) => html.match(/data-frontdoor-line="[a-z-]+"/g) ?? [];

describe('the front door lines', () => {
    it('all quiet: no line at all', () => {
        expect(lines(render(running))).toEqual([]);
    });

    it('not trusted: one line with the Trust certificate action', () => {
        const html = render({ ...running, trusted: false });
        expect(lines(html)).toEqual(['data-frontdoor-line="trust"']);
        expect(html).toMatch(/Trust certificate/);
        expect(html).toMatch(/ask for permission once/);
    });

    it('a declined hosts-file prompt: the error, the block to paste, where it goes, and Try again', () => {
        const html = render({ ...running, hosts: { changed: false, elevated: false, error: 'Request dismissed', manualBlock: '# >>> genie .gen sites — managed, do not edit between the markers\n127.0.0.1 docs.gen\n# <<< genie .gen sites' } });
        expect(lines(html)).toEqual(['data-frontdoor-line="hosts"']);
        expect(html).toMatch(/Request dismissed/);
        expect(html).toContain('data-manual-block');
        expect(html).toMatch(/127\.0\.0\.1 docs\.gen/);
        expect(html).toMatch(/\/etc\/hosts/);
        expect(html).toMatch(/Try again/);
    });

    it('no bundled Caddy: the reason, and nothing to click', () => {
        const html = render({ running: false, reason: 'this install has no bundled Caddy; https://<name>.gen in external browsers is off, the in-app browser still works' });
        expect(lines(html)).toEqual(['data-frontdoor-line="off"']);
        expect(html).toMatch(/no bundled Caddy/);
        expect(html).not.toMatch(/Trust certificate|Try again/);
    });
});
