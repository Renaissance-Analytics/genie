import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * A CDP DRIVER CALLS ONLY A FUNCTION IT PUT IN ITS OWN TABLE (CodeQL js/unvalidated-dynamic-method-call, alerts #79 to
 * #96, Tynn #966). Each driver in scripts/ keeps a `pending` Map from a request id to that request's resolver, and an
 * incoming frame's `id` picks which one is called. A frame whose id is not a pending request's (another client's, a stale
 * one, or anything else) finds no function there, and is ignored: the lookup is called only after
 * `typeof … === 'function'`, never as `pending.get(id)?.(…)` or behind a mere truthiness check.
 */
const scripts = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? scripts(join(dir, e.name)) : /\.(mjs|cjs|js)$/.test(e.name) ? [join(dir, e.name).replace(/\\/g, '/')] : []);

/** Each place a resolver is taken from a `pending` Map, and whether it is checked to be a function before it is called. */
function resolverCalls(source: string): { line: number; checked: boolean; text: string }[] {
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    const out: { line: number; checked: boolean; text: string }[] = [];
    lines.forEach((text, i) => {
        // pending.get(x)?.(…): a call with no check at all.
        if (/pending\.get\([^)]*\)\?\.\(/.test(text)) out.push({ line: i + 1, checked: false, text: text.trim() });
        const taken = /(?:const|let)\s+(\w+)\s*=\s*[\w.#]*pending\.get\(/.exec(text);
        if (taken) {
            const name = taken[1]!;
            // The check, on the same line or the next two (a handler split over lines).
            const near = lines.slice(i, i + 3).join('\n');
            const checked = new RegExp(`typeof ${name} === 'function'`).test(near);
            out.push({ line: i + 1, checked, text: text.trim() });
        }
    });
    return out;
}

describe('the CDP drivers call only a pending request\'s own resolver', () => {
    const files = scripts('scripts').filter((f) => /pending\.get\(/.test(readFileSync(f, 'utf8')));

    it('CONTROL: the drivers CodeQL named are among the files read, each with a resolver lookup', () => {
        for (const f of ['scripts/crash-cdp-lib.mjs', 'scripts/site-panel-cdp.mjs', 'scripts/local-door-cdp.mjs', 'scripts/artboard-cdp.mjs', 'scripts/chat-drafts-cdp.mjs', 'scripts/files-watch-cdp.mjs']) {
            expect(files, f).toContain(f);
            expect(resolverCalls(readFileSync(f, 'utf8')).length, f).toBeGreaterThan(0);
        }
    });

    it('every resolver taken from a pending Map is checked to be a function before it is called', () => {
        const unchecked = files.flatMap((f) => resolverCalls(readFileSync(f, 'utf8')).filter((c) => !c.checked).map((c) => `${f}:${c.line} ${c.text.slice(0, 120)}`));
        expect(unchecked).toEqual([]);
    });

    it('the check itself: an unchecked lookup is found, a checked one is not (the gauge reads both)', () => {
        expect(resolverCalls("const r = c.#pending.get(f.id); if (r) { r(f); }")).toEqual([expect.objectContaining({ checked: false })]);
        expect(resolverCalls('c.pending.get(frame.id)?.(frame);')).toEqual([expect.objectContaining({ checked: false })]);
        expect(resolverCalls("const r = c.#pending.get(f.id); if (typeof r === 'function') { r(f); }")).toEqual([expect.objectContaining({ checked: true })]);
    });
});
