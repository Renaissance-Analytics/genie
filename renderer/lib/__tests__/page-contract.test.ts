import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverPages } from '../../page-discovery';

/**
 * The main process and the renderer build must agree on which pages exist.
 *
 * This is the "window opens and hangs with nothing in it" guard, and it is here because
 * that failure has no error message anywhere. In production every window is opened with
 *
 *     w.loadFile(path.join(__dirname, '<page>.html'))
 *
 * and Electron does not throw for a missing file — it loads about:blank-ish nothing. The
 * window appears, paints the prerendered `.boot-screen` from CSS, and sits there. It is
 * indistinguishable from a hung preload bridge, which is the hardest failure in this app
 * to diagnose, and it is one typo or one renamed page away at all times.
 *
 * Two directions, both real:
 *
 *  - **A page the main process loads but the build does not emit.** Renaming
 *    `renderer/pages/knowledge.tsx` while `force-question.ts` still says `knowledge.html`
 *    compiles, typechecks, and ships.
 *  - **A page the main process loads that is HARNESS-ONLY.** `e2e-*` pages exist only
 *    under `--mode e2e`, so a production `loadFile('e2e-deck.html')` would be a window
 *    that works for the whole test suite and is empty in every installer.
 *
 * Cheap and pure — no Electron, no build, no browser. It reads the same `discoverPages`
 * the renderer config builds from, so it cannot drift from what actually gets emitted.
 */

const REPO = path.resolve(__dirname, '../../..');
const MAIN_DIR = path.join(REPO, 'main');

/** Every `'<name>.html'` the main tree hands to `loadFile`, with the file that does it. */
function loadFileTargets(): { page: string; file: string }[] {
    const found: { page: string; file: string }[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
                walk(full);
                continue;
            }
            if (!entry.name.endsWith('.ts')) continue;
            const src = fs.readFileSync(full, 'utf8');
            // `loadFile(path.join(__dirname, 'master.html'))` and the few that interpolate a
            // computed page name are both matched; the latter are asserted separately below.
            for (const m of src.matchAll(/loadFile\([^)]*?['"`]([A-Za-z0-9-]+)\.html['"`]/g)) {
                found.push({ page: m[1]!, file: path.relative(REPO, full).replace(/\\/g, '/') });
            }
        }
    };
    walk(MAIN_DIR);
    return found;
}

describe('the page contract between main and the renderer build', () => {
    const production = new Set(discoverPages(false));
    const withHarnesses = new Set(discoverPages(true));
    const targets = loadFileTargets();

    it('positive control: the guard found real loadFile targets and real pages', () => {
        // Without this, every assertion below passes vacuously on an empty match set — the
        // exact way a "nothing is missing" test survives the thing it was written for.
        expect(targets.length).toBeGreaterThan(5);
        expect(production.size).toBeGreaterThan(5);
        expect(production.has('master')).toBe(true);
    });

    it('emits every page the main process loads in production', () => {
        const missing = targets.filter((t) => !production.has(t.page));
        expect(
            missing.map((m) => `${m.page}.html (loaded by ${m.file})`),
            'the main process loads a page the production build does not emit — ' +
                'that window opens empty with no error',
        ).toEqual([]);
    });

    it('never loads a harness-only page from the main process', () => {
        // Restates the rule rather than relying on the test above: a harness page IS in
        // `withHarnesses`, so a `loadFile('e2e-….html')` would only fail the production
        // check, and only for as long as nobody "fixed" it by loosening that one.
        const harnessOnly = targets.filter((t) => !production.has(t.page) && withHarnesses.has(t.page));
        expect(harnessOnly.map((h) => `${h.page} (in ${h.file})`)).toEqual([]);
        for (const t of targets) expect(t.page.startsWith('e2e-')).toBe(false);
    });

    it('keeps every harness page out of the production set', () => {
        // The other half of "remove the dead weight in the installer" (Tynn #449): the
        // harnesses are discovered from the same directory and filtered by mode, so this
        // asserts the filter rather than a hand-maintained list.
        expect([...production].filter((p) => p.startsWith('e2e-'))).toEqual([]);
        expect([...withHarnesses].some((p) => p.startsWith('e2e-'))).toBe(true);
    });
});
