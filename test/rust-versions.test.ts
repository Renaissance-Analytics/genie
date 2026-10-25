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
 * only. Windows waits on the owner (the MSVC toolchain cannot link on a clean Windows; the GNU one can).
 */

const ROOT = join('/data', 'genie2-toolchain', 'rust-versions');
const V = RUST_RECIPES[0]!.version;
const INIT = new TextEncoder().encode('the official rustup-init bytes');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const STAGE = join(ROOT, `.staging-${V}`);

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
    const fetchedUrls: string[] = [];
    const p: RustVersionsPorts = {
        platform, arch, root: ROOT, fs: disk.fs,
        run: async (bin, args) => {
            ran.push(`${bin} ${args.join(' ')}`);
            if (bin === 'cc') return opts.noCc ? Promise.reject(Object.assign(new Error('spawn cc ENOENT'), { code: 'ENOENT' })) : { stdout: 'cc 15', exitCode: 0 };
            if (bin === 'rustc' && args[0] === '--version') return Promise.reject(Object.assign(new Error('spawn rustc ENOENT'), { code: 'ENOENT' }));
            if (bin === 'chmod') return { stdout: '', exitCode: 0 };
            if (bin === 'env') {
                const cmd = args.find((a) => !a.includes('='))!;
                if (cmd.endsWith('rustup-init')) { disk.files.add(join(STAGE, 'cargo', 'bin', 'rustup')); return { stdout: '', exitCode: 0 }; }
                if (cmd.endsWith(join('cargo', 'bin', 'rustup')) && args.includes('toolchain')) {
                    if (opts.toolchainFails) return { stdout: 'error: could not download file from https://static.rust-lang.org/…', exitCode: 1 };
                    for (const b of ['rustc', 'cargo']) disk.files.add(join(STAGE, 'rustup', 'toolchains', `${V}-${triple}`, 'bin', b));
                    return { stdout: `  ${V}-${triple} installed - rustc ${V}`, exitCode: 0 };
                }
            }
            if (bin === join(ROOT, V, 'bin', 'rustc')) return { stdout: opts.rustcSays ?? `rustc ${V} (58cf8f9c3 2026-10-13)\nbinary: rustc\nhost: ${triple}\nrelease: ${V}\n`, exitCode: 0 };
            if (bin === join(ROOT, V, 'bin', 'cargo')) return { stdout: `cargo ${V} (5f94df478 2026-08-27)\n`, exitCode: 0 };
            return { stdout: '', exitCode: 0 };
        },
        fetchBytes: async (u): Promise<Fetched<Uint8Array>> => { fetchedUrls.push(u); return { ok: true, body: INIT }; },
        fetchText: async (u): Promise<Fetched<string>> => { fetchedUrls.push(u); return { ok: true, body: `${opts.publishedSha ?? sha(INIT)}  *rustup-init\n` }; },
    };
    return { p, disk, ran, fetchedUrls, leftovers: () => [...disk.files].filter((f) => f.startsWith(ROOT)) };
}

describe('what Genie installs', () => {
    it('the supported stable lines, newest first; rustup-init from static.rust-lang.org for this machine', () => {
        expect(RUST_RECIPES.map((r) => r.version)).toEqual(['1.99.1', '1.98.1']);
        expect(rustTriple('linux', 'x64')).toBe('x86_64-unknown-linux-gnu');
        expect(rustTriple('linux', 'arm64')).toBe('aarch64-unknown-linux-gnu');
        expect(rustTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin');
        expect(rustupInitUrl('x86_64-unknown-linux-gnu')).toBe('https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init');
    });

    it('`rustc -vV` is read for its version and host', () => {
        expect(parseRustcVersion('rustc 1.99.1 (58cf8f9c3 2026-10-13)\nbinary: rustc\nhost: x86_64-unknown-linux-gnu\nrelease: 1.99.1\n')).toEqual({ version: '1.99.1', host: 'x86_64-unknown-linux-gnu' });
        expect(parseRustcVersion('error: no such command')).toBeNull();
    });
});

describe('installing one on Linux and macOS', () => {
    for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'arm64']] as const) {
        it(`${platform}/${arch}: rustup in a STAGING home (env, argv), the toolchain moved to rust-versions/<version>, PROVEN there`, async () => {
            const a = ports({ platform, arch });
            expect(await installRustVersion(V, true, a.p)).toEqual({ kind: 'installed', version: V, dir: join(ROOT, V) });
            const homes = [`RUSTUP_HOME=${join(STAGE, 'rustup')}`, `CARGO_HOME=${join(STAGE, 'cargo')}`];
            const init = a.ran.find((c) => c.startsWith('env ') && c.includes('rustup-init'))!;
            expect(init).toBe(`env ${homes.join(' ')} ${join(STAGE, 'rustup-init')} -y --no-modify-path --default-toolchain none --profile minimal`);
            expect(a.ran).toContain(`env ${homes.join(' ')} ${join(STAGE, 'cargo', 'bin', 'rustup')} toolchain install ${V} --profile minimal --no-self-update`);
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

describe('Windows (waiting on the owner: MSVC needs Visual Studio Build Tools; GNU links on its own)', () => {
    it('install is refused by name and nothing is fetched; the list says why', async () => {
        const a = ports({ platform: 'win32' });
        expect(await installRustVersion(V, true, a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/Windows/) });
        expect(a.fetchedUrls).toEqual([]);
        const view = await listRustVersions(a.p);
        expect(view.available).toEqual([]);
        expect(view.installRefused).toMatch(/Windows/);
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
