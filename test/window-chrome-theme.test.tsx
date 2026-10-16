import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CONTROLS_FALLBACK_INSET, controlsInset, overlayColorsOk } from '../src/core/window.js';
import { TitleBar } from '../src/renderer/components/TitleBar.js';

/**
 * THE HEADER ROW, DESIGNED PROPERLY (the owner, 2026-10-13, with a screenshot: the native minimize / maximize / close
 * buttons drawn black over a light header, covering the workstation chip — "I am seeing content covered and not following
 * color theme"). Two causes:
 *  - the overlay's colours were fixed at window creation (`#0a0a0c` on `#e4e4e7`) and never followed the theme;
 *  - the bar kept its right end clear with `env(titlebar-area-width)`, which resolved to nothing in that window, so the
 *    chip slid under the buttons.
 * Now the space is MEASURED (Electron's `navigator.windowControlsOverlay` rect, re-read on `geometrychange`) and handed
 * to the bar as pixels, with the Windows caption cluster's width as the fallback for a window that has the overlay; and
 * the theme's own bar colours (`--bg-1`, `--fg-2`) are sent to the window whenever the theme changes.
 */
describe('the space the native buttons take', () => {
    it('measured: the viewport width less the title-bar area’s right edge', () => {
        expect(controlsInset({ x: 0, width: 1302 }, 1440, true)).toBe(138);
        expect(controlsInset({ x: 0, width: 1440 }, 1440, true)).toBe(0);
    });

    it('not measurable on a window that HAS the overlay: the caption cluster’s width; no overlay: nothing', () => {
        expect(CONTROLS_FALLBACK_INSET).toBe(138);
        expect(controlsInset(null, 1440, true)).toBe(CONTROLS_FALLBACK_INSET);
        expect(controlsInset(null, 1440, false)).toBe(0);
        // A rect that claims more than the viewport is not a measurement to trust.
        expect(controlsInset({ x: 0, width: 2000 }, 1440, true)).toBe(CONTROLS_FALLBACK_INSET);
    });

    it('the bar keeps exactly that space clear at its right — nothing sits under the buttons (positive control: 0 keeps none)', () => {
        const bar = (inset: number) => renderToStaticMarkup(<TitleBar route="genie://dashboard" workstation={{ name: 'AlphaRig', healthy: true }} onNavigate={() => {}} onOpenPalette={() => {}} controlsInset={inset} />);
        expect(bar(138)).toMatch(/data-title-bar="[^"]*"[^>]*data-controls-inset="138"[^>]*style="[^"]*padding-right:\s*calc\(138px \+ 10px\)/);
        expect(bar(0)).toMatch(/data-controls-inset="0"/);
        expect(bar(138)).not.toContain('titlebar-area-width');
    });
});

describe('the buttons follow the theme', () => {
    it('only plain #rrggbb colours reach the window', () => {
        expect(overlayColorsOk('#fafafa', '#3f3f46')).toBe(true);
        expect(overlayColorsOk('oklch(0.98 0 0)', '#000000')).toBe(false);
        expect(overlayColorsOk('#fff', '#000000')).toBe(false);
        expect(overlayColorsOk('#fafafa', 'red; drop')).toBe(false);
    });

    it('main applies them to the sender’s window; the renderer sends the theme’s bar colours when the theme changes', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).toMatch(/ipcMain\.handle\('genie:window-overlay-colors'[\s\S]{0,400}overlayColorsOk\([\s\S]{0,300}setTitleBarOverlay\(/);
        const preload = readFileSync('src/main/preload.ts', 'utf8');
        expect(preload).toMatch(/'genie:window-overlay-colors'/);
        const chrome = readFileSync('src/renderer/window-chrome.ts', 'utf8');
        expect(chrome).toMatch(/--bg-1/);
        expect(chrome).toMatch(/--fg-2/);
        expect(chrome).toMatch(/MutationObserver/);
        expect(chrome).toMatch(/windowControlsOverlay/);
        expect(chrome).toMatch(/geometrychange/);
    });
});
