/**
 * GENIE'S OWN RUBY — the pure half (plan `.ai/plans/genie-2-toolchain-rest.md`, row TC6c).
 *
 * ruby-lang.org publishes source only, and every file's sha256 in `pub/ruby/index.txt` (tab-separated: name, url,
 * sha1, sha256, sha512). Genie builds the gzipped tarball on Linux (the owner's decision 2: no third-party builds). A
 * STATIC list of the supported lines: the newest of 4.0, 3.4 and 3.3 in that index on 2026-10-25.
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
