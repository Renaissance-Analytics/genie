import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Nothing the person sees may carry a real person's name, account or machine: placeholders and examples are neutral.
// The shape that shipped was a person's name in a possessive placeholder ("<Name>'s laptop"). This guard lists no real
// names itself (the repository is public): it refuses that shape in the renderer's placeholders and example text.
const POSSESSIVE = /\b(?:placeholder|example|aria-label|title)\s*=\s*\{?\s*["'`][^"'`]*\b[A-Za-z][a-z]+[’']s\s+(?:laptop|desktop|machine|computer|pc|mac|workstation|phone|device|screen)\b/i;

function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : /\.(tsx?|html)$/.test(name) ? [path] : [];
    });
}

describe('no personal names in the UI', () => {
    it("the renderer carries no person's-name placeholder or example", () => {
        const offenders = files('src/renderer').flatMap((path) =>
            readFileSync(path, 'utf8').split(/\r?\n/).flatMap((line, i) => (POSSESSIVE.test(line) ? [`${path}:${i + 1}: ${line.trim().slice(0, 80)}`] : [])));
        expect(offenders).toEqual([]);
    });

    it('CONTROL: the pattern finds the shape that shipped, and passes a neutral one', () => {
        expect(POSSESSIVE.test('<Input name="label" placeholder="Sam’s laptop" />')).toBe(true);
        expect(POSSESSIVE.test("<Input placeholder='Alex's desktop' />")).toBe(true);
        expect(POSSESSIVE.test('<Input name="label" placeholder="Office laptop" />')).toBe(false);
    });
});
