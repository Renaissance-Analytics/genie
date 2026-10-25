import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUST_RECIPES, parseRustcVersion, rustTriple, rustupInitUrl } from '../src/core/rust-versions.js';
import { installRustVersion, listRustVersions, managedRust, removeRustVersion, type RustVersionsPorts } from '../src/main/rust-versions.js';
import type { Fetched, PhpVersionsFs } from '../src/main/php-versions.js';

/**
 * GENIE'S OWN RUST (plan `.ai/plans/genie-2-toolchain-rest.md`, TC6b). rustup is the official installer, and it verifies
 * every component it downloads against the channel's manifest. Measured on omarchy-test (2026-10-25, 1.99.1):
 * rustup-init's sha256 is published beside it; a toolchain installs in 16 s into a RUSTUP_HOME Genie chooses, with the
 * person's shell files untouched; and the toolchain's OWN bin/ (cargo, rustc), reached through a symlink, builds and
 * runs a program with NO rustup proxies and NO RUSTUP_HOME. So Genie uses rustup only as the downloader, in a staging
 * home of its own, and keeps the toolchain directory at `<toolchain>/rust-versions/<version>` — the same shape as every
 * other language, so the default is the same `current/rust` link. Every rustup run gets its homes through `env`, argv
 * only. On WINDOWS the GNU toolchain (the owner's pick, q_7e642512): measured, the MSVC one cannot link on a clean Windows
 * (it needs Visual Studio's linker) and the GNU one carries its own. The homes reach rustup through the runner's own
 * `env` option — argv only, no `env` command (Windows has none), no shell.
 */

const ROOT = join('/data', 'genie2-toolchain', 'rust-versions');
const V = RUST_RECIPES[0]!.version;
const INIT = new TextEncoder().encode('the official rustup-init bytes');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const STAGE = join(ROOT, `.staging-${V}`);
const exe = (platform: string, name: string) => (platform === 'win32' ? `${name}.exe` : name);

function fakeFs(initial: string[] = []) {
    const files = new Set<string>(initial);
    const counts = { writeBytes: 0 };
    const under = (f: string, p: string) => f === p || f.startsWith(`${p}/`) || f.startsWith(`${p}\\`);
    const fs: PhpVersionsFs = {
        exists: (p) => [...files].some((f) => under(f, p)),
        list: (d) => [...new Set([...files].filter((f) => f.startsWith(`${d}/`) || f.startsWith(`${d}\\`)).map((f) => f.slice(d.length + 1).split(/[\\/]/)[0]!))],
        mkdirp: () => {},
        writeText: (p) => { files.add(p); },
        writeBytes: (p) => { counts.writeBytes += 1; files.add(p); },
        rename: (a, b) => { for (const f of [...files]) if (under(f, a)) { files.delete(f); files.add(b + f.slice(a.length)); } },
        removeTree: (p) => { for (const f of [...files]) if (under(f, p)) files.delete(f); },
    };
    return { fs, files, counts };
}

function ports(opts: { platform?: 'linux' | 'darwin' | 'win32'; arch?: 'x64' | 'arm64'; publishedSha?: string; noCc?: boolean; toolchainFails?: boolean; rustcSays?: string; files?: string[] } = {}) {
    const platform = opts.platform ?? 'linux';
    const arch = opts.arch ?? 'x64';
    const triple = rustTriple(platform, arch);
    const disk = fakeFs(opts.files ?? []);
    const ran: string[] = [];
    const envs: Array<Readonly<Record<string, string>> | undefined> = [];
    const fetchedUrls: string[] = [];
    const p: RustVersionsPorts = {
        platform, arch, root: ROOT, fs: disk.fs,
        run: async (bin, args, options) => {
            ran.push(`${bin} ${args.join(' ')}`);
            envs.push(options?.env);
            if (bin === 'cc') return opts.noCc ? Promise.reject(Object.assign(new Error('spawn cc ENOENT'), { code: 'ENOENT' })) : { stdout: 'cc 15', exitCode: 0 };
            if (bin === 'rustc' && args[0] === '--version') return Promise.reject(Object.assign(new Error('spawn rustc ENOENT'), { code: 'ENOENT' }));
            if (bin === 'chmod') return { stdout: '', exitCode: 0 };
            if (bin === join(STAGE, exe(platform, 'rustup-init'))) { disk.files.add(join(STAGE, 'cargo', 'bin', exe(platform, 'rustup'))); return { stdout: '', exitCode: 0 }; }
            if (bin === join(STAGE, 'cargo', 'bin', exe(platform, 'rustup')) && args.includes('toolchain')) {
                if (opts.toolchainFails) return { stdout: 'error: could not download file from https://static.rust-lang.org/…', exitCode: 1 };
                // As MEASURED on the Windows VM: a bare version installs for rustup's OWN default host — MSVC on Windows,
                // whichever rustup-init ran — so only a fully qualified name lands where the GNU toolchain is expected.
                const asked = args[args.indexOf('install') + 1]!;
                const name = asked.includes('-') ? asked : `${asked}-${platform === 'win32' ? 'x86_64-pc-windows-msvc' : triple}`;
                for (const b of ['rustc', 'cargo']) disk.files.add(join(STAGE, 'rustup', 'toolchains', name, 'bin', exe(platform, b)));
                return { stdout: `  ${name} installed - rustc ${V}`, exitCode: 0 };
            }
            if (bin === join(ROOT, V, 'bin', exe(platform, 'rustc'))) return { stdout: opts.rustcSays ?? `rustc ${V} (58cf8f9c3 2026-10-13)\nbinary: rustc\nhost: ${triple}\nrelease: ${V}\n`, exitCode: 0 };
            if (bin === join(ROOT, V, 'bin', exe(platform, 'cargo'))) return { stdout: `cargo ${V} (5f94df478 2026-08-27)\n`, exitCode: 0 };
            return { stdout: '', exitCode: 0 };
        },
        fetchBytes: async (u): Promise<Fetched<Uint8Array>> => { fetchedUrls.push(u); return { ok: true, body: INIT }; },
        fetchText: async (u): Promise<Fetched<string>> => { fetchedUrls.push(u); return { ok: true, body: `${opts.publishedSha ?? sha(INIT)}  *rustup-init\n` }; },
    };
    return { p, disk, ran, envs, fetchedUrls, leftovers: () => [...disk.files].filter((f) => f.startsWith(ROOT)) };
}

