import { describe, expect, it } from 'vitest';
import { gappWindowTitle } from '../window-title';

/**
 * `[{GApp Name}] - {window.title}` (owner, 2026-08-22).
 *
 * Two requirements meet in this one string and they pull against each other. The
 * prefix is what GROUPS a GApp's windows: an app with three hosted repos has three
 * windows, and `[Trader]` on all of them is what says they are one app. The suffix
 * is whatever the hosted page called itself, live, so a window says which part of
 * the app you are looking at.
 *
 * And URLS ARE NEVER EXPOSED — no address bar, no origin anywhere. That is the
 * constraint the title has to survive, because Chromium hands a page with no
 * `<title>` its own URL as `document.title`. Left alone, the least-finished page
 * in an app would be the one that puts its address in the window chrome.
 */
describe('gappWindowTitle', () => {
    it('prefixes the app’s name and carries the page’s own title', () => {
        expect(gappWindowTitle('Trader', 'Positions')).toBe(
            '[Trader] - Positions',
        );
    });

    it('is just the app when the page has not said anything', () => {
        // Not `[Trader] - Trader`: a title repeating itself reads as a bug, and
        // the prefix alone is the honest answer to "which window is this?".
        expect(gappWindowTitle('Trader', '')).toBe('[Trader]');
        expect(gappWindowTitle('Trader', '   ')).toBe('[Trader]');
    });

    it('refuses a title that is really the page’s URL', () => {
        // Chromium's default `document.title` for a page with no `<title>` is its
        // own URL. Passing that through would put the origin in the window chrome
        // of exactly the pages a developer has not finished yet — the URL leak
        // arriving by the back door, in the one place nobody thinks to look.
        expect(gappWindowTitle('Trader', 'trader.gapp')).toBe('[Trader]');
        expect(gappWindowTitle('Trader', 'trader.gapp/positions')).toBe(
            '[Trader]',
        );
        expect(gappWindowTitle('Trader', 'https://trader.gapp/positions')).toBe(
            '[Trader]',
        );
    });

    it('refuses a title carrying ANY origin, not only this app’s', () => {
        // A page can set its own title to anything, and an app that wrote a URL
        // into it would put an address in Genie's chrome just as effectively as
        // Chromium's default did. The rule is about the window, not about trust.
        expect(gappWindowTitle('Trader', 'https://example.com/thing')).toBe(
            '[Trader]',
        );
        expect(gappWindowTitle('Trader', 'localhost:5173')).toBe('[Trader]');
    });

    it('keeps a real title that merely mentions a dot', () => {
        // The URL test must not be so eager that it eats ordinary prose. A title
        // is the app's voice and losing it is a real cost, so only something that
        // parses as a host or a URL is dropped.
        expect(gappWindowTitle('Trader', 'Trader v2.1')).toBe(
            '[Trader] - Trader v2.1',
        );
        expect(gappWindowTitle('Trader', 'P&L · today')).toBe(
            '[Trader] - P&L · today',
        );
    });

    it('keeps the prefix stable however odd the app’s name is', () => {
        // The prefix is a grouping key: every window of one app must carry the
        // same bytes, or they stop reading as one app's windows.
        expect(gappWindowTitle('My App [beta]', 'Home')).toBe(
            '[My App [beta]] - Home',
        );
    });

    it('trims, so a page padding its title does not shift the separator', () => {
        expect(gappWindowTitle('Trader', '  Positions  ')).toBe(
            '[Trader] - Positions',
        );
    });
});
