/**
 * GENIE'S OWN RUBY — the pure half (plan `.ai/plans/genie-2-toolchain-rest.md`, row TC6c).
 *
 * ruby-lang.org publishes source only, and every file's sha256 in `pub/ruby/index.txt` (tab-separated: name, url,
 * sha1, sha256, sha512). Genie builds the gzipped tarball on Linux (the owner's decision 2: no third-party builds). A
 * STATIC list of the supported lines: the newest of 4.0, 3.4 and 3.3 in that index on 2026-10-25.
 *
 * WINDOWS (TC6e; the owner's pick, 2026-10-25): RubyInstaller, which ruby-lang.org points Windows users to — its portable
 * .7z per release (`RubyInstaller-<version>-1`), the SHA256 its own downloads page lists for exactly that file.
 */

export type RubyPlatform = 'win32' | 'linux' | 'darwin';
export type RubyArch = 'x64' | 'arm64';

export interface RubyRecipe {
    readonly version: string;
}

export const RUBY_RECIPES: readonly RubyRecipe[] = [{ version: '4.0.9' }, { version: '3.4.12' }, { version: '3.3.13' }];

export const RUBY_INDEX = 'https://cache.ruby-lang.org/pub/ruby/index.txt';

export function rubySourceName(version: string): string {
    return `ruby-${version}.tar.gz`;
}

export function rubySourceUrl(version: string): string {
    return `https://cache.ruby-lang.org/pub/ruby/${version.split('.').slice(0, 2).join('.')}/${rubySourceName(version)}`;
}

/** The sha256 index.txt lists for exactly that version's tarball url, or `null` — never guessed. */
export function rubyShaFromIndex(text: string, version: string): string | null {
    const url = rubySourceUrl(version);
    for (const line of text.split(/\r?\n/)) {
        const cols = line.split('\t');
        if (cols[1] !== url) continue;
        const sha = cols[3] ?? '';
        return /^[0-9a-f]{64}$/i.test(sha) ? sha.toLowerCase() : null;
    }
    return null;
}

/**
 * The libraries Ruby's configure needs for what a person uses, by their pkg-config names, with the package that
 * provides each. Without libyaml, psych — and with it gem and bundler — is quietly left out of the build.
 */
export const RUBY_BUILD_LIBRARIES: ReadonlyArray<{ readonly pkg: string; readonly apt: string; readonly dnf: string; readonly pacman: string }> = [
    { pkg: 'openssl', apt: 'libssl-dev', dnf: 'openssl-devel', pacman: 'openssl' },
    { pkg: 'yaml-0.1', apt: 'libyaml-dev', dnf: 'libyaml-devel', pacman: 'libyaml' },
    { pkg: 'libffi', apt: 'libffi-dev', dnf: 'libffi-devel', pacman: 'libffi' },
    { pkg: 'zlib', apt: 'zlib1g-dev', dnf: 'zlib-devel', pacman: 'zlib' },
];

export function missingRubyLibrariesAdvice(missing: readonly string[]): string {
    const rows = RUBY_BUILD_LIBRARIES.filter((l) => missing.includes(l.pkg));
    const pkgs = (k: 'apt' | 'dnf' | 'pacman') => rows.map((r) => r[k]).join(' ');
    return `Genie builds Ruby from ruby-lang.org's source here, and these libraries it needs are not on this machine: ${missing.join(', ')} — install them (Debian/Ubuntu: sudo apt install ${pkgs('apt')}; Fedora: sudo dnf install ${pkgs('dnf')}; Arch: sudo pacman -S ${pkgs('pacman')}) and install again`;
}

/** The proof: load what a person needs, then say the version and platform. */
export const RUBY_PROOF_ARGS: readonly string[] = ['-e', "require 'openssl'; require 'psych'; require 'zlib'; require 'fiddle'; print RUBY_VERSION, ' ', RUBY_PLATFORM"];

export function parseRubyProof(output: string): { version: string; platform: string } | null {
    const m = /^(\d+\.\d+\.\d+) (\S+)\s*$/.exec(output.trim());
    return m ? { version: m[1]!, platform: m[2]! } : null;
}

/** What RUBY_PLATFORM says for a source build here: `x86_64-linux`, `aarch64-linux`. */
export function rubyPlatform(arch: RubyArch): string {
    return `${arch === 'x64' ? 'x86_64' : 'aarch64'}-linux`;
}

const RI_ARCH: Record<RubyArch, string> = { x64: 'x64', arm64: 'arm' };

/** RubyInstaller's release tag for a recipe: `RubyInstaller-4.0.9-1` (the first package of that Ruby). */
export function rubyInstallerTag(version: string): string {
    return `RubyInstaller-${version}-1`;
}

/** Its portable archive: `rubyinstaller-4.0.9-1-x64.7z`. */
export function rubyInstallerAsset(version: string, arch: RubyArch): string {
    return `rubyinstaller-${version}-1-${RI_ARCH[arch]}.7z`;
}

/** The archive's one top folder: its name without `.7z`. */
export function rubyInstallerTopFolder(version: string, arch: RubyArch): string {
    return rubyInstallerAsset(version, arch).replace(/\.7z$/, '');
}

export function rubyInstallerUrl(version: string, arch: RubyArch): string {
    return `https://github.com/oneclick/rubyinstaller2/releases/download/${rubyInstallerTag(version)}/${rubyInstallerAsset(version, arch)}`;
}

/**
 * RubyInstaller's own downloads page: every file's link, then its own details with its SHA256 — the publisher's
 * statement of the hash. Not GitHub's release API: measured, it answered the test VM 403 "API rate limit exceeded" (60
 * calls an hour for everything behind one address), which a person behind a shared address would hit too.
 */
export const RUBYINSTALLER_DOWNLOADS = 'https://rubyinstaller.org/downloads/';

/**
 * The SHA256 the downloads page lists for exactly that file: the link whose href IS its url, and the SHA256 in that
 * file's own details — read only up to the NEXT file's link, so a file listed without one is `null`, never its
 * neighbour's (measured 2026-10-25: 3.3.13's arm build has no entry). Never guessed.
 */
export function rubyInstallerShaFromPage(html: string, version: string, arch: RubyArch): string | null {
    const at = html.indexOf(`href="${rubyInstallerUrl(version, arch)}"`);
    if (at < 0) return null;
    const rest = html.slice(at + 1);
    const next = rest.search(/class="downloadlink/);
    const own = next < 0 ? rest : rest.slice(0, next);
    const m = /SHA256:\s*<input[^>]*\bvalue="([0-9a-f]{64})"/i.exec(own);
    return m ? m[1]!.toLowerCase() : null;
}

/** What RUBY_PLATFORM says for RubyInstaller's build here. */
export function rubyWindowsPlatform(arch: RubyArch): string {
    return arch === 'x64' ? 'x64-mingw-ucrt' : 'aarch64-mingw-ucrt';
}
