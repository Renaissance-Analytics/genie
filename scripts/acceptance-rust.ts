/**
 * ACCEPTANCE — GENIE'S OWN RUST, FOR REAL (plan `.ai/plans/genie-2-toolchain-rest.md`, TC6b). Runs in omarchy-test with
 * the PRODUCT's functions and real effects: rust-lang.org's real rustup-init (sha256 beside it), the real rustup, the
 * real toolchain.
 *
 *   1. a tampered sha256 is refused, and nothing of it is left;
 *   2. Install Rust: proven (rustc names the version and host, cargo answers); no staging left; the person's shell
 *      files untouched;
 *   3. as the DEFAULT: `cargo` and `rustc` by name are current/rust/bin — NO rustup proxies, NO RUSTUP_HOME — and
 *      `cargo new` + `cargo run` builds and runs a program;
 *   4. listed as managed; Remove deletes it and it is no longer listed.
 *
 * Usage (in the VM, from the repo): npx tsx scripts/acceptance-rust.ts
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUST_RECIPES } from '../src/core/rust-versions.js';
import { httpFetch, nodePhpVersionsFs } from '../src/main/php-versions.js';
import { installRustVersion, listRustVersions, managedRust, removeRustVersion, type RustVersionsPorts } from '../src/main/rust-versions.js';
import { nodeLinkFs, restoreDefaultsEnv, setDefault } from '../src/main/toolchain-defaults.js';
import { execFileRunner } from '../src/main/toolchain-runner.js';

const results: boolean[] = [];
const check = (ok: boolean, label: string, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const run = async (bin: string, args: readonly string[], options?: { readonly env?: Readonly<Record<string, string>> }) => { const r = await execFileRunner(bin, args, { timeoutMs: 30 * 60_000, ...(options?.env ? { env: options.env } : {}) }); return { stdout: r.stdout, exitCode: r.exitCode }; };
const shellFiles = () => ['.profile', '.bashrc', '.bash_profile', '.zshrc', '.zprofile'].map((f) => join(homedir(), f)).map((f) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : '-')).join(',');

async function main(): Promise<void> {
    const base = mkdtempSync(join(tmpdir(), 'genie-rust-accept-'));
    const toolchainDir = join(base, 'genie2-toolchain');
    const root = join(toolchainDir, 'rust-versions');
    nodePhpVersionsFs().mkdirp(root);
    const platform = process.platform as RustVersionsPorts['platform'];
    const ports: RustVersionsPorts = {
        platform, arch: process.arch === 'arm64' ? 'arm64' : 'x64', root, fs: nodePhpVersionsFs(), run,
        fetchBytes: httpFetch.bytes, fetchText: httpFetch.text, progress: (s) => { if (s) console.log(`    … ${s}`); },
    };
    const V = RUST_RECIPES[0]!.version;
    const before = shellFiles();

    console.log('1. a tampered sha256');
    const tampered = await installRustVersion(V, true, { ...ports, fetchText: async () => ({ ok: true, body: `${'f'.repeat(64)}  *rustup-init\n` }) });
    check(tampered.kind === 'not-installed' && /does not match the sha256 rust-lang\.org publishes/.test(tampered.kind === 'not-installed' ? tampered.reason : ''), 'refused on a checksum mismatch', tampered.kind === 'not-installed' ? tampered.reason.slice(0, 140) : JSON.stringify(tampered));
    check(nodePhpVersionsFs().list(root).length === 0, 'nothing of it is left', nodePhpVersionsFs().list(root).join(', '));

    console.log(`2. Install Rust ${V}`);
    const t0 = Date.now();
    const installed = await installRustVersion(V, true, ports);
    check(installed.kind === 'installed', `installed in ${Math.round((Date.now() - t0) / 1000)} s`, installed.kind === 'installed' ? installed.dir : JSON.stringify(installed));
    if (installed.kind !== 'installed') return;
    check(nodePhpVersionsFs().list(root).every((e) => !e.startsWith('.')), 'no staging home left (rustup itself is gone)', nodePhpVersionsFs().list(root).join(', '));
    check(shellFiles() === before, "the person's shell files are untouched");

    console.log('3. Rust as the default — the toolchain alone, no rustup');
    const linkPorts = { platform, toolchainDir, fs: nodeLinkFs(platform) };
    check(setDefault('rust', V, { ...linkPorts, managed: () => managedRust(ports).map((m) => m.version) }).kind === 'set', 'setDefault rust');
    const env: Record<string, string> = { ...(process.env as Record<string, string>), CARGO_HOME: join(base, 'user-cargo') };
    delete env.RUSTUP_HOME; delete env.RUSTUP_TOOLCHAIN;
    env.PATH = '/usr/bin:/bin';
    restoreDefaultsEnv({ ...linkPorts, env: { get: (n) => env[n], set: (n, v) => { env[n] = v; } } });
    const sh = (cmd: string) => execFileSync('sh', ['-c', cmd], { encoding: 'utf8', env }).trim();
    check(sh('command -v cargo') === join(toolchainDir, 'current', 'rust', 'bin', 'cargo'), '`cargo` by name is current/rust/bin/cargo', sh('command -v cargo'));
    check(sh('rustc --version').startsWith(`rustc ${V} `), '`rustc --version` by name names it', sh('rustc --version'));
    const work = mkdtempSync(join(tmpdir(), 'genie-rust-app-'));
    const out = sh(`cd ${work} && cargo new --quiet hello && cd hello && cargo run --quiet`);
    check(out === 'Hello, world!', '`cargo new` + `cargo run` builds and runs a program', out);
    check(setDefault('rust', null, { ...linkPorts, managed: () => [] }).kind === 'cleared', 'the default cleared');

    console.log('4. list and Remove');
    check((await listRustVersions(ports)).managed.some((m) => m.version === V), 'listed as managed');
    check(removeRustVersion(V, ports).kind === 'removed' && !(await listRustVersions(ports)).managed.some((m) => m.version === V), 'removed, and no longer listed');

    console.log(`\n${results.every(Boolean) ? 'ACCEPTANCE PASSED' : 'ACCEPTANCE FAILED'} (${results.filter(Boolean).length}/${results.length})`);
    if (!results.every(Boolean)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
