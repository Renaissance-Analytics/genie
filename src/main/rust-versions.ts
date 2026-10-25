import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { RUST_RECIPES, parseRustcVersion, parseSha256File, rustTriple, rustupInitUrl, type RustArch, type RustPlatform } from '../core/rust-versions.js';
import { managedVersions, type ManagedPhp } from '../core/php-versions.js';
import type { Fetched, PhpVersionsFs } from './php-versions.js';
import type { CommandRunner } from './toolchain-prober.js';

/**
 * GENIE'S OWN RUST — list, install, remove (plan `.ai/plans/genie-2-toolchain-rest.md`, TC6b). An install:
 *
 *   rustc links with the system's C compiler, so `cc` is asked for first → rustup-init downloaded and checked against
 *   the sha256 published beside it (nothing written before) → rustup run in a STAGING home (RUSTUP_HOME / CARGO_HOME
 *   given through `env`, argv only), `toolchain install <version>` → the toolchain directory moved to
 *   `<root>/<version>` → the staging home deleted → proven: that rustc names the version and this host, and cargo
 *   answers — or nothing of it is left.
 *
 * Windows waits on the owner: the MSVC toolchain cannot link on a clean Windows (it needs Visual Studio's linker), the
 * GNU one can (measured on the Windows test VM, 2026-10-25).
 */

export interface RustVersionsPorts {
    readonly platform: RustPlatform;
    readonly arch: RustArch;
    /** `<toolchain data>/rust-versions` — one directory per toolchain version. */
    readonly root: string;
    readonly fs: PhpVersionsFs;
    readonly run: CommandRunner;
    readonly fetchBytes: (url: string) => Promise<Fetched<Uint8Array>>;
    readonly fetchText: (url: string) => Promise<Fetched<string>>;
    readonly progress?: (step: string | null) => void;
}

export interface RustVersionsView {
    readonly managed: ReadonlyArray<{ readonly version: string; readonly dir: string }>;
    /** The rustc on PATH, or `null` when none answers. */
    readonly system: { readonly version: string } | null;
    readonly available: ReadonlyArray<{ readonly version: string; readonly installed: boolean }>;
    readonly installRefused?: string;
}

export type RustInstallOutcome =
    | { readonly kind: 'refused'; readonly reason: string }
    | { readonly kind: 'already-installed'; readonly version: string }
    | { readonly kind: 'installed'; readonly version: string; readonly dir: string }
    | { readonly kind: 'not-installed'; readonly reason: string };

export type RustRemoveOutcome = { readonly kind: 'refused'; readonly reason: string } | { readonly kind: 'removed'; readonly version: string };

const NOT_HERE = "Genie does not install its own Rust on Windows yet: Rust's default (MSVC) toolchain needs Visual Studio's linker, which a clean Windows does not have, and how Genie handles that is the owner's decision; the rustc on your PATH is used";
const NO_LINKER = "Rust needs a linker — the system's C compiler — and there is none here; install it first (Debian/Ubuntu: sudo apt install build-essential; Fedora: sudo dnf install gcc; Arch: sudo pacman -S base-devel; macOS: xcode-select --install) and install again";

export function rustVersionsRoot(toolchainDataDir: string): string {
    return join(toolchainDataDir, 'rust-versions');
}

const rustcOf = (dir: string) => join(dir, 'bin', 'rustc');

/** The versions Genie manages here — a full version directory whose bin/rustc is there. Newest first. */
export function managedRust(ports: Pick<RustVersionsPorts, 'root' | 'fs'>): ManagedPhp[] {
    return managedVersions(ports.fs.list(ports.root), (v) => ports.fs.exists(rustcOf(join(ports.root, v))), (v) => join(ports.root, v));
}

export async function listRustVersions(ports: RustVersionsPorts): Promise<RustVersionsView> {
    const managed = managedRust(ports);
    let system: RustVersionsView['system'] = null;
    try {
        const said = await ports.run('rustc', ['--version']);
        const v = said.exitCode === 0 ? /^rustc (\d+\.\d+\.\d+)/m.exec(said.stdout.trim())?.[1] : undefined;
        if (v) system = { version: v };
    } catch {
        // no rustc on PATH
    }
    if (ports.platform === 'win32') return { managed, system, available: [], installRefused: NOT_HERE };
    const have = new Set(managed.map((m) => m.version));
    return { managed, system, available: RUST_RECIPES.map((r) => ({ version: r.version, installed: have.has(r.version) })) };
}

export async function installRustVersion(version: string, consent: boolean, ports: RustVersionsPorts): Promise<RustInstallOutcome> {
    if (consent !== true) return { kind: 'refused', reason: `Genie installs nothing without your go-ahead; Rust ${version} was not installed` };
    if (ports.platform === 'win32') return { kind: 'refused', reason: NOT_HERE };
    if (!RUST_RECIPES.some((r) => r.version === version)) return { kind: 'refused', reason: `Genie has no installer for Rust ${version}; this release installs ${RUST_RECIPES.map((r) => r.version).join(', ')}` };
    const dir = join(ports.root, version);
    if (ports.fs.exists(rustcOf(dir))) return { kind: 'already-installed', version };
    try {
        if ((await ports.run('cc', ['--version'])).exitCode !== 0) return { kind: 'refused', reason: NO_LINKER };
    } catch {
        return { kind: 'refused', reason: NO_LINKER };
    }
    const say = (step: string) => ports.progress?.(step);
    const label = `Rust ${version}`;
    const triple = rustTriple(ports.platform, ports.arch);
    const url = rustupInitUrl(triple);
    try {
        say(`${label}: downloading rustup-init from rust-lang.org`);
        const got = await ports.fetchBytes(url);
        if (!got.ok) return { kind: 'not-installed', reason: `rustup-init could not be downloaded from ${url} (${got.error}). Nothing was installed` };
        say(`${label}: checking rustup-init against the sha256 rust-lang.org publishes`);
        const published = await ports.fetchText(`${url}.sha256`);
        const want = published.ok ? parseSha256File(published.body) : null;
        if (want === null) return { kind: 'not-installed', reason: `the sha256 published beside rustup-init (${url}.sha256) could not be read${published.ok ? '' : ` (${published.error})`}, so rustup-init was not trusted. Nothing was installed` };
        const actual = createHash('sha256').update(got.body).digest('hex');
        if (actual !== want) return { kind: 'not-installed', reason: `rustup-init does not match the sha256 rust-lang.org publishes (expected ${want}, got ${actual}); it was discarded unopened. Nothing was installed` };
        return await putInPlace(version, triple, got.body, ports, say);
    } finally {
        ports.progress?.(null);
    }
}

