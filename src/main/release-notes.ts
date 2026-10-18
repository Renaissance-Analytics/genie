/**
 * THE RELEASE NOTES GENIE CARRIES (Tynn #762): every `docs/releases/v<version>.md`, bundled into the build as text and
 * keyed by version, so What's New shows the running version's own words with no network and no file to lose.
 */
const files = import.meta.glob('../../docs/releases/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export const RELEASE_NOTES: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(files).flatMap(([path, text]) => {
        const match = /\/v([^/]+)\.md$/.exec(path);
        return match ? [[match[1]!, text]] : [];
    }),
);
