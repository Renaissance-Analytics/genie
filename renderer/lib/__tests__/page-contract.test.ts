import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import os from 'node:os';
import { discoverPages, pruneStaleHarnessPages } from '../../page-discovery';

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
            // Literal page names only — `loadFile(path.join(__dirname, 'master.html'))`.
            // A COMPUTED name cannot be checked here, which is why it is forbidden outright
            // by the test below rather than waved at in this comment.
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

    /**
     * The leak `emptyOutDir: false` opens.
     *
     * `build:main` writes four bundles into the same `app/` and the renderer build runs
     * second, so it may not empty the directory. The consequence is that a production
     * build writes its 12 pages over whatever is there and leaves the 14 a previous
     * `--mode e2e` build wrote — and `electron-builder.yml` packages `app/**` wholesale.
     * `npm run test:e2e` then `npm run build` shipped every harness page.
     *
     * Invisible on CI, which checks out fresh every run. That is the reason it is tested
     * rather than trusted.
     */
    it('removes harness pages a previous e2e build left in the out dir', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-prune-'));
        try {
            for (const f of ['master.html', 'e2e-deck.html', 'e2e-agent-view.html']) {
                fs.writeFileSync(path.join(dir, f), '<!doctype html>');
            }
            // Non-page files share the directory — the four main bundles land here too, and
            // deleting one of those is how this "fix" would become a worse bug than the leak.
            fs.writeFileSync(path.join(dir, 'background.js'), '// main');

            const removed = pruneStaleHarnessPages(dir);

            expect(removed).toEqual(['e2e-agent-view.html', 'e2e-deck.html']);
            expect(fs.readdirSync(dir).sort()).toEqual(['background.js', 'master.html']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('prunes nothing when there is nothing stale, and tolerates a missing dir', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-prune-'));
        try {
            fs.writeFileSync(path.join(dir, 'master.html'), '<!doctype html>');
            expect(pruneStaleHarnessPages(dir)).toEqual([]);
            expect(fs.readdirSync(dir)).toEqual(['master.html']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        // First build on a clean checkout: `app/` does not exist yet.
        expect(pruneStaleHarnessPages(path.join(dir, 'does-not-exist'))).toEqual([]);
    });

    /**
     * No production code may load a page by COMPUTED name.
     *
     * This closes a hole in the scan above, which only sees literal filenames. When this
     * file was first written it carried a comment claiming interpolated names were "asserted
     * separately below" — and nothing asserted them. The one place that interpolated was
     * `showE2EWindow`, `loadFile(path.join(__dirname, \`${page}.html\`))`, which was compiled
     * into the shipped binary: the exact case the guard was for, invisible to it.
     *
     * The rig now lives behind `__GENIE_E2E_BUILD__` in `main/e2e/`, excluded from production
     * builds and verified by `scripts/assert-no-e2e-in-bundle.mjs`, so every surviving
     * `loadFile` outside that directory names its page literally. Keeping it that way is what
     * makes the scan above complete rather than best-effort.
     */
    it('never loads a page by computed name outside the E2E rig', () => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    // The rig may interpolate: it is not in a production build.
                    if (['__tests__', 'node_modules', 'e2e'].includes(entry.name)) continue;
                    walk(full);
                    continue;
                }
                if (!entry.name.endsWith('.ts')) continue;
                const src = fs.readFileSync(full, 'utf8');
                for (const m of src.matchAll(/loadFile\([^;]*?\$\{[^;]*?\.html/g)) {
                    offenders.push(`${path.relative(REPO, full).replace(/\\/g, '/')}: ${m[0].slice(0, 60)}`);
                }
            }
        };
        walk(MAIN_DIR);
        expect(
            offenders,
            'a computed page name cannot be checked against the build, so it must not exist',
        ).toEqual([]);
    });

    it('keeps every harness page out of the production set', () => {
        // The other half of "remove the dead weight in the installer" (Tynn #449): the
        // harnesses are discovered from the same directory and filtered by mode, so this
        // asserts the filter rather than a hand-maintained list.
        expect([...production].filter((p) => p.startsWith('e2e-'))).toEqual([]);
        expect([...withHarnesses].some((p) => p.startsWith('e2e-'))).toBe(true);
    });
});