describe('what Genie installs', () => {
    it('the supported stable lines, newest first; rustup-init from static.rust-lang.org for this machine', () => {
        expect(RUST_RECIPES.map((r) => r.version)).toEqual(['1.99.1', '1.98.1']);
        expect(rustTriple('linux', 'x64')).toBe('x86_64-unknown-linux-gnu');
        expect(rustTriple('linux', 'arm64')).toBe('aarch64-unknown-linux-gnu');
        expect(rustTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin');
        // Windows: the GNU toolchain — it links on a clean Windows; MSVC needs Visual Studio's linker (measured).
        expect(rustTriple('win32', 'x64')).toBe('x86_64-pc-windows-gnu');
        expect(rustupInitUrl('x86_64-pc-windows-gnu')).toBe('https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-gnu/rustup-init.exe');
        expect(rustupInitUrl('x86_64-unknown-linux-gnu')).toBe('https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init');
    });

    it('`rustc -vV` is read for its version and host', () => {
        expect(parseRustcVersion('rustc 1.99.1 (58cf8f9c3 2026-10-13)\nbinary: rustc\nhost: x86_64-unknown-linux-gnu\nrelease: 1.99.1\n')).toEqual({ version: '1.99.1', host: 'x86_64-unknown-linux-gnu' });
        expect(parseRustcVersion('error: no such command')).toBeNull();
    });
});

describe('installing one on Linux and macOS', () => {
    for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'arm64']] as const) {
        it(`${platform}/${arch}: rustup in a STAGING home (the runner's env, argv), the toolchain moved to rust-versions/<version>, PROVEN there`, async () => {
            const a = ports({ platform, arch });
            expect(await installRustVersion(V, true, a.p)).toEqual({ kind: 'installed', version: V, dir: join(ROOT, V) });
            const homes = { RUSTUP_HOME: join(STAGE, 'rustup'), CARGO_HOME: join(STAGE, 'cargo') };
            const initAt = a.ran.indexOf(`${join(STAGE, 'rustup-init')} -y --no-modify-path --default-toolchain none --profile minimal`);
            expect(initAt).toBeGreaterThanOrEqual(0);
            expect(a.envs[initAt]).toEqual(homes);
            const tcAt = a.ran.indexOf(`${join(STAGE, 'cargo', 'bin', 'rustup')} toolchain install ${V}-${rustTriple(platform, arch)} --profile minimal --no-self-update`);
            expect(tcAt).toBeGreaterThanOrEqual(0);
            expect(a.envs[tcAt]).toEqual(homes);
            // No `env` command (Windows has none), no shell.
            expect(a.ran.some((c) => c.startsWith('env '))).toBe(false);
            expect(a.disk.files.has(join(ROOT, V, 'bin', 'cargo'))).toBe(true);
            expect(a.ran).toContain(`${join(ROOT, V, 'bin', 'rustc')} -vV`);
            expect(a.ran).toContain(`${join(ROOT, V, 'bin', 'cargo')} --version`);
            // The staging home (rustup itself, its downloads) is gone: what stays is the toolchain directory.
            expect(a.leftovers().filter((f) => f.includes('.staging-'))).toEqual([]);
        });
    }

    it('no C compiler (rustc links with it): refused BEFORE anything is downloaded, naming what to install', async () => {
        const a = ports({ noCc: true });
        const r = await installRustVersion(V, true, a.p);
        expect(r).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/linker/) });
        expect(r.kind === 'refused' && r.reason).toMatch(/build-essential/);
        expect(a.fetchedUrls).toEqual([]);
    });

    it("a rustup-init whose sha256 is not the one published beside it is never written or run", async () => {
        const a = ports({ publishedSha: 'f'.repeat(64) });
        expect(await installRustVersion(V, true, a.p)).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/does not match the sha256 rust-lang[.]org publishes/) });
        expect(a.fetchedUrls).toContain(`${rustupInitUrl('x86_64-unknown-linux-gnu')}.sha256`);
        expect(a.disk.counts.writeBytes).toBe(0);
        expect(a.ran.some((c) => c.includes('rustup-init'))).toBe(false);
    });

    it("rustup failing to fetch the toolchain is said in its own words, and nothing is left", async () => {
        const a = ports({ toolchainFails: true });
        expect(await installRustVersion(V, true, a.p)).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/could not download/) });
        expect(a.leftovers()).toEqual([]);
    });

    it('a rustc that reports another version or another host is not an install — nothing left', async () => {
        for (const rustcSays of ['rustc 1.98.1 (x)\nhost: x86_64-unknown-linux-gnu\n', `rustc ${V} (x)\nhost: aarch64-unknown-linux-gnu\n`]) {
            const a = ports({ rustcSays });
            expect((await installRustVersion(V, true, a.p)).kind, rustcSays).toBe('not-installed');
            expect(a.leftovers(), rustcSays).toEqual([]);
        }
    });

    it('nothing without consent; an unknown version is refused by name', async () => {
        const a = ports();
        expect(await installRustVersion(V, false, a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/go-ahead/) });
        expect(await installRustVersion('1.80.0', true, a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/no installer for Rust 1[.]80[.]0/) });
        expect(a.fetchedUrls).toEqual([]);
    });
});

