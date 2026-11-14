import { readFileSync, readdirSync } from 'node:fs';

/**
 * THE RELEASE NOTES GENIE CARRIES (Tynn #762): every `docs/releases/v<version>.md`, bundled into the build as text and
 * keyed by version, so What's New shows the running version's own words with no network and no file to lose.
 */
const files: Record<string, string> = (() => {
    try {
        // Keep the literal call: Vite replaces it with bundled text, including in the shipped host.
        return import.meta.glob('../../docs/releases/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    } catch (error) {
        if (typeof import.meta.glob === 'function') throw error;
        // Source-mode host tools/tests run through Node/tsx, which has no Vite glob transform.
        // Read the same documents; never substitute empty notes or hide a missing/unreadable source book.
        const directory = new URL('../../docs/releases/', import.meta.url);
        return Object.fromEntries(readdirSync(directory).filter(name => /^v.+\.md$/.test(name))
            .map(name => [new URL(name, directory).href, readFileSync(new URL(name, directory), 'utf8')]));
    }
})();

export const RELEASE_NOTES: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(files).flatMap(([path, text]) => {
        const match = /\/v([^/]+)\.md$/.exec(path);
        return match ? [[match[1]!, text]] : [];
    }),
);
