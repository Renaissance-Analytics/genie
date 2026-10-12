import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TitleBar } from '../src/renderer/components/TitleBar.js';

/**
 * THE BAR IS THE DRAG REGION. With the OS title bar hidden, the window moves only by the part of our
 * bar that says so; on the owner's first run of 2.0.0-beta.5 nothing did, and the window could not be
 * moved. Every control inside the bar opts out, or a click on the palette would start a drag. The
 * right end leaves room for the native window buttons the overlay draws there.
 */
describe('TitleBar drag region', () => {
    const html = renderToStaticMarkup(
        <TitleBar route="genie://dashboard" workstation={{ name: 'alphar', healthy: true }} onNavigate={() => {}} onOpenPalette={() => {}} />,
    );

    it('the bar itself is draggable', () => {
        expect(html).toMatch(/<div[^>]*data-title-bar[^>]*class="[^"]*\[-webkit-app-region:drag\]/);
    });

    it('the brand mark, the feature icons and the palette are NOT — a click there must act, not drag', () => {
        for (const control of ['data-nav="genie://dashboard"', 'data-feature=', 'data-palette="true"']) {
            const at = html.indexOf(control);
            expect(at, control).toBeGreaterThan(-1);
            const tag = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at));
            expect(tag, control).toContain('[-webkit-app-region:no-drag]');
        }
    });

    it('leaves room on the right for the native window controls the overlay draws', () => {
        expect(html).toMatch(/data-title-bar[^>]*style="[^"]*padding-right:\s*calc\(100% - env\(titlebar-area-width,\s*100%\)\)/);
    });
});
