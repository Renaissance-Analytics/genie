import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THIN SCROLLBARS (the owner, 2026-10-14: "We should be using thin scroll bars"). One universal rule in the app's
 * stylesheet, so every scroller is thin, including ones added later, and nothing else in the renderer's CSS or class
 * names puts a wide bar back.
 */
const css = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('thin scrollbars', () => {
    it('one universal rule: every element is thin, the thumb a token, the track transparent', () => {
        const rules = css('../src/renderer/styles.css').match(/(^|\n)\*\s*\{[^}]*\}/g) ?? [];
        const thin = rules.filter((r) => /scrollbar-width:\s*thin;/.test(r));
        expect(thin).toHaveLength(1);
        expect(thin[0]).toMatch(/scrollbar-color:\s*var\(--border-2[^;]*\)\s+transparent;/);
    });

    it('nothing in the renderer turns a wide bar back on (no scrollbar-width: auto, no ::-webkit-scrollbar width)', () => {
        const dir = new URL('../src/renderer/', import.meta.url);
        const sheets = readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => css(`../src/renderer/${f}`)).join('\n');
        expect(sheets.match(/scrollbar-width:\s*auto/g) ?? []).toHaveLength(0);
        expect(sheets.match(/::-webkit-scrollbar\s*\{[^}]*width/g) ?? []).toHaveLength(0);
    });
});
