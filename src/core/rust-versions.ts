/**
 * GENIE'S OWN RUST — the pure half (plan `.ai/plans/genie-2-toolchain-rest.md`, row TC6b).
 *
 * rustup is Rust's official installer; it verifies every component it downloads against the channel's manifest, and
 * rustup-init's own sha256 is published beside it. Genie uses rustup ONLY as the downloader, in a staging home, and
 * keeps the toolchain directory itself — relocatable, measured: its own bin/ builds and runs a program through a
 * symlink with no rustup proxies and no RUSTUP_HOME. A STATIC list of the supported stable lines (the other managers'
 * rule), from channel-rust-stable.toml on 2026-10-25.
 */

export type RustPlatform = 'win32' | 'linux' | 'darwin';
export type RustArch = 'x64' | 'arm64';

export interface RustRecipe {
    readonly version: string;
}

export const RUST_RECIPES: readonly RustRecipe[] = [{ version: '1.99.1' }, { version: '1.98.1' }];

/** The host triple rustup installs for: `x86_64-unknown-linux-gnu`, `aarch64-apple-darwin`. */
export function rustTriple(platform: RustPlatform, arch: RustArch): string {
    const cpu = arch === 'x64' ? 'x86_64' : 'aarch64';
    if (platform === 'linux') return `${cpu}-unknown-linux-gnu`;
    if (platform === 'darwin') return `${cpu}-apple-darwin`;
    // Windows: the GNU toolchain (the owner, q_7e642512) — it links on a clean Windows; MSVC needs Visual Studio's linker.
    return `${cpu}-pc-windows-gnu`;
}

export function rustupInitUrl(triple: string): string {
    return `https://static.rust-lang.org/rustup/dist/${triple}/rustup-init${triple.includes('windows') ? '.exe' : ''}`;
}

/** The `.sha256` beside rustup-init: `<hash>  *rustup-init` → the hash, or `null`. */
export function parseSha256File(text: string): string | null {
    const m = /^([0-9a-f]{64})\b/i.exec(text.trim());
    return m ? m[1]!.toLowerCase() : null;
}

/** `rustc -vV` → its version and host triple; `null` when it is not that. */
export function parseRustcVersion(output: string): { version: string; host: string } | null {
    const v = /^rustc (\d+\.\d+\.\d+)\b/m.exec(output.trim());
    const h = /^host: (\S+)\s*$/m.exec(output);
    return v && h ? { version: v[1]!, host: h[1]! } : null;
}
