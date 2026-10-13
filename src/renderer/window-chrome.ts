import { useEffect, useState } from 'react';
import { controlsInset } from '../core/window.js';

/**
 * THE NATIVE WINDOW BUTTONS, FITTED TO THE HEADER (the owner, 2026-10-13: "content covered and not following color
 * theme"). Windows and Linux draw minimize / maximize / close over the right end of Genie's 36 px bar.
 *
 *  - THE SPACE: measured from Electron's `navigator.windowControlsOverlay` title-bar area (re-read on `geometrychange`
 *    and on resize), handed to the bar as pixels — `env(titlebar-area-width)` resolved to nothing in a real window.
 *  - THE COLOURS: the theme's own bar colours (`--bg-1` behind, `--fg-2` for the symbols), resolved to `#rrggbb` and sent
 *    to the window whenever the theme changes (the `dark` class on <html>, which Fancy flips for light, dark and system).
 */
interface OverlayApi {
    readonly visible: boolean;
    getTitlebarAreaRect(): { x: number; width: number };
    addEventListener(type: 'geometrychange', listener: () => void): void;
    removeEventListener(type: 'geometrychange', listener: () => void): void;
}

const overlayApi = (): OverlayApi | null =>
    (typeof navigator !== 'undefined' ? ((navigator as unknown as { windowControlsOverlay?: OverlayApi }).windowControlsOverlay ?? null) : null);

/** The width the native buttons take at the right of the bar; 0 where there are none. */
export function useControlsInset(hasOverlay: boolean): number {
    const read = (): number => {
        const api = overlayApi();
        const rect = api && api.visible ? api.getTitlebarAreaRect() : null;
        return controlsInset(rect && rect.width > 0 ? rect : null, typeof window === 'undefined' ? 0 : window.innerWidth, hasOverlay);
    };
    const [inset, setInset] = useState<number>(() => (hasOverlay ? read() : 0));
    useEffect(() => {
        if (!hasOverlay) { setInset(0); return; }
        const update = () => setInset(read());
        update();
        const api = overlayApi();
        api?.addEventListener('geometrychange', update);
        window.addEventListener('resize', update);
        return () => { api?.removeEventListener('geometrychange', update); window.removeEventListener('resize', update); };
    }, [hasOverlay]);
    return inset;
}

/** Any CSS colour the page can paint (the tokens may be oklch), as `#rrggbb`: painted on a 1×1 canvas and read back. */
function toHex(cssColor: string): string | null {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx || !cssColor.trim()) return null;
    ctx.fillStyle = '#000000';
    ctx.fillStyle = cssColor.trim();
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((n) => (n ?? 0).toString(16).padStart(2, '0')).join('')}`;
}

/** Send the theme's bar colours to the window now and on every theme change. */
export function useOverlayColors(chrome: { readonly overlay: boolean; setOverlayColors(color: string, symbolColor: string): Promise<boolean> } | undefined): void {
    useEffect(() => {
        if (!chrome?.overlay || typeof document === 'undefined') return;
        let last = '';
        const send = () => {
            const styles = getComputedStyle(document.documentElement);
            const color = toHex(styles.getPropertyValue('--bg-1'));
            const symbol = toHex(styles.getPropertyValue('--fg-2'));
            if (!color || !symbol || `${color}${symbol}` === last) return;
            last = `${color}${symbol}`;
            void chrome.setOverlayColors(color, symbol);
        };
        send();
        const observer = new MutationObserver(send);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
        return () => observer.disconnect();
    }, [chrome]);
}
