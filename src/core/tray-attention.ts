/**
 * THE TRAY'S "THE DECK NEEDS YOU" DOT (the owner, 2026-10-26: "the icon should change in the system tray if I have items
 * in the deck needing the user attention"). Genie's own mark with a solid dot in its bottom-right corner, drawn into a
 * copy of the mark's bitmap — pure, so it is tested without a window. The bitmap's channel order is the platform's
 * (Electron's `toBitmap` is BGRA on Windows and Linux); the dot is the same red either way.
 */

/** The dot's colour: Genie's danger red (#ef4444). */
export const ATTENTION_RGB: readonly [number, number, number] = [0xef, 0x44, 0x44];

/**
 * A copy of `bitmap` (`width`×`height`, 4 bytes a pixel, in `order`) with a solid dot in the bottom-right corner. The dot
 * is about 40% of the mark's width, so it reads at 16px and scales with a larger mark.
 */
export function withAttentionDot(bitmap: Uint8Array, width: number, height: number, order: 'bgra' | 'rgba'): Uint8Array {
    const out = new Uint8Array(bitmap);
    const radius = Math.max(2, Math.round(width * 0.2));
    const cx = width - radius - 0.5;
    const cy = height - radius - 0.5;
    const [r, g, b] = ATTENTION_RGB;
    const colour = order === 'bgra' ? [b, g, r, 255] : [r, g, b, 255];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const dx = x + 0.5 - (cx + 0.5);
            const dy = y + 0.5 - (cy + 0.5);
            if (dx * dx + dy * dy > radius * radius) continue;
            out.set(colour, (y * width + x) * 4);
        }
    }
    return out;
}
