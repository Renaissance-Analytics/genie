import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUBY_INDEX, RUBY_RECIPES, rubyShaFromIndex, rubySourceName, rubySourceUrl } from '../src/core/ruby-versions.js';
import { installRubyVersion, listRubyVersions, managedRuby, removeRubyVersion, type RubyVersionsPorts } from '../src/main/ruby-versions.js';
import type { Fetched, PhpVersionsFs } from '../src/main/php-versions.js';

/**
 * GENIE'S OWN RUBY ON LINUX, BUILT FROM ruby-lang.org's SOURCE (plan `.ai/plans/genie-2-toolchain-rest.md`, TC6c; the
 * owner's decision 2). Measured on omarchy-test (2026-10-25, 4.0.9): the tarball's sha256 is the one ruby-lang.org's
 * `pub/ruby/index.txt` lists; configure 35 s, make 74 s, install 3 s; openssl, psych, zlib, fiddle, readline and the
 * rest all load; `gem install` and bundler work. A library Ruby needs is named with its package BEFORE a byte is
 * downloaded (without libyaml, psych — and so gem and bundler — is quietly left out). The shared source builder
 * (main/source-build.ts) does the rest. Windows (RubyInstaller is community-run) and macOS wait on the owner.
 */

const ROOT = join('/data', 'genie2-toolchain', 'ruby-versions');
const V = RUBY_RECIPES[0]!.version;
const DIR = join(ROOT, V);
const TARBALL = new TextEncoder().encode('the official ruby source tarball');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function index(version: string, hash: string): string {
    const minor = version.split('.').slice(0, 2).join('.');
    return [
        'name\turl\tsha1\tsha256\tsha512',
        `ruby-${version}\thttps://cache.ruby-lang.org/pub/ruby/${minor}/ruby-${version}.tar.xz\t${'1'.repeat(40)}\t${'a'.repeat(64)}\t${'2'.repeat(128)}`,
        `ruby-${version}\thttps://cache.ruby-lang.org/pub/ruby/${minor}/ruby-${version}.zip\t${'1'.repeat(40)}\t${'b'.repeat(64)}\t${'2'.repeat(128)}`,
        `ruby-${version}\t${rubySourceUrl(version)}\t${'1'.repeat(40)}\t${hash}\t${'2'.repeat(128)}`,
    ].join('\n');
}

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

function ports(opts: { platform?: 'linux' | 'darwin' | 'win32'; missingPkgs?: string[]; noMake?: boolean; configureFails?: string; rubySays?: string; hash?: string; files?: string[] } = {}) {
    const disk = fakeFs(opts.files ?? []);
    const ran: string[] = [];
    const fetchedUrls: string[] = [];
    const p: RubyVersionsPorts = {
        platform: opts.platform ?? 'linux', arch: 'x64', root: ROOT, fs: disk.fs, cpus: 4,
        run: async (bin, args) => {
            ran.push(`${bin} ${args.join(' ')}`);
            if (bin === 'make' && args[0] === '--version') return opts.noMake ? Promise.reject(Object.assign(new Error('spawn make ENOENT'), { code: 'ENOENT' })) : { stdout: 'GNU Make', exitCode: 0 };
            if ((bin === 'cc' || bin === 'pkg-config') && args[0] === '--version') return { stdout: 'ok', exitCode: 0 };
            if (bin === 'pkg-config' && args[0] === '--exists') return { stdout: '', exitCode: (opts.missingPkgs ?? []).includes(args[1]!) ? 1 : 0 };
            if (bin === 'ruby') return { stdout: 'ruby 3.2.3 (2024-01-18 revision 52bb2ac0a6) [x86_64-linux-gnu]', exitCode: 0 };
            if (bin === 'tar') { disk.files.add(join(args[args.indexOf('-C') + 1]!, `ruby-${V}`, 'configure')); return { stdout: '', exitCode: 0 }; }
            if (bin === 'env') return opts.configureFails ? { stdout: opts.configureFails, exitCode: 1 } : { stdout: '', exitCode: 0 };
            if (bin === 'make' && args.includes('install')) { for (const f of ['bin/ruby', 'bin/gem', 'bin/bundle']) disk.files.add(join(DIR, ...f.split('/'))); return { stdout: '', exitCode: 0 }; }
            if (bin === 'make') return { stdout: '', exitCode: 0 };
            if (bin === join(DIR, 'bin', 'ruby')) return { stdout: opts.rubySays ?? `${V} x86_64-linux`, exitCode: 0 };
            if (bin === join(DIR, 'bin', 'gem')) return { stdout: '4.0.3\n', exitCode: 0 };
            return { stdout: '', exitCode: 0 };
        },
        fetchBytes: async (u): Promise<Fetched<Uint8Array>> => { fetchedUrls.push(u); return { ok: true, body: TARBALL }; },
        fetchText: async (u): Promise<Fetched<string>> => { fetchedUrls.push(u); return { ok: true, body: index(V, opts.hash ?? sha(TARBALL)) }; },
    };
    return { p, disk, ran, fetchedUrls, leftovers: () => [...disk.files].filter((f) => f.startsWith(ROOT)) };
}

