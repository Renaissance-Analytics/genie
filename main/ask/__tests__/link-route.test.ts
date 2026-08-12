import { describe, expect, it, vi } from 'vitest';
import { routeAskLink, wireAskLinkRouting } from '../link-route';
import type { AskLinkDeps, NavigatingWebContents } from '../link-route';

/**
 * Bug: a link in the ForceTheQuestion modal (rendered from the question
 * markdown) navigated the frameless modal window itself — the modal became a
 * browser tab showing the link. It must never navigate; a `.gen` link opens in
 * the Genie Browser (unless the user turned it off, then the machine browser),
 * and every other link opens in the machine browser.
 *
 * The decision is pure (`routeAskLink`); the window wiring
 * (`wireAskLinkRouting`) is proven with a fake webContents so the
 * preventDefault + dispatch is asserted without an Electron window.
 */

const CUR = 'http://localhost:8888/ask';

describe('routeAskLink', () => {
    it('routes a .gen link to the Genie Browser when it is enabled', () => {
        expect(
            routeAskLink('https://civi.gen/civic-commons/courses/understanding-impactivism', {
                currentUrl: CUR,
                genieBrowserEnabled: true,
            }),
        ).toEqual({
            action: 'genie-browser',
            url: 'https://civi.gen/civic-commons/courses/understanding-impactivism',
        });
    });

    it('routes a .gen link to the machine browser when the Genie Browser is OFF', () => {
        expect(routeAskLink('https://tynn.gen/docs', { currentUrl: CUR, genieBrowserEnabled: false })).toEqual({
            action: 'external',
            url: 'https://tynn.gen/docs',
        });
    });

    it('routes an ordinary web link to the machine browser', () => {
        expect(
            routeAskLink('https://github.com/Renaissance-Analytics/genie', {
                currentUrl: CUR,
                genieBrowserEnabled: true,
            }),
        ).toMatchObject({ action: 'external', url: 'https://github.com/Renaissance-Analytics/genie' });
    });

    it('does not treat a non-.gen host that merely contains "gen" as a Genie site', () => {
        expect(routeAskLink('https://gen.example.com/x', { currentUrl: CUR, genieBrowserEnabled: true })).toMatchObject({
            action: 'external',
        });
    });

    it('allows navigation that stays on the app origin (dev HMR reload)', () => {
        expect(routeAskLink('http://localhost:8888/ask', { currentUrl: CUR, genieBrowserEnabled: true })).toEqual({
            action: 'allow',
        });
    });

    it('drops a non-http(s) link rather than navigating or shelling out to it', () => {
        expect(routeAskLink('javascript:alert(1)', { currentUrl: CUR, genieBrowserEnabled: true })).toEqual({
            action: 'drop',
        });
        expect(routeAskLink('file:///etc/passwd', { currentUrl: CUR, genieBrowserEnabled: true })).toEqual({
            action: 'drop',
        });
    });

    it('drops an unparseable URL', () => {
        expect(routeAskLink('http://[::bad', { currentUrl: CUR, genieBrowserEnabled: true })).toEqual({
            action: 'drop',
        });
    });

    it('is case-insensitive about the .gen suffix', () => {
        expect(routeAskLink('https://CIVI.GEN/x', { currentUrl: CUR, genieBrowserEnabled: true })).toMatchObject({
            action: 'genie-browser',
        });
    });
});

/** A minimal fake of the electron webContents surface the wiring touches. */
function fakeWebContents(currentUrl = CUR) {
    let navHandler: ((e: { preventDefault(): void }, url: string) => void) | undefined;
    let openHandler: ((d: { url: string }) => { action: 'deny' | 'allow' }) | undefined;
    const wc: NavigatingWebContents = {
        getURL: () => currentUrl,
        on: (event, listener) => {
            if (event === 'will-navigate') navHandler = listener;
            return wc;
        },
        setWindowOpenHandler: (handler) => {
            openHandler = handler;
        },
    };
    return {
        wc,
        navigate: (url: string) => {
            const e = { preventDefault: vi.fn() };
            navHandler?.(e, url);
            return e;
        },
        openWindow: (url: string) => openHandler?.({ url }),
    };
}

function deps(over: Partial<AskLinkDeps> = {}): AskLinkDeps & {
    openExternal: ReturnType<typeof vi.fn>;
    openGenieBrowser: ReturnType<typeof vi.fn>;
} {
    return {
        genieBrowserEnabled: () => true,
        openExternal: vi.fn(),
        openGenieBrowser: vi.fn(),
        ...over,
    } as AskLinkDeps & { openExternal: ReturnType<typeof vi.fn>; openGenieBrowser: ReturnType<typeof vi.fn> };
}

describe('wireAskLinkRouting', () => {
    it('PREVENTS the modal navigating to an external link and opens the machine browser', () => {
        const f = fakeWebContents();
        const d = deps();
        wireAskLinkRouting(f.wc, d);
        const e = f.navigate('https://github.com/x');
        expect(e.preventDefault).toHaveBeenCalled();
        expect(d.openExternal).toHaveBeenCalledWith('https://github.com/x');
        expect(d.openGenieBrowser).not.toHaveBeenCalled();
    });

    it('PREVENTS navigation and opens a .gen link in the Genie Browser', () => {
        const f = fakeWebContents();
        const d = deps();
        wireAskLinkRouting(f.wc, d);
        const e = f.navigate('https://civi.gen/x');
        expect(e.preventDefault).toHaveBeenCalled();
        expect(d.openGenieBrowser).toHaveBeenCalledWith('https://civi.gen/x');
    });

    it('lets a same-origin navigation proceed without preventDefault', () => {
        const f = fakeWebContents();
        const d = deps();
        wireAskLinkRouting(f.wc, d);
        const e = f.navigate('http://localhost:8888/ask');
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(d.openExternal).not.toHaveBeenCalled();
    });

    it('denies window.open and routes the URL instead', () => {
        const f = fakeWebContents();
        const d = deps();
        wireAskLinkRouting(f.wc, d);
        const decision = f.openWindow('https://civi.gen/x');
        expect(decision).toEqual({ action: 'deny' });
        expect(d.openGenieBrowser).toHaveBeenCalledWith('https://civi.gen/x');
    });

    it('honours the Genie-Browser-off setting for a .gen window-open too', () => {
        const f = fakeWebContents();
        const d = deps({ genieBrowserEnabled: () => false });
        wireAskLinkRouting(f.wc, d);
        f.openWindow('https://tynn.gen/x');
        expect(d.openExternal).toHaveBeenCalledWith('https://tynn.gen/x');
        expect(d.openGenieBrowser).not.toHaveBeenCalled();
    });
});
