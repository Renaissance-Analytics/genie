import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ATTENTION_RGB, withAttentionDot } from '../src/core/tray-attention.js';
import { trayTooltip } from '../src/main/tray.js';

/**
 * THE TRAY SAYS THE DECK NEEDS YOU (the owner, 2026-10-26: "the icon should change in the system tray if I have items in
 * the deck needing the user attention"). The tray's icon was set once at start and never changed. Now, while the Deck
 * has items WAITING on the person — `needsYouCount`, the very number the Deck's own badge shows (never a finished agent,
 * never a stale question) — the tray shows Genie's mark with a dot, and its tooltip says how many; when the Deck is clear
 * it is the plain mark again.
 */

const W = 16;
const H = 16;
const px = (buf: Uint8Array, x: number, y: number) => Array.from(buf.slice((y * W + x) * 4, (y * W + x) * 4 + 4));

describe('the dot', () => {
    const blank = () => new Uint8Array(W * H * 4); // fully transparent

    it('a solid dot in the bottom-right corner, in the platform bitmap order (BGRA on Windows/Linux, RGBA elsewhere)', () => {
        const [r, g, b] = ATTENTION_RGB;
        const bgra = withAttentionDot(blank(), W, H, 'bgra');
        expect(px(bgra, W - 3, H - 3)).toEqual([b, g, r, 255]);
        const rgba = withAttentionDot(blank(), W, H, 'rgba');
        expect(px(rgba, W - 3, H - 3)).toEqual([r, g, b, 255]);
    });

    it('the rest of the mark is untouched, and the input is not changed (a copy)', () => {
        const input = blank();
        input.set([1, 2, 3, 4], (2 * W + 2) * 4);
        const out = withAttentionDot(input, W, H, 'bgra');
        expect(px(out, 2, 2)).toEqual([1, 2, 3, 4]);
        expect(px(out, 0, 0)).toEqual([0, 0, 0, 0]);
        expect(px(input, W - 3, H - 3)).toEqual([0, 0, 0, 0]);
        expect(out).not.toBe(input);
    });

    it('scales with the icon: a 32px mark gets a proportionally larger dot', () => {
        const big = withAttentionDot(new Uint8Array(32 * 32 * 4), 32, 32, 'rgba');
        const dotPixels = (b: Uint8Array) => { let n = 0; for (let i = 3; i < b.length; i += 4) if (b[i] === 255) n += 1; return n; };
        const small = withAttentionDot(blank(), W, H, 'rgba');
        expect(dotPixels(big)).toBeGreaterThan(dotPixels(small) * 3);
    });
});

describe('the tooltip', () => {
    it('says how many are waiting, first; none waiting is just Genie', () => {
        expect(trayTooltip([], [], [], false, 2)).toBe('Genie — 2 waiting on you');
        expect(trayTooltip([], [], [], false, 1)).toBe('Genie — 1 waiting on you');
        expect(trayTooltip([{ provider: 'claude', words: 'rate limit · resumes 2:31 PM' }], [], [], false, 3)).toBe('Genie — 3 waiting on you; Claude: rate limit · resumes 2:31 PM');
        expect(trayTooltip([], [], [], false, 0)).toBe('Genie');
        expect(trayTooltip([])).toBe('Genie');
    });
});

describe('main wires it (comments stripped, so a sentence cannot stand in for the wiring)', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8')
        .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    it('the Deck count comes from needsYouCount over the snapshot the registry pushes, and refreshes the tray', () => {
        expect(main).toMatch(/registry\.subscribe\(\(snapshot\) => \{[\s\S]{0,400}needsYouCount\(snapshot\.deckItems \?\? \[\]\)[\s\S]{0,200}refreshTray\(\)/);
    });

    it('the tray image follows it: the dot while anything waits, the plain mark otherwise', () => {
        expect(main).toMatch(/tray\.setImage\(trayWaiting > 0 \? trayImages\.attention : trayImages\.plain\)/);
    });
});
