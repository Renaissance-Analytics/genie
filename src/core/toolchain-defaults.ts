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

export const DEFAULT_LANGS = ['node', 'go', 'php', 'python', 'dotnet', 'rust', 'ruby'] as const;
export type DefaultLang = (typeof DEFAULT_LANGS)[number];
export type DefaultsPlatform = 'win32' | 'linux' | 'darwin';

export const LANG_LABEL: Record<DefaultLang, string> = { node: 'Node', go: 'Go', php: 'PHP', python: 'Python', dotnet: '.NET', rust: 'Rust', ruby: 'Ruby' };

/** Where a language's Genie-managed versions live: `<toolchain>/<lang>-versions/<version>`. */
export function versionDir(toolchainDir: string, lang: DefaultLang, version: string): string {
    return join(toolchainDir, `${lang}-versions`, version);
}

export function currentLinkDir(toolchainDir: string, lang: DefaultLang): string {
    return join(toolchainDir, 'current', lang);
}

/**
 * Whether Genie manages that language's versions on this OS. PHP: Windows (windows.php.net's zip) and Linux (built
 * from php.net's source, TC5). Python: Windows (python.org's zip) and Linux (built from python.org's source, TC4b).
 * Neither on macOS yet. Rust: Linux and macOS (rustup's toolchain directory); Windows waits on the owner.
 */
export function langManagedOn(lang: DefaultLang, platform: DefaultsPlatform): boolean {
    if (lang === 'php' || lang === 'python') return platform !== 'darwin';
    // Rust: Linux and macOS until the owner decides Windows (MSVC needs Visual Studio's linker; GNU does not).
    if (lang === 'rust') return platform !== 'win32';
    // Ruby: Linux only (ruby-lang.org's source); Windows and macOS wait on the owner.
    if (lang === 'ruby') return platform === 'linux';
    return true;
}

/** Where the executables are inside a version's directory, by the official build's layout ('' = its top). */
function binRels(lang: DefaultLang, platform: DefaultsPlatform): readonly string[] {
    if (lang === 'node') return [platform === 'win32' ? '' : 'bin'];
    if (lang === 'go' || lang === 'rust' || lang === 'ruby') return ['bin'];
    // Windows: python.exe at the top, and Scripts\ — pip.exe and every console script pip installs (measured, TC4a-2).
    // Linux: a source build's bin/ (python, pip and the scripts pip installs).
    if (lang === 'python') return platform === 'win32' ? ['', 'Scripts'] : ['bin'];
    return ['']; // php: php(.exe) and php-cgi at the top — the Linux build puts its bindir there too; dotnet: at the archive's top
}

/** One language's fixed PATH entries, in order. */
export function langPathEntries(toolchainDir: string, lang: DefaultLang, platform: DefaultsPlatform): string[] {
    const link = currentLinkDir(toolchainDir, lang);
    return binRels(lang, platform).map((rel) => (rel === '' ? link : join(link, rel)));
}

/** The fixed PATH entries that reach each language's default, in order. */
export function defaultPathEntries(toolchainDir: string, platform: DefaultsPlatform): string[] {
    return DEFAULT_LANGS.filter((lang) => langManagedOn(lang, platform)).flatMap((lang) => langPathEntries(toolchainDir, lang, platform));
}

/** Where Genie manages a language's versions, in the words of a refusal: `Windows and Linux`. */
export function langManagedWhere(lang: DefaultLang): string {
    if (lang === 'php' || lang === 'python') return 'Windows and Linux';
    if (lang === 'rust') return 'Linux and macOS';
    if (lang === 'ruby') return 'Linux';
    return 'every OS';
}
