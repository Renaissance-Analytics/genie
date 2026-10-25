import { join } from 'node:path';

/**
 * EACH LANGUAGE'S DEFAULT — the pure half (plan `.ai/plans/genie-2-toolchain-rest.md`, row TC3a; the owner's design,
 * 2026-10-18: "Default: one of the installed versions, or the system's own. It is what `php`, `node`, `python` and `go`
 * mean").
 *
 * One stable link per language, `<toolchain>/current/<lang>`, pointing at the chosen version's directory. The PATH holds
 * the FIXED `current` entries below; choosing a default only repoints the link, so neither Genie's PATH nor (after the
 * one consented change, TC3b) the machine's ever needs editing again. A link, not a `.cmd` shim: a program that starts
 * `node` directly goes through CreateProcess on Windows, which finds node.exe and never runs a .cmd.
 */

export const DEFAULT_LANGS = ['node', 'go', 'php'] as const;
export type DefaultLang = (typeof DEFAULT_LANGS)[number];
export type DefaultsPlatform = 'win32' | 'linux' | 'darwin';

export const LANG_LABEL: Record<DefaultLang, string> = { node: 'Node', go: 'Go', php: 'PHP' };

/** Where a language's Genie-managed versions live: `<toolchain>/<lang>-versions/<version>`. */
export function versionDir(toolchainDir: string, lang: DefaultLang, version: string): string {
    return join(toolchainDir, `${lang}-versions`, version);
}

export function currentLinkDir(toolchainDir: string, lang: DefaultLang): string {
    return join(toolchainDir, 'current', lang);
}

/** Whether Genie manages that language's versions on this OS (PHP: Windows only, where windows.php.net builds them). */
export function langManagedOn(lang: DefaultLang, platform: DefaultsPlatform): boolean {
    return lang !== 'php' || platform === 'win32';
}

/** Where the executables are inside a version's directory, by the official build's layout. */
function binRel(lang: DefaultLang, platform: DefaultsPlatform): string | null {
    if (lang === 'node') return platform === 'win32' ? null : 'bin';
    if (lang === 'go') return 'bin';
    return null; // php: php.exe at the top (Windows only)
}

/** The fixed PATH entries that reach each language's default, in order. */
export function defaultPathEntries(toolchainDir: string, platform: DefaultsPlatform): string[] {
    return DEFAULT_LANGS.filter((lang) => langManagedOn(lang, platform)).map((lang) => {
        const rel = binRel(lang, platform);
        const link = currentLinkDir(toolchainDir, lang);
        return rel === null ? link : join(link, rel);
    });
}

/** One language's entry (the same as in `defaultPathEntries`). */
export function defaultPathEntry(toolchainDir: string, lang: DefaultLang, platform: DefaultsPlatform): string {
    const rel = binRel(lang, platform);
    const link = currentLinkDir(toolchainDir, lang);
    return rel === null ? link : join(link, rel);
}