async function putInPlace(version: string, triple: string, init: Uint8Array, ports: RustVersionsPorts, say: (step: string) => void): Promise<RustInstallOutcome> {
    const label = `Rust ${version}`;
    const staging = join(ports.root, `.staging-${version}`);
    const dir = join(ports.root, version);
    const homes = [`RUSTUP_HOME=${join(staging, 'rustup')}`, `CARGO_HOME=${join(staging, 'cargo')}`];
    const clean = () => {
        for (const p of [staging, dir]) {
            try { if (ports.fs.exists(p)) ports.fs.removeTree(p); } catch { /* the reason below is what matters */ }
        }
    };
    const fail = (reason: string): RustInstallOutcome => { clean(); return { kind: 'not-installed', reason: `${reason}. Nothing was installed` }; };
    const step = async (what: string, bin: string, args: readonly string[]): Promise<string | null> => {
        say(`${label}: ${what}`);
        let r: { stdout: string; exitCode: number };
        try {
            r = await ports.run(bin, args);
        } catch (error) {
            return `${label} could not be installed — ${what} did not run: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (r.exitCode === 0) return null;
        const words = r.stdout.trim().split(/\r?\n/).slice(-4).join(' | ').slice(-500);
        return `${label} could not be installed — ${what} failed (exit ${r.exitCode})${words ? `: ${words}` : ''}`;
    };
    try {
        if (ports.fs.exists(staging)) ports.fs.removeTree(staging);
        ports.fs.mkdirp(staging);
        const initPath = join(staging, 'rustup-init');
        ports.fs.writeBytes(initPath, init);
        const steps: Array<[string, string, readonly string[]]> = [
            ['making rustup-init runnable', 'chmod', ['+x', initPath]],
            ['setting up rustup (in Genie\'s staging home)', 'env', [...homes, initPath, '-y', '--no-modify-path', '--default-toolchain', 'none', '--profile', 'minimal']],
            [`downloading the ${version} toolchain (rustup verifies each part)`, 'env', [...homes, join(staging, 'cargo', 'bin', 'rustup'), 'toolchain', 'install', version, '--profile', 'minimal', '--no-self-update']],
        ];
        for (const [what, bin, args] of steps) {
            const problem = await step(what, bin, args);
            if (problem !== null) return fail(problem);
        }
        const toolchain = join(staging, 'rustup', 'toolchains', `${version}-${triple}`);
        if (!ports.fs.exists(rustcOf(toolchain))) return fail(`rustup finished, but ${toolchain} has no bin/rustc — the toolchain did not lay out the way Genie expected`);
        ports.fs.rename(toolchain, dir);
        ports.fs.removeTree(staging);

        say(`${label}: checking that it runs`);
        let said = '';
        try {
            said = (await ports.run(rustcOf(dir), ['-vV'])).stdout;
        } catch (error) {
            return fail(`${label} installed, but ${rustcOf(dir)} did not run: ${error instanceof Error ? error.message : String(error)}`);
        }
        const got = parseRustcVersion(said);
        if (!got) return fail(`${label} installed, but ${rustcOf(dir)} did not say a version: ${said.trim().slice(0, 200) || 'nothing'}`);
        if (got.version !== version) return fail(`Rust ${version} was asked for, but ${rustcOf(dir)} reports ${got.version}`);
        if (got.host !== triple) return fail(`Rust ${version} for ${triple} was asked for, but ${rustcOf(dir)} is for ${got.host}`);
        let cargo = '';
        try {
            cargo = (await ports.run(join(dir, 'bin', 'cargo'), ['--version'])).stdout.trim();
        } catch (error) {
            return fail(`${label} installed, but its cargo did not run: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!cargo.startsWith(`cargo ${version}`)) return fail(`${label} installed, but its cargo says: ${cargo.slice(0, 200) || 'nothing'}`);
        return { kind: 'installed', version, dir };
    } catch (error) {
        return fail(`${label} could not be put in place: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export function removeRustVersion(version: string, ports: Pick<RustVersionsPorts, 'root' | 'fs'>): RustRemoveOutcome {
    const target = managedRust(ports).find((m) => m.version === version);
    if (!target) return { kind: 'refused', reason: `Rust ${version} is not a version Genie manages here; Genie removes only what it installed` };
    try {
        ports.fs.removeTree(target.dir);
    } catch (error) {
        return { kind: 'refused', reason: `Rust ${version} could not be removed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (ports.fs.exists(rustcOf(target.dir))) return { kind: 'refused', reason: `Rust ${version} is still there after the delete (something running holds it); stop what uses it and try again` };
    return { kind: 'removed', version };
}
