import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No renderer file may re-derive the viewport clamp for a portaled popover
 * (genie#416).
 *
 * The clamp is not hard, which is exactly why it kept being rewritten: nine
 * popovers, nine hand-written placements, and no two agreeing on how much of the
 * job to do. `Chooser`'s envelope-attention popover clamped `left` against
 * `window.innerWidth` under a comment that said "clamped to the viewport" and
 * left `top` as `anchorBottom + 6`. `AgentContextMenu` two files away had both
 * halves. Four context menus carried byte-identical copies. Two more clamped
 * neither axis.
 *
 * SOURCE-LEVEL, because that is the only level this is visible at. This lane has
 * no DOM harness; and even with one, the failure needs a SHORT viewport with a
 * LOW anchor to appear at all — on any window tall enough, which is every
 * developer's, the unclamped code returns the same answer as the clamped code
 * and every assertion about it passes.
 */

const RENDERER = path.resolve(__dirname, '../..');

/** The one file allowed to do this arithmetic — it is the extraction. */
const HELPER = 'lib/anchored-popover.ts';

/**
 * `Code/EditorWand.tsx` is a documented exception, not an oversight. The
 * selection wand is a pill CENTRED on and translated ABOVE a text selection
 * (`transform: translate(-50%, calc(-100% - 8px))`), so "flip below when there
 * is no room underneath" is the wrong question for it. Its horizontal clamp is
 * `lib/wand-anchor.ts`'s `clampWandX`, which is separately tested and takes the
 * viewport width as an argument rather than reading it.
 */
const EXEMPT_FROM_IMPORT = new Set(['components/Code/EditorWand.tsx']);

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) sourceFiles(full, out);
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
}

const rel = (file: string) => path.relative(RENDERER, file).replace(/\\/g, '/');

/**
 * The file with comments removed and newlines flattened.
 *
 * Flattened because a clamp is routinely written across four lines by the
 * formatter, and a line-oriented scan sees only `window.innerWidth - width - 8,`
 * with the `Math.min(` that gives it its meaning two lines up.
 *
 * Comments are stripped so that a comment may QUOTE the clamp it replaced —
 * "this used to read `window.innerWidth - width - 8`" is the sentence that stops
 * the next reader reintroducing it, and a guard that punishes the explanation
 * trains people to delete the explanation.
 */
function codeOnly(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/\s+/g, ' ');
}

/** `window.innerWidth - rect.width` — the far edge minus the popover's own size. */
const CLAMP_BY_SIZE = /window\.inner(?:Width|Height)\s*-\s*[\w$.]+\.(?:width|height)\b/g;

/**
 * `window.innerWidth` inside a `Math.min` / `Math.max` — the same clamp written
 * against a constant or a measured number rather than a rect. Bounded by `;` so
 * an unrelated `Math.max` earlier in the statement cannot reach across into it.
 */
const CLAMP_IN_MATH = /Math\.(?:min|max)\([^;]{0,300}?window\.inner(?:Width|Height)/g;

function handRolledClamps(src: string): string[] {
    const code = codeOnly(src);
    return [...(code.match(CLAMP_BY_SIZE) ?? []), ...(code.match(CLAMP_IN_MATH) ?? [])];
}

/**
 * A JSX popover whose `top` is COMPUTED from a value — `top: coords.top`.
 *
 * Matching on an IDENTIFIER start rather than "not a digit": `\s*` backtracks,
 * so a negative lookahead placed after it matches the SPACE instead of the
 * value and flags every `top: 12` in the codebase. Literal placements
 * (`top: 12`, `top: 'calc(100% + 6px)'`) are decoration inside a laid-out
 * parent, not a portaled popover positioned against the viewport.
 */
const COMPUTED_INLINE_TOP = /style=\{\{[^}]*\btop:\s*(?=[A-Za-z_$])/;

describe('the renderer never re-derives the popover viewport clamp', () => {
    it('POSITIVE CONTROL: the scan actually reads renderer sources', () => {
        // An empty file list passes every "no file contains X" assertion below,
        // which is how a structural guard rots into a no-op.
        const files = sourceFiles(RENDERER).map(rel);
        expect(files.length).toBeGreaterThan(50);
        expect(files).toContain(HELPER);
        expect(files).toContain('components/Master/Chooser.tsx');
    });

    it('POSITIVE CONTROL: the patterns match the shapes they exist to catch', () => {
        // Without this, a typo in either regex reports "no offenders" forever.
        expect(
            handRolledClamps(`if (ny + rect.height + m > window.innerHeight) ny = window.innerHeight - rect.height - m;`),
        ).toHaveLength(1);
        expect(
            handRolledClamps(`const left = Math.min(\n  Math.max(8, r.right - width),\n  window.innerWidth - width - 8,\n);`),
        ).toHaveLength(1);
        expect(
            handRolledClamps(`const top = Math.max(M, Math.min(r.top, window.innerHeight - POP_H - M));`),
        ).toHaveLength(1);

        // …and do NOT match the two legitimate readings of the viewport size:
        // anchoring to the RIGHT edge, and handing the size to the helper.
        expect(handRolledClamps(`{ top, right: window.innerWidth - r.right }`)).toEqual([]);
        expect(handRolledClamps(`viewportWidth: window.innerWidth, viewportHeight: window.innerHeight`)).toEqual([]);
        // A comment may quote the clamp it replaced.
        expect(handRolledClamps(`// was: window.innerWidth - rect.width - 8`)).toEqual([]);
        // Flattening must not swallow the CODE after a line comment.
        expect(handRolledClamps(`// note\nconst x = window.innerWidth - rect.width;`)).toHaveLength(1);

        expect(COMPUTED_INLINE_TOP.test(`style={{ top: coords.top, left: coords.left }}`)).toBe(true);
        expect(COMPUTED_INLINE_TOP.test(`style={{ position: 'fixed', left: position.x, top: position.y }}`)).toBe(true);
        expect(COMPUTED_INLINE_TOP.test(`style={{ position: 'absolute', top: 12, right: 12 }}`)).toBe(false);
        expect(COMPUTED_INLINE_TOP.test(`style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0 }}`)).toBe(false);
    });

    it('has no file clamping a popover to the viewport by hand', () => {
        const offenders: string[] = [];
        for (const file of sourceFiles(RENDERER)) {
            if (rel(file) === HELPER) continue;
            for (const hit of handRolledClamps(fs.readFileSync(file, 'utf8'))) {
                offenders.push(`${rel(file)}: ${hit}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('has every popover with a computed inline position going through the helper', () => {
        const offenders: string[] = [];
        for (const file of sourceFiles(RENDERER)) {
            const name = rel(file);
            if (name === HELPER || EXEMPT_FROM_IMPORT.has(name)) continue;
            const src = fs.readFileSync(file, 'utf8');
            if (!COMPUTED_INLINE_TOP.test(codeOnly(src))) continue;
            if (!/from '(?:\.\.\/)+lib\/anchored-popover'/.test(src)) offenders.push(name);
        }
        expect(offenders).toEqual([]);
    });
});
