import { readdirSync, readFileSync } from 'node:fs';
import { listNodeKinds } from '@particle-academy/fancy-flow/engine';
import { describe, expect, it } from 'vitest';
import { canonicalKind, ensureGenieKinds, paletteKindFilter } from '../../src/core/flow-canvas.js';
import { ensureFlowToolKinds } from '../../src/main/flow-tools.js';

/**
 * THE SUITE KEEPS STEP WITH THE PALETTE. Every node kind the canvas offers (`paletteKindFilter` over the registry, with
 * Genie's own kinds and its tool kinds registered, as the editor window has them) must have an acceptance case declared
 * with `kindCase('<kind>', …)` in this folder — and `kindCase` itself fails unless its kind actually ran (harness.ts).
 * Adding a node to the palette without a case turns this red. A case for a kind the palette no longer offers does too:
 * a stale case reads as coverage that is not there.
 */

const here = new URL('.', import.meta.url);
/** Comments stripped line by line first: a `kindCase(` in a comment is not a case. */
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

function declaredCases(): string[] {
    const files = readdirSync(here).filter((f) => f.endsWith('.accept.ts') && f !== 'palette-guard.accept.ts');
    return files.flatMap((f) => [...code(readFileSync(new URL(f, here), 'utf8')).matchAll(/\bkindCase\(\s*'([^']+)'/g)].map((m) => m[1]!));
}

function paletteKinds(): string[] {
    ensureGenieKinds();
    ensureFlowToolKinds();
    return listNodeKinds().filter((kind) => paletteKindFilter({ kind })).map((k) => k.name).sort();
}

describe('every kind in the palette has an acceptance case', () => {
    it('the palette is what Genie offers (CONTROL: the guard sees the 16 built-in steps and the 10 tool steps)', () => {
        const kinds = paletteKinds();
        expect(kinds.filter((k) => k.startsWith('@genie/'))).toHaveLength(10);
        expect(kinds.filter((k) => !k.startsWith('@genie/'))).toHaveLength(16);
    });

    it('no kind in the palette is without a case', () => {
        const covered = new Set(declaredCases().map((k) => canonicalKind(k)));
        expect(covered.size).toBeGreaterThan(0);
        expect(paletteKinds().filter((k) => !covered.has(k))).toEqual([]);
    });

    it('no case is for a kind the palette no longer offers', () => {
        const offered = new Set(paletteKinds());
        expect(declaredCases().filter((k) => !offered.has(canonicalKind(k)))).toEqual([]);
    });

    it('each kind is declared once (a second declaration is a second case under the same name, not two kinds covered)', () => {
        const all = declaredCases().map((k) => canonicalKind(k));
        expect(all.filter((k, i) => all.indexOf(k) !== i)).toEqual([]);
    });
});
