import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** No character in src/ that a reader cannot see: written as an escape, each means the same and can be read. A BOM at the very start of a file is an editor's, so it is allowed there. */
const FORBIDDEN: ReadonlyArray<readonly [number, number]> = [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb]];

function invisibleIn(text: string): string[] {
    const found: string[] = [];
    let at = 0;
    for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0;
        if (FORBIDDEN.some(([from, to]) => code >= from && code <= to) && !(at === 0 && code === 0xfeff)) found.push(`U+${code.toString(16).toUpperCase().padStart(4, '0')} at ${at}`);
        at += ch.length;
    }
    return found;
}

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const path = `${dir}/${name}`; return statSync(path).isDirectory() ? walk(path) : /\.(tsx?|mts|mjs|css|html)$/.test(name) ? [path] : []; });

describe('the reading itself', () => {
    it.each([[0x2028], [0x2029], [0x202e], [0x200b], [0x2066], [0xfeff], [0x1b], [0xad]])('finds U+%s in the middle of a line', (code) => {
        expect(invisibleIn(`const a = /x${String.fromCodePoint(code)}y/;`)).toHaveLength(1);
    });

    it('leaves what a reader can see, a tab and a line ending included, and a BOM at the very start', () => {
        expect(invisibleIn('const a = 1;\r\n\tconst b = "é — ⏎";\n')).toEqual([]);
        expect(invisibleIn(`${String.fromCodePoint(0xfeff)}const a = 1;`)).toEqual([]);
    });
});

describe('src/', () => {
    it('holds none, each named by file', () => {
        const files = walk('src');
        // CONTROL: a walk that found nothing would pass.
        expect(files.length).toBeGreaterThan(500);
        expect(files.flatMap((file) => invisibleIn(readFileSync(file, 'utf8')).map((hit) => `${file}: ${hit}`))).toEqual([]);
    });
});
