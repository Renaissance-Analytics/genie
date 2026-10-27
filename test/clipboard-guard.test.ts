import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * EVERY COPY IN THE RENDERER GOES THROUGH MAIN (genie#1263 follow-up, after react-fancy 5.68).
 *
 * #1286 put the chat's copies on Electron's clipboard in main (`genie:clipboard-write`), because `navigator.clipboard` can
 * resolve without writing anything in a sandboxed Electron window (Genie 1, v0.7.0-beta.342): the button says "Copied" and
 * the clipboard holds what it held before. This guard keeps it that way: no file under src/renderer writes the page's
 * clipboard itself (renderer/clipboard.ts hands the page clipboard to core only for a browser with no host), and every
 * react-fancy surface that draws copy buttons is given Genie's writer.
 */

const RENDERER = fileURLToPath(new URL('../src/renderer/', import.meta.url));

function sources(dir: string): { file: string; text: string }[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sources(path);
        return /\.(ts|tsx)$/.test(name) ? [{ file: path.slice(RENDERER.length), text: readFileSync(path, 'utf8') }] : [];
    });
}

/** A direct write to the page's clipboard: `navigator.clipboard.write(…)`, `.writeText(…)`, with or without `?.`. */
const DIRECT_WRITE = /navigator\s*(?:\?\.|\.)\s*clipboard\s*(?:\?\.|\.)\s*write/;
/** Code only: a comment line that NAMES the forbidden call (to say why it is forbidden) is not a call. */
const code = (text: string) => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('source guard: no direct navigator.clipboard write anywhere in src/renderer', () => {
    it('CONTROL: the guard sees every form of the call it forbids, and not a read or a comment', () => {
        for (const s of ['navigator.clipboard.writeText(x)', 'void navigator.clipboard?.writeText(x)', 'navigator?.clipboard?.write([i])', 'navigator . clipboard . write(i)']) {
            expect(DIRECT_WRITE.test(code(s))).toBe(true);
        }
        expect(DIRECT_WRITE.test('navigator.clipboard.readText()')).toBe(false);
        expect(DIRECT_WRITE.test(code('    // never navigator.clipboard.writeText here'))).toBe(false);
    });

    it('COUNTED: the scan reads the whole renderer (the control), and NO file writes the page clipboard itself', () => {
        const all = sources(RENDERER);
        expect(all.length).toBeGreaterThan(50);
        expect(all.some((s) => s.file.endsWith('ChatProse.tsx'))).toBe(true);
        expect(all.filter((s) => DIRECT_WRITE.test(code(s.text))).map((s) => s.file)).toEqual([]);
    });
});

describe('Editor in view mode routes its copies through Genie’s writer (react-fancy 5.68 forwards them)', () => {
    // 5.68.0: Editor's view mode renders through ContentRenderer and now forwards copyButtons / clipboardWriter / onCopy.
    // Left on the default writer, its code and table buttons would write navigator.clipboard, in the sandboxed window.
    const uses = sources(RENDERER).flatMap((s) => [...s.text.matchAll(/<Editor\b(?!\.)[^>]*>/g)].map((m) => ({ file: s.file, tag: m[0] })));

    it('COUNTED: every Editor that can be in view mode passes clipboardWriter={genieClipboardWriter}', () => {
        const viewable = uses.filter((u) => /\bmode=/.test(u.tag));
        expect(viewable.length).toBeGreaterThanOrEqual(1); // the control: the document plugin's editor
        expect(viewable.filter((u) => !u.tag.includes('clipboardWriter={genieClipboardWriter}')).map((u) => u.file)).toEqual([]);
    });
});
