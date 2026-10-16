import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * TOKENS, NOT PALETTE CLASSES (§3.2: "colour comes from tokens, never hard-coded hex" — and a Tailwind palette class
 * is a hard-coded colour with a nicer name; it does not flip with the theme the way `--success` does). The board's
 * light and dark palettes live in `tokens.css`; a `text-emerald-500` in a component ignores them.
 *
 * COUNTED over every renderer source, with the offenders named, and a positive control that proves the scan can see
 * what it is looking for.
 */
const PALETTE = /\b(?:text|bg|border|ring|shadow|from|to|via|outline|fill|stroke)-(?:emerald|amber|red|violet|blue|sky|zinc|green|yellow|rose|indigo|slate|gray|neutral)-\d{2,3}(?:\/\d+)?\b/g;

function* walk(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) yield* walk(p);
        else if (/\.(tsx|ts)$/.test(name)) yield p;
    }
}

describe('the renderer colours by token', () => {
    it('POSITIVE CONTROL: the scan sees a palette class when one is there', () => {
        expect('className="text-emerald-500 bg-amber-500/15"'.match(PALETTE)).toEqual(['text-emerald-500', 'bg-amber-500/15']);
        expect('className="text-[var(--success)] bg-[var(--warning)]/15"'.match(PALETTE)).toBeNull();
    });

    it('no component carries a palette class — every offender listed', () => {
        const offenders: string[] = [];
        for (const file of walk('src/renderer')) {
            const hits = readFileSync(file, 'utf8').match(PALETTE);
            if (hits) offenders.push(`${file.replace(/\\/g, '/')}: ${[...new Set(hits)].join(' ')}`);
        }
        expect(offenders).toEqual([]);
    });
});
