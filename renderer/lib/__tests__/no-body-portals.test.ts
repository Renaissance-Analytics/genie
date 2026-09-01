import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * NO overlay may portal into `document.body` (genie #114).
 *
 * Genie's surface tokens — `--shell`, `--card`, `--shadow-xl`, `--radius-*`,
 * the `--term-*` palette — are declared on `.gwrap` / `.genie-overlay-root`,
 * NOT on `:root`. Anything rendered outside that subtree resolves them to
 * nothing, the declarations go invalid-at-computed-value-time, and the surface
 * falls back to `background: transparent; box-shadow: none`.
 *
 * It does not fail loudly. The border and the text still paint, because
 * `--border-1` and `--fg-1` ARE on `:root` (globals.css) — so the modal looks
 * almost right and is simply see-through, which is why it kept coming back.
 *
 * #114 fixed the file picker this way and `overlay-root.ts` was written for it,
 * but nothing stopped the next portal being pointed at `document.body`. Nine
 * were, across three files, including the agent delete confirm.
 *
 * A STRUCTURAL test, because the failure is invisible to a render test: a card
 * with no background renders perfectly happily and every assertion about its
 * content passes.
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

/** `createPortal(x, document.body)` — the second argument is what matters. */
const BODY_PORTAL = /createPortal\s*\([\s\S]*?,\s*document\.body\s*[,)]/g;

describe('overlay portals target the token-carrying root', () => {
    it('no renderer source portals into document.body', () => {
        const offenders: string[] = [];
        for (const file of sourceFiles(RENDERER)) {
            const src = fs.readFileSync(file, 'utf8');
            // Cheap pre-filter keeps the regex off files that cannot match.
            if (!src.includes('document.body')) continue;
            if (BODY_PORTAL.test(src)) offenders.push(path.relative(RENDERER, file));
            BODY_PORTAL.lastIndex = 0;
        }

        expect(offenders).toEqual([]);
    });

    it('POSITIVE CONTROL: the scan actually sees a body portal', () => {
        // Without this, a broken regex would report "no offenders" forever and
        // the guard would be worthless — the exact way a negative test rots.
        const sample = `createPortal(<Thing />, document.body)`;
        BODY_PORTAL.lastIndex = 0;

        expect(BODY_PORTAL.test(sample)).toBe(true);
    });

    it('POSITIVE CONTROL: the scan reads real files, not an empty list', () => {
        // Guards the walker: a bad path would yield zero files and the first
        // test would pass against nothing.
        expect(sourceFiles(RENDERER).length).toBeGreaterThan(20);
    });
});