describe('what Genie builds', () => {
    it("ruby-lang.org's gzipped source, with the sha256 its index.txt lists for EXACTLY that url", () => {
        expect(RUBY_RECIPES.map((r) => r.version)).toEqual(['4.0.9', '3.4.12', '3.3.13']);
        expect(rubySourceName('4.0.9')).toBe('ruby-4.0.9.tar.gz');
        expect(rubySourceUrl('3.4.12')).toBe('https://cache.ruby-lang.org/pub/ruby/3.4/ruby-3.4.12.tar.gz');
        expect(RUBY_INDEX).toBe('https://cache.ruby-lang.org/pub/ruby/index.txt');
        expect(rubyShaFromIndex(index('4.0.9', 'c'.repeat(64)), '4.0.9')).toBe('c'.repeat(64));
        expect(rubyShaFromIndex(index('4.0.9', 'c'.repeat(64)), '3.4.12')).toBeNull();
        expect(rubyShaFromIndex(index('4.0.9', 'nope'), '4.0.9')).toBeNull();
        expect(rubyShaFromIndex('<html>', '4.0.9')).toBeNull();
    });
});

describe('building one on Linux', () => {
    it('pre-flight, checked, configured into its own directory, built, PROVEN (the extensions a person needs, gem)', async () => {
        const a = ports();
        expect(await installRubyVersion(V, true, a.p)).toEqual({ kind: 'installed', version: V, dir: DIR });
        const src = join(ROOT, `.staging-${V}`, `ruby-${V}`);
        expect(a.ran).toContain(`env -C ${src} ./configure -q --prefix=${DIR} --disable-install-doc`);
        expect(a.ran).toContain(`make -s -C ${src} -j4`);
        expect(a.ran).toContain(`make -s -C ${src} install`);
        const proof = a.ran.find((c) => c.startsWith(`${join(DIR, 'bin', 'ruby')} `))!;
        for (const lib of ['openssl', 'psych', 'zlib', 'fiddle']) expect(proof).toContain(`require '${lib}'`);
        expect(a.ran).toContain(`${join(DIR, 'bin', 'gem')} --version`);
        expect(a.leftovers().filter((f) => f.includes('.staging-') || f.endsWith('.tar.gz'))).toEqual([]);
    });

    it('libraries Ruby needs and cannot find: ALL named with their packages, BEFORE anything is downloaded', async () => {
        const a = ports({ missingPkgs: ['yaml-0.1', 'libffi'] });
        const r = await installRubyVersion(V, true, a.p);
        expect(r.kind).toBe('refused');
        const reason = r.kind === 'refused' ? r.reason : '';
        for (const s of ['yaml-0.1', 'libffi', 'libyaml-dev', 'libffi-dev', 'libyaml-devel', 'libyaml']) expect(reason).toContain(s);
        expect(a.fetchedUrls).toEqual([]);
    });

    it('no make: refused before anything is downloaded, naming the build tools', async () => {
        const a = ports({ noMake: true });
        expect(await installRubyVersion(V, true, a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/C compiler, make and pkg-config/) });
        expect(a.fetchedUrls).toEqual([]);
    });

    it("a sha256 that is not ruby-lang.org's is never written or unpacked", async () => {
        const a = ports({ hash: 'f'.repeat(64) });
        expect(await installRubyVersion(V, true, a.p)).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/does not match the sha256 ruby-lang[.]org publishes/) });
        expect(a.fetchedUrls).toContain(RUBY_INDEX);
        expect(a.disk.counts.writeBytes).toBe(0);
    });

    it("configure's own words when it stops, and nothing is left", async () => {
        const a = ports({ configureFails: 'configure: error: something wicked' });
        expect(await installRubyVersion(V, true, a.p)).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/something wicked/) });
        expect(a.leftovers()).toEqual([]);
    });

    it('a ruby that cannot load what is needed, or is another version or platform: not an install, nothing left', async () => {
        for (const rubySays of ["<internal:...>: cannot load such file -- psych (LoadError)", '3.4.12 x86_64-linux', `${V} aarch64-linux`]) {
            const a = ports({ rubySays });
            expect((await installRubyVersion(V, true, a.p)).kind, rubySays).toBe('not-installed');
            expect(a.leftovers(), rubySays).toEqual([]);
        }
    });
});

describe('macOS (not supported; Windows is RubyInstaller: ruby-windows.test.ts)', () => {
    it('darwin: refused by name, nothing fetched, nothing offered', async () => {
        const a = ports({ platform: 'darwin' });
        expect(await installRubyVersion(V, true, a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/macOS/) });
        expect(a.fetchedUrls).toEqual([]);
        const view = await listRubyVersions(a.p);
        expect(view.available).toEqual([]);
        expect(view.installRefused).toMatch(/macOS/);
    });
});

describe('the list and removal on Linux', () => {
    it("Genie's built versions (bin/ruby there), the PATH ruby, every recipe offered", async () => {
        const a = ports({ files: [join(ROOT, '3.4.12', 'bin', 'ruby')] });
        expect(managedRuby(a.p).map((m) => m.version)).toEqual(['3.4.12']);
        const view = await listRubyVersions(a.p);
        expect(view.system).toEqual({ version: '3.2.3' });
        expect(view.available).toEqual(RUBY_RECIPES.map((r) => ({ version: r.version, installed: r.version === '3.4.12' })));
    });

    it('removes only what Genie built', () => {
        const a = ports({ files: [join(DIR, 'bin', 'ruby')] });
        expect(removeRubyVersion('2.7.8', a.p)).toMatchObject({ kind: 'refused' });
        expect(removeRubyVersion(V, a.p)).toEqual({ kind: 'removed', version: V });
        expect(a.leftovers()).toEqual([]);
    });
});
