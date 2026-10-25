/**
 * ACCEPTANCE — GENIE'S OWN RUST ON WINDOWS (the GNU toolchain), FOR REAL (plan `.ai/plans/genie-2-toolchain-rest.md`,
 * TC6b-2). Runs in the Windows test VM with the PRODUCT's functions: rust-lang.org's real rustup-init.exe (sha256 beside
 * it), the real rustup in a staging home (its homes through the runner's env option), the real toolchain.
 *
 *   1. a tampered sha256 is refused, and nothing of it is left;
 *   2. Install Rust: proven (rustc names the version and x86_64-pc-windows-gnu; cargo answers); no staging left;
 *   3. as the DEFAULT: `cargo` and `rustc` by name are current\rust\bin — no rustup proxies, no RUSTUP_HOME — and
 *      `cargo new` + `cargo run` COMPILES AND RUNS a program on a clean Windows (no Visual Studio);
 *   4. the user's PATH untouched and nothing registered (a positive reg-query control first);
 *   5. listed as managed; Remove deletes it and it is no longer listed.
 *
 * Usage (in the VM, from the repo): npx tsx scripts/acceptance-rust-windows.ts
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUST_RECIPES } from '../src/core/rust-versions.js';
import { httpFetch, nodePhpVersionsFs } from '../src/main/php-versions.js';
import { installRustVersion, listRustVersions, managedRust, removeRustVersion, type RustVersionsPorts } from '../src/main/rust-versions.js';
import { nodeLinkFs, restoreDefaultsEnv, setDefault } from '../src/main/toolchain-defaults.js';
import { execFileRunner } from '../src/main/toolchain-runner.js';

const results: boolean[] = [];
const check = (ok: boolean, label: string, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const run = async (bin: string, args: readonly string[], options?: { readonly env?: Readonly<Record<string, string>> }) => { const r = await execFileRunner(bin, args, { timeoutMs: 30 * 60_000, ...(options?.env ? { env: options.env } : {}) }); return { stdout: r.stdout, exitCode: r.exitCode }; };
const regHas = (key: string) => spawnSync('reg', ['query', key], { encoding: 'utf8' }).status === 0;
const userPath = () => spawnSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8' }).stdout;

async function main(): Promise<void> {
    const base = mkdtempSync(join(tmpdir(), 'genie-rust-win-accept-'));
    const toolchainDir = join(base, 'genie2-toolchain');
    const root = join(toolchainDir, 'rust-versions');
    nodePhpVersionsFs().mkdirp(root);
    const ports: RustVersionsPorts = {
        platform: 'win32', arch: 'x64', root, fs: nodePhpVersionsFs(), run,
        fetchBytes: httpFetch.bytes, fetchText: httpFetch.text, progress: (s) => { if (s) console.log(`    … ${s}`); },
    };
    const V = RUST_RECIPES[0]!.version;
    const pathBefore = userPath();

    console.log('1. a tampered sha256');
    const tampered = await installRustVersion(V, true, { ...ports, fetchText: async () => ({ ok: true, body: `${'f'.repeat(64)}  *rustup-init.exe\n` }) });
    check(tampered.kind === 'not-installed' && /does not match the sha256 rust-lang\.org publishes/.test(tampered.kind === 'not-installed' ? tampered.reason : ''), 'refused on a checksum mismatch', tampered.kind === 'not-installed' ? tampered.reason.slice(0, 140) : JSON.stringify(tampered));
    check(nodePhpVersionsFs().list(root).length === 0, 'nothing of it is left', nodePhpVersionsFs().list(root).join(', '));

    console.log(`2. Install Rust ${V} (GNU toolchain)`);
    const t0 = Date.now();
    const installed = await installRustVersion(V, true, ports);
    check(installed.kind === 'installed', `installed in ${Math.round((Date.now() - t0) / 1000)} s`, installed.kind === 'installed' ? installed.dir : JSON.stringify(installed));
    if (installed.kind !== 'installed') return;
    check(nodePhpVersionsFs().list(root).every((e) => !e.startsWith('.')), 'no staging home left (rustup itself is gone)', nodePhpVersionsFs().list(root).join(', '));

    console.log('3. Rust as the default — the toolchain alone, on a clean Windows');
    const linkPorts = { platform: 'win32' as const, toolchainDir, fs: nodeLinkFs('win32') };
    check(setDefault('rust', V, { ...linkPorts, managed: () => managedRust(ports).map((m) => m.version) }).kind === 'set', 'setDefault rust');
    const env: Record<string, string> = { ...(process.env as Record<string, string>), CARGO_HOME: join(base, 'user-cargo') };
    delete env['RUSTUP_HOME']; delete env['RUSTUP_TOOLCHAIN'];
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
    restoreDefaultsEnv({ ...linkPorts, env: { get: (n) => env[n === 'PATH' ? pathKey : n], set: (n, v) => { env[n === 'PATH' ? pathKey : n] = v; } } });
    const work = mkdtempSync(join(tmpdir(), 'genie-rust-app-'));
    const byName = (cmd: string, cwd = work) => execFileSync('cmd.exe', ['/d', '/c', `${cmd} 2>&1`], { encoding: 'utf8', env, cwd }).trim();
    const where = byName('where cargo').split(/\r?\n/)[0] ?? '';
    check(where.toLowerCase() === join(toolchainDir, 'current', 'rust', 'bin', 'cargo.exe').toLowerCase(), '`cargo` by name is current\\rust\\bin\\cargo.exe', where);
    check(byName('rustc --version').startsWith(`rustc ${V} `), '`rustc --version` by name names it', byName('rustc --version'));
    byName('cargo new --quiet hello');
    const out = byName('cargo run --quiet', join(work, 'hello')).split(/\r?\n/).pop() ?? '';
    check(out === 'Hello, world!', '`cargo new` + `cargo run` compiles and runs a program (no Visual Studio)', out);
    check(setDefault('rust', null, { ...linkPorts, managed: () => [] }).kind === 'cleared', 'the default cleared');

    console.log('4. nothing registered, PATH untouched');
    const control = 'HKCU\\Software\\GenieAcceptanceControl';
    execFileSync('reg', ['add', control, '/f']);
    check(regHas(control), 'CONTROL: reg query sees a key that exists');
    execFileSync('reg', ['delete', control, '/f']);
    check(!regHas('HKCU\\Software\\Rust') && !regHas('HKCU\\Software\\rustup'), 'no Rust or rustup keys');
    check(userPath() === pathBefore, "the user's PATH is untouched");

    console.log('5. list and Remove');
    check((await listRustVersions(ports)).managed.some((m) => m.version === V), 'listed as managed');
    check(removeRustVersion(V, ports).kind === 'removed' && !(await listRustVersions(ports)).managed.some((m) => m.version === V), 'removed, and no longer listed');

    console.log(`\n${results.every(Boolean) ? 'ACCEPTANCE PASSED' : 'ACCEPTANCE FAILED'} (${results.filter(Boolean).length}/${results.length})`);
    if (!results.every(Boolean)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
