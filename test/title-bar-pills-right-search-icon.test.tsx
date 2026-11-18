import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveFlow } from '../src/core/flow-pills.js';
import { TitleBar } from '../src/renderer/components/TitleBar.js';

/**
 * THE OWNER, beta.65 (screenshot: a running-flow pill LEFT of `genie://AlphaR/flows`): "this is awesome but
 * on the wrong side. these should be on the right side of the view address. Also lets get rid of the search box and just
 * have a small icon button left of the Gapps menu."
 *
 * So: the running-flow pills (Tynn #707) sit RIGHT of the address; the 280px "Search, jump, run" box is gone, and a small
 * search icon button sits immediately LEFT of the GApps button, opening the same Command Window (Ctrl+K still does — that
 * is App's own keydown listener, command-window.test). Claims about MARKUP only: order, handles and classes, not pixels.
 */
const NOW = 1_000_000;
const live = (id: string): LiveFlow => ({ flowId: id, name: `Flow ${id}`, workspaceId: 'w1', at: new Date(NOW - 1000).toISOString() });
const flows = { live: [live('a')], ended: [], now: NOW, onOpen: () => {} };

const bar = (extra: object = {}): string => renderToStaticMarkup(
    <TitleBar route="genie://AlphaR/flows" workstation={{ name: 'AlphaR', healthy: true }} onNavigate={() => {}} onOpenPalette={() => {}} platform="generic" {...extra} />,
);
const tag = (html: string, attr: string): string => html.match(new RegExp(`<[a-z]+[^>]*${attr}[^>]*>`))![0];

describe('the running-flow pills sit RIGHT of the view address', () => {
    it('the address comes first, then the pills', () => {
        const html = bar({ flows });
        const route = html.indexOf('data-route');
        const pills = html.indexOf('data-flow-pills');
        expect(route).toBeGreaterThan(-1);
        expect(pills).toBeGreaterThan(-1);
        expect(route).toBeLessThan(pills);
    });

    it('a flow starting or ending moves nothing left of the address (no layout jump)', () => {
        const without = bar();
        const withPills = bar({ flows });
        // Everything up to the address is the same markup whether or not a flow is running.
        expect(withPills.slice(0, withPills.indexOf('data-route'))).toBe(without.slice(0, without.indexOf('data-route')));
        // POSITIVE CONTROL: the pills are in the second render, so the equality above is about their place.
        expect(withPills).toContain('data-flow-pill="a"');
        expect(without).not.toContain('data-flow-pill=');
    });

    it('a narrow bar truncates the address first; a spacer keeps the chips at the right end', () => {
        const html = bar({ flows, remote: { host: 'BetaR', driver: null, driving: true, locked: false } });
        expect(tag(html, 'data-route')).toMatch(/\bmin-w-0\b/);
        expect(tag(html, 'data-route')).toMatch(/\btruncate\b/);
        const spacer = html.indexOf('data-title-spacer');
        expect(spacer).toBeGreaterThan(html.indexOf('data-flow-pills'));
        expect(spacer).toBeLessThan(html.indexOf('data-remote-badge'));
        expect(spacer).toBeLessThan(html.indexOf('data-workstation-health'));
        expect(tag(html, 'data-title-spacer')).toMatch(/\bflex-1\b/);
    });
});

describe('the search box is a small icon button left of GApps', () => {
    it('no 280px box and no visible "Search, jump, run" text', () => {
        const html = bar();
        expect(html).not.toContain('w-[280px]');
        expect(html).not.toMatch(/>Search, jump, run</);
    });

    it('the search button is a 24px icon button, and the very next button is GApps', () => {
        const html = bar();
        const palette = html.indexOf('data-palette="true"');
        const gapps = html.indexOf('data-feature="GApps"');
        expect(palette).toBeGreaterThan(-1);
        expect(gapps).toBeGreaterThan(palette);
        // From the search button's own tag up to GApps' own tag, exactly one button opens: the search button itself.
        const between = html.slice(html.lastIndexOf('<button', palette), html.lastIndexOf('<button', gapps));
        expect([...between.matchAll(/<button\b/g)]).toHaveLength(1);
        const own = tag(html, 'data-palette="true"');
        expect(own).toMatch(/\bsize-6\b/);
        expect(own).toContain('[-webkit-app-region:no-drag]');
    });

    it('its name says what it does and the key that opens it, as the box did', () => {
        expect(tag(bar(), 'data-palette="true"')).toContain('aria-label="Search, jump, run (Ctrl K)"');
        expect(tag(bar({ platform: 'apple' }), 'data-palette="true"')).toContain('aria-label="Search, jump, run (⌘K)"');
        expect(tag(bar({ paletteKey: 'CommandOrControl+Shift+P' }), 'data-palette="true"')).toContain('Ctrl+Shift+P');
    });

    it('CONTROL: a workspace window still has no search button', () => {
        expect(bar({ scopedHome: 'genie://workspace/w1' })).not.toContain('data-palette');
        expect(bar()).toContain('data-palette');
    });
});

describe('the window-controls safe area holds (#2003, #726)', () => {
    it('the measured inset still pads the right end, with pills and a remote badge in the bar', () => {
        const html = bar({ flows, controlsInset: 138, remote: { host: 'BetaR', driver: null, driving: true, locked: false } });
        expect(html).toMatch(/data-title-bar[^>]*style="[^"]*padding-right:\s*calc\(138px \+ 10px\)/);
    });
});
