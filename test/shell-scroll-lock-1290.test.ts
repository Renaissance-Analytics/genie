import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE WINDOW ITSELF NEVER SCROLLS (genie#1290). On beta.48 the owner's whole shell — rail, page and chat — had scrolled up
 * inside the window, leaving it blank white below. Two halves, both guarded here; the real window is checked by the smoke
 * (scripts/smoke-cdp.mjs, checks 64a/64b).
 *
 * 1. The root is locked, as Genie 1 locked it (v0.7.0-beta.342 `renderer/styles/globals.css`: `html, body { height: 100%;
 *    overflow: hidden }` — "THE WINDOW ITSELF NEVER SCROLLS … a bar at the document level is always a layout overflow").
 *    `overflow: hidden` stops the person's wheel but NOT a programmatic scroll (a `focus()`, a `scrollIntoView`), so the
 *    body and #root are `overflow: clip`: a clip box is not a scroll container at all, and it keeps whatever escapes the
 *    panes from growing the document.
 * 2. What overflowed: the chat's `sr-only` "Copied" live regions (react-fancy 5.67/5.68's ContentRenderer, Genie's own
 *    copy buttons — new in beta.48) are `position: absolute`. The chat scroller was not positioned, so their containing
 *    block was the chat column OUTSIDE the scroller; the scroller did not clip them, and a reply below the fold of a
 *    scrolled-up conversation stretched the DOCUMENT. The scroller is now their containing block.
 * 3. Focus moved by Genie's own code never scrolls an ancestor: every `.focus(` in the renderer passes `preventScroll`.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

/** The declarations of the first rule whose selector list is exactly `selectors` (whitespace-insensitive). */
function ruleFor(css: string, selectors: string): string | null {
    const want = selectors.replace(/\s+/g, '');
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if ((m[1] ?? '').replace(/\s+/g, '') === want) return m[2] ?? '';
    }
    return null;
}

describe('genie#1290: the window never scrolls', () => {
    const css = read('src/renderer/styles.css');

    it('html is locked like Genie 1: full height, overflow hidden', () => {
        const full = ruleFor(css, 'html,body,#root');
        expect(full, 'an `html, body, #root { … }` rule in styles.css').not.toBeNull();
        expect(full).toMatch(/height:\s*100%/);
        const rule = ruleFor(css, 'html');
        expect(rule, 'an `html { … }` rule in styles.css').not.toBeNull();
        expect(rule).toMatch(/overflow:\s*hidden/);
    });

    it('body and #root clip, so nothing can scroll them, even programmatically', () => {
        const rule = ruleFor(css, 'body,#root');
        expect(rule, 'a `body, #root { … }` rule in styles.css').not.toBeNull();
        expect(rule).toMatch(/overflow:\s*clip/);
    });

    it('the chat scroller is the containing block of its absolutely positioned live regions', () => {
        const src = read('src/renderer/components/ChatFlyout.tsx');
        const at = src.indexOf('data-chat-scroll=""');
        expect(at).toBeGreaterThan(-1);
        const cls = /className="([^"]*)"/.exec(src.slice(at))?.[1] ?? '';
        expect(cls).toMatch(/\boverflow-y-auto\b/);
        expect(cls.split(/\s+/)).toContain('relative');
    });
});

describe('genie#1290: programmatic focus never scrolls the document', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) walk(path);
            else if (/\.(ts|tsx)$/.test(name)) files.push(path);
        }
    };
    walk(join(root, 'src/renderer'));

    it('finds the renderer sources (positive control)', () => {
        expect(files.length).toBeGreaterThan(20);
    });

    it('every .focus( call in the renderer passes { preventScroll: true }', () => {
        const offenders: string[] = [];
        let calls = 0;
        for (const file of files) {
            read(relative(root, file)).split('\n').forEach((line, i) => {
                const code = line.replace(/\/\/.*$/, '');
                if (/^\s*\*/.test(code)) return;
                for (const m of code.matchAll(/\.focus\(([^)]*)\)/g)) {
                    calls += 1;
                    if (!/preventScroll:\s*true/.test(m[1] ?? '')) offenders.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`);
                }
            });
        }
        // The control: the scan sees the composer chord (App.tsx) and the find box (AgentView.tsx) at least.
        expect(calls).toBeGreaterThanOrEqual(2);
        expect(offenders).toEqual([]);
    });
});