describe('Windows: the GNU toolchain (the owner, q_7e642512)', () => {
    it('rustup-init.exe for the GNU host, no chmod and no C compiler asked for (GNU links on its own), PROVEN as that host', async () => {
        const a = ports({ platform: 'win32' });
        expect(await installRustVersion(V, true, a.p)).toEqual({ kind: 'installed', version: V, dir: join(ROOT, V) });
        expect(a.fetchedUrls).toEqual([rustupInitUrl('x86_64-pc-windows-gnu'), `${rustupInitUrl('x86_64-pc-windows-gnu')}.sha256`]);
        const initAt = a.ran.indexOf(`${join(STAGE, 'rustup-init.exe')} -y --no-modify-path --default-toolchain none --profile minimal`);
        expect(a.envs[initAt]).toEqual({ RUSTUP_HOME: join(STAGE, 'rustup'), CARGO_HOME: join(STAGE, 'cargo') });
        // Fully qualified: a bare version would land under rustup's default host, MSVC (measured).
        expect(a.ran).toContain(`${join(STAGE, 'cargo', 'bin', 'rustup.exe')} toolchain install ${V}-x86_64-pc-windows-gnu --profile minimal --no-self-update`);
        expect(a.ran.some((c) => c.startsWith('chmod ') || c.startsWith('cc '))).toBe(false);
        expect(a.ran).toContain(`${join(ROOT, V, 'bin', 'rustc.exe')} -vV`);
        expect(a.leftovers().filter((f) => f.includes('.staging-'))).toEqual([]);
        expect((await listRustVersions(a.p)).available.map((r) => r.version)).toEqual(RUST_RECIPES.map((r) => r.version));
    });

    it('Windows on ARM is refused by name (not measured), nothing fetched', async () => {
        const a = ports({ platform: 'win32', arch: 'arm64' });
        expect(await installRustVersion(V, true, a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/ARM/) });
        expect(a.fetchedUrls).toEqual([]);
    });
});

describe('the list and removal', () => {
    it("Genie's versions (bin/rustc there), newest first, and the PATH rustc", async () => {
        const a = ports({ files: [join(ROOT, '1.98.1', 'bin', 'rustc'), join(ROOT, V, 'bin', 'rustc'), join(STAGE, 'rustup', 'x')] });
        expect(managedRust(a.p).map((m) => m.version)).toEqual([V, '1.98.1']);
        const view = await listRustVersions(a.p);
        expect(view.system).toBeNull();
        expect(view.available).toEqual(RUST_RECIPES.map((r) => ({ version: r.version, installed: true })));
    });

    it('removes only what Genie installed', () => {
        const a = ports({ files: [join(ROOT, V, 'bin', 'rustc')] });
        expect(removeRustVersion('1.80.0', a.p)).toMatchObject({ kind: 'refused' });
        expect(removeRustVersion(V, a.p)).toEqual({ kind: 'removed', version: V });
        expect(a.leftovers()).toEqual([]);
    });
});
