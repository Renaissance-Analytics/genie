import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE FONTS (§3.2) — the design contract is Geist and Geist Mono. They ship WITH the app: four
 * variable woff2 files under src/renderer/fonts/ declared by @font-face in styles.css, so the window
 * renders in the contract's face offline and never reaches a CDN on boot. Each declared file exists
 * and is a real woff2 (magic `wOF2`); the stacks start with the families; no stylesheet imports a
 * remote URL.
 */

const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
const tokens = readFileSync(new URL('../src/renderer/tokens.css', import.meta.url), 'utf8');

describe('@font-face', () => {
    const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]!);

    it('declares Geist and Geist Mono, upright and italic, as variable weights 100–900', () => {
        const summary = faces.map((f) => ({
            family: /font-family:\s*"?([^;"]+)"?;/.exec(f)?.[1],
            style: /font-style:\s*(\w+)/.exec(f)?.[1],
            weight: /font-weight:\s*([\d ]+);/.exec(f)?.[1],
        }));
        expect(summary).toEqual(expect.arrayContaining([
            { family: 'Geist', style: 'normal', weight: '100 900' },
            { family: 'Geist', style: 'italic', weight: '100 900' },
            { family: 'Geist Mono', style: 'normal', weight: '100 900' },
            { family: 'Geist Mono', style: 'italic', weight: '100 900' },
        ]));
        expect(faces).toHaveLength(4);
    });

    it('every declared file exists beside the stylesheet and is a real woff2', () => {
        const urls = [...css.matchAll(/url\(['"]?(\.\/fonts\/[^'")]+)['"]?\)/g)].map((m) => m[1]!);
        // COUNTED: four files, one per face.
        expect(urls).toHaveLength(4);
        for (const u of urls) {
            const file = new URL(`../src/renderer/${u.slice(2)}`, import.meta.url);
            expect(statSync(file).size, u).toBeGreaterThan(10_000);
            expect(readFileSync(file).subarray(0, 4).toString('latin1'), u).toBe('wOF2');
        }
    });

    it('the stacks lead with the families, and no stylesheet fetches a font from the network', () => {
        expect(css).toMatch(/--font-sans:\s*Geist,/);
        expect(css).toMatch(/--font-mono:\s*"Geist Mono",/);
        expect(css).toMatch(/--font-display:\s*Geist,/);
        for (const sheet of [css, tokens]) expect(sheet).not.toMatch(/@import\s+url\(\s*['"]?https?:/);
    });
});
