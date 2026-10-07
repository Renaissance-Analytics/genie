import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which pages the renderer build emits — the one source of truth, read by both
 * `renderer/vite.config.mts` and the tests that assert what ships (Tynn #449).
 *
 * BUILD-TIME ONLY. It reads the filesystem, so nothing a page imports may import this;
 * it exists in the renderer tree because `vite.config.mts` is here too and that config is
 * its primary consumer.
 *
 * It lives in its own module rather than inside the config because a test cannot import a
 * `.mts` config without `allowImportingTsExtensions`, and the alternative — a test that
 * re-implements the discovery rule — is the shape that lets the rule and its guard drift
 * apart. The guard has to read the same function the build does or it is guarding a copy.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** `renderer/pages/` — one `<name>.tsx` per window. */
export const PAGES_DIR = path.join(here, 'pages');

/**
 * `renderer/pages/<name>.tsx` → page name, minus Next's underscore files.
 *
 * `includeHarnesses` is the whole of the "dead weight out of the installer" half of the
 * migration: the `e2e-*` pages are discovered from the same directory as everything else
 * and filtered by MODE, so there is no registry to forget to update when a harness is
 * added. A production build emits none of them.
 */
export function discoverPages(includeHarnesses: boolean): string[] {
    return fs
        .readdirSync(PAGES_DIR)
        .filter((f) => f.endsWith('.tsx') && !f.startsWith('_'))
        .map((f) => f.replace(/\.tsx$/, ''))
        .filter((name) => includeHarnesses || !name.startsWith('e2e-'))
        .sort();
}

/**
 * Delete harness pages left in `outDir` by an earlier `--mode e2e` build.
 *
 * `build.emptyOutDir` is false and has to be: `build:main` writes the four main-process
 * bundles into the same `app/`, and the renderer build runs second, so emptying it would
 * delete them. The cost of that is this — a production build writes 12 pages but does not
 * REMOVE the 14 a previous test build wrote, and `electron-builder.yml` ships `app/**\/*`.
 *
 * So after `npm run test:e2e`, a plain `npm run build` would package every harness page.
 * CI never sees it (fresh checkout each run), which is exactly what makes it worth a
 * function and a test rather than a convention: the one place it happens is a developer's
 * machine, where nobody is looking at the page list.
 *
 * Returns what it removed, so the build can say so instead of deleting files silently.
 */
export function pruneStaleHarnessPages(outDir: string): string[] {
    if (!fs.existsSync(outDir)) return [];
    const stale = fs
        .readdirSync(outDir)
        .filter((f) => f.startsWith('e2e-') && f.endsWith('.html'))
        .sort();
    for (const f of stale) fs.rmSync(path.join(outDir, f));
    return stale;
}
