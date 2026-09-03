import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS } from '../../../main/agents/registry';

/**
 * No renderer file may restate the PROVIDER SET as string literals (genie#261).
 *
 * The registry (`main/agents/registry.ts`) exists so that adding a provider is a
 * data change. A restated list defeats that in the worst possible way: it does
 * not fail to COMPILE, it fails to WORK. `agentinbox-view.ts` carried
 * `value === 'claude' || value === 'codex' || value === 'custom'` as its
 * membership test; `kiwi` and `genie` were added to the registry months later
 * and simply fell through it, so their rows rendered a two-letter initial where
 * a provider LOGO belonged. Nothing errored, nothing was logged, and the sweep
 * that added those providers had no way to find this line.
 *
 * SOURCE-LEVEL, because that is the only level the failure is visible at: this
 * lane has no DOM harness, and even with one, a row that draws initials instead
 * of a logo renders perfectly happily and passes every assertion about its
 * content.
 *
 * ## Scope, and what is deliberately still out of it
 *
 * The list check is renderer-WIDE and currently has zero offenders. The
 * per-file check covers the two paths this change fixed. Provider `if`-chains
 * elsewhere in the renderer — `AgentInboxFlyout.toneOf`'s claude-purple /
 * codex-cyan palette, `AgentTerminalForm`'s `agent === 'custom'` — are genie#261
 * category C and remain open; widening this guard to them without first moving
 * the facts they branch on into `TuiDef` would only turn an open ticket into a
 * red suite. #261 tracks the rest.
 *
 * `recipes/workstation-setup.ts`'s `SETUP_AGENTS` is not an offender to be swept
 * up either, and it is the reason the list pattern is deliberately confined to
 * ONE expression. It is category E — a hand-mirror of genie-cloud's
 * `AGENT_CATALOG` that must not be widened from this repo alone — and its own
 * test file asserts that narrowness as a decision.
 */

const RENDERER = path.resolve(__dirname, '../..');

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) sourceFiles(full, out);
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
}

/**
 * The file with comments removed.
 *
 * Scanning raw source would forbid a comment from QUOTING the literal it
 * replaced — and the comments on both fixed sites do exactly that, because "this
 * used to say `agent === 'claude'`" is the sentence that stops the next reader
 * reintroducing it. A guard that punishes the explanation trains people to
 * delete the explanation, which is the opposite of what it is for.
 */
function codeOnly(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

const IDS = PROVIDER_IDS.join('|');

/**
 * Two DIFFERENT provider ids as literals inside one expression — the shape of a
 * hand-rolled provider list, whether written as `x === 'a' || x === 'b'` or as
 * `['a', 'b']`. Kept to one expression (no `;`, no braces between them) so an
 * unrelated `'genie'` and `'custom'` on neighbouring lines cannot collide.
 */
const PROVIDER_LIST = new RegExp(`'(${IDS})'[^;{}]{0,40}(?:\\|\\||,)[^;{}]{0,40}'(${IDS})'`, 'g');

function providerLists(src: string): string[] {
    PROVIDER_LIST.lastIndex = 0;
    const hits: string[] = [];
    for (const m of codeOnly(src).matchAll(PROVIDER_LIST)) {
        // Same id twice is not a list (`'custom' ? 'custom' : x` and friends).
        if (m[1] !== m[2]) hits.push(m[0]);
    }
    return hits;
}

/** A provider decision written as a literal comparison, in either direction. */
const PROVIDER_COMPARE = new RegExp(`(?:[!=]==\\s*'(?:${IDS})'|'(?:${IDS})'\\s*[!=]==)`, 'g');

describe('the renderer never restates the provider set', () => {
    it('POSITIVE CONTROL: the scan actually reads renderer sources', () => {
        // An empty file list passes every "no file contains X" assertion below,
        // which is exactly how a structural guard rots into a no-op. Pin both
        // that files are found and that one known file is among them.
        const files = sourceFiles(RENDERER);
        expect(files.length).toBeGreaterThan(50);
        expect(files.map((f) => path.relative(RENDERER, f).replace(/\\/g, '/'))).toContain(
            'lib/agentinbox-view.ts',
        );
    });

    it('POSITIVE CONTROL: the patterns match the shapes they exist to catch', () => {
        // Without this, a typo in either regex reports "no offenders" forever.
        // Matches do not overlap, so a three-id chain reports one hit, not two.
        // The count is not the signal — reporting the file is.
        expect(providerLists(`return v === 'claude' || v === 'codex' || v === 'custom';`)).toHaveLength(1);
        expect(providerLists(`const SETUP = ['claude', 'codex'] as const;`)).toHaveLength(1);
        // …and does NOT match the same id repeated, or two on separate statements.
        expect(providerLists(`x === 'custom' ? 'custom' : y;`)).toEqual([]);
        expect(providerLists(`if (t === 'claude') return 1;\nif (t === 'codex') return 2;`)).toEqual([]);
        expect(codeOnly(`spec.meta?.agent === 'claude'`).match(PROVIDER_COMPARE)).toHaveLength(1);
        expect(codeOnly(`agent !== 'codex'`).match(PROVIDER_COMPARE)).toHaveLength(1);
        // Stripping comments must not swallow the CODE on the same line, or the
        // guard would go quiet the moment someone comments the end of a line.
        expect(
            codeOnly(`const gate = a === 'claude'; // was: a === 'codex'`).match(PROVIDER_COMPARE),
        ).toHaveLength(1);
        expect(providerLists(`// v === 'claude' || v === 'codex'`)).toEqual([]);
    });

    it('has no file writing the provider set out by hand', () => {
        const offenders: string[] = [];
        for (const file of sourceFiles(RENDERER)) {
            const hits = providerLists(fs.readFileSync(file, 'utf8'));
            for (const hit of hits) {
                offenders.push(`${path.relative(RENDERER, file).replace(/\\/g, '/')}: ${hit}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it.each([
        'lib/agentinbox-view.ts',
        'components/Master/SpecContextMenu.tsx',
    ])('decides nothing about a provider from a literal in %s', (rel) => {
        // These two decided a CAPABILITY from a literal: which provider gets a
        // logo, and which gets the Restart item. Both answers live in the
        // registry now, so a literal reappearing here is the bug returning.
        const src = codeOnly(fs.readFileSync(path.join(RENDERER, rel), 'utf8'));
        expect(src.match(PROVIDER_COMPARE) ?? []).toEqual([]);
    });
});
