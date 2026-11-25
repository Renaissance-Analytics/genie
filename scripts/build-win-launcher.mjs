#!/usr/bin/env node
/**
 * BUILD genie-launch.exe ON WINDOWS: the launcher (native/launcher, Rust; Tynn #1058 L2), whose `detach`, `job` and
 * `pipe-owner-only` modes are genie-launch.c's (#1628, #1639, Tynn #398) with the same contracts. Nothing prebuilt is
 * checked in: CI and the release build it from source with cargo (MSVC), and electron-builder packs it (resources/bin)
 * with the app. Until the install layout moves it into the NSIS folder as Genie.exe (L3), it keeps this name and place,
 * so the sign plan, the packed tree and every caller (src/main/win-launcher.ts) read it where they always have.
 *
 * Elsewhere it does nothing but leave the (empty) output folder electron-builder reads. On a Windows machine with no
 * cargo it says so and exits 0 (Genie then starts its processes with Node's spawn, as before) EXCEPT on CI (CI=true),
 * where a missing toolchain is a failure: a Windows build that ships without the launcher must never pass.
 *
 * The release build has no cargo features: the launcher's test-only keys exist only under `--features test-keys`,
 * which only its own `cargo test` passes (native/launcher/tests/source_guard.rs holds this file to that).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'build', 'win-launcher');
const out = join(outDir, 'genie-launch.exe');
const crate = join(root, 'native', 'launcher');
mkdirSync(outDir, { recursive: true });

if (process.platform !== 'win32') {
    console.log('[win-launcher] not Windows: nothing to build');
    process.exit(0);
}
const ci = process.env.CI === 'true';
const fail = (why) => {
    if (ci) { console.error(`[win-launcher] FAILED on CI: ${why}`); process.exit(1); }
    console.warn(`[win-launcher] not built (${why}); Genie falls back to Node's spawn on this machine`);
    process.exit(0);
};

// cargo by its absolute path: rustup's own place first, then what PATH names (never a bare name run through a shell).
const candidates = [join(homedir(), '.cargo', 'bin', 'cargo.exe')];
for (const dir of (process.env.PATH ?? '').split(';')) if (dir) candidates.push(join(dir, 'cargo.exe'));
const cargo = candidates.find((p) => existsSync(p));
if (!cargo) fail('no cargo (install Rust with rustup; the MSVC Build Tools are its linker)');

const args = ['build', '--release', '--bin', 'genie', '--manifest-path', join(crate, 'Cargo.toml')];
if (existsSync(join(crate, 'Cargo.lock'))) args.push('--locked');
try {
    execFileSync(cargo, args, { stdio: 'inherit', cwd: crate });
} catch (error) { fail(`cargo failed: ${error.message}`); }
const built = join(crate, 'target', 'release', 'genie.exe');
if (!existsSync(built) || statSync(built).size === 0) fail('cargo produced no genie.exe');
copyFileSync(built, out);
console.log(`[win-launcher] built ${out} from native/launcher (${statSync(out).size} bytes)`);
