import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUBYINSTALLER_DOWNLOADS, RUBY_RECIPES, rubyInstallerAsset, rubyInstallerShaFromPage, rubyInstallerUrl } from '../src/core/ruby-versions.js';
import { installRubyVersion, listRubyVersions, managedRuby, removeRubyVersion, type RubyVersionsPorts } from '../src/main/ruby-versions.js';
import type { Fetched, PhpVersionsFs } from '../src/main/php-versions.js';

/**
 * GENIE'S OWN RUBY ON WINDOWS — RubyInstaller (plan `.ai/plans/genie-2-toolchain-rest.md`, TC6e; the owner's pick,
 * q_bc7b2e49, 2026-10-25). ruby-lang.org publishes no Windows build and points Windows users to RubyInstaller, which
 * publishes a portable .7z per release and architecture. Measured on the Windows test VM (2026-10-25, 4.0.9-1): its
 * sha256 is the one rubyinstaller.org's own downloads page lists under that file's link (the same value GitHub's
 * release record keeps — but GitHub's API answered the VM 403, "API rate limit exceeded" for the shared address, so the
 * publisher's page, which has no such limit, is the source); Windows' OWN tar.exe (bsdtar, System32) unpacks a
 * .7z in 16 s — Git's tar, which can come first on PATH, cannot; the archive's one top folder is
 * `rubyinstaller-4.0.9-1-x64`; ruby loads openssl, psych, zlib and fiddle; gem installs; it runs after being moved; and
 * the user's PATH and registry are untouched. gem is a .cmd, which Node will not run without a shell, and `ruby -S gem`
 * finds no gem script during the install (measured: "No such file or directory -- gem" — -S searches PATH, and the
 * new bin is not on it), so RubyGems is asked through ruby itself: `ruby -e "require 'rubygems'; print Gem::VERSION"`.
 */

const ROOT = join('C:', 'genie2-toolchain', 'ruby-versions');
const V = RUBY_RECIPES[0]!.version;
const DIR = join(ROOT, V);
const TAR = join('C:', 'Windows', 'System32', 'tar.exe');
const ARCHIVE = new TextEncoder().encode('the rubyinstaller 7z');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The shape of rubyinstaller.org/downloads/: each file's link, then its own details list with its SHA256. */
const entry = (url: string, hash: string | null) => `<li class="ridkexe"><a class="downloadlink " href="${url}">x</a><ul class="downloadinfo"><li>download <a href="${url}.asc">PGP signature</a></li>${hash === null ? '' : `<li>SHA256: <input class="js-copytextinput buttonbox" value="${hash}" /></li>`}</ul></li>`;
function page(version: string, hash: string | null, url = rubyInstallerUrl(version, 'x64')): string {
    return `<h3>with Devkit</h3><ul>${entry(url.replace('rubyinstaller-', 'rubyinstaller-devkit-').replace('.7z', '.exe'), 'a'.repeat(64))}</ul>`
        + `<h3>archives</h3><ul>${entry(url, hash)}${entry(url.replace(version, '9.9.9'), 'b'.repeat(64))}</ul>`;
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

function ports(opts: { hash?: string; rubySays?: string; gemFails?: boolean; files?: string[] } = {}) {
    const disk = fakeFs(opts.files ?? []);
    const ran: string[] = [];
    const fetchedUrls: string[] = [];
    const p: RubyVersionsPorts = {
        platform: 'win32', arch: 'x64', root: ROOT, fs: disk.fs, windowsTar: TAR,
        run: async (bin, args) => {
            ran.push(`${bin} ${args.join(' ')}`);
            if (bin === TAR) {
                const to = args[args.indexOf('-C') + 1]!;
                for (const f of ['bin/ruby.exe', 'bin/gem.cmd', 'bin/bundle.bat']) disk.files.add(join(to, `rubyinstaller-${V}-1-x64`, ...f.split('/')));
                return { stdout: '', exitCode: 0 };
            }
            if (bin === 'ruby') return Promise.reject(Object.assign(new Error('spawn ruby ENOENT'), { code: 'ENOENT' }));
            if (bin === join(DIR, 'bin', 'ruby.exe') && args.join(' ').includes('Gem::VERSION')) return opts.gemFails ? { stdout: 'cannot load such file -- rubygems (LoadError)', exitCode: 1 } : { stdout: '4.0.3', exitCode: 0 };
            if (bin === join(DIR, 'bin', 'ruby.exe')) return { stdout: opts.rubySays ?? `${V} x64-mingw-ucrt`, exitCode: 0 };
            return { stdout: '', exitCode: 0 };
        },
        fetchBytes: async (u): Promise<Fetched<Uint8Array>> => { fetchedUrls.push(u); return { ok: true, body: ARCHIVE }; },
        fetchText: async (u): Promise<Fetched<string>> => { fetchedUrls.push(u); return { ok: true, body: page(V, opts.hash ?? sha(ARCHIVE)) }; },
    };
    return { p, disk, ran, fetchedUrls, leftovers: () => [...disk.files].filter((f) => f.startsWith(ROOT)) };
}

describe('what Genie installs on Windows', () => {
    it("RubyInstaller's portable .7z for each recipe, and the SHA256 its own page lists for EXACTLY that file", () => {
        expect(rubyInstallerAsset('4.0.9', 'x64')).toBe('rubyinstaller-4.0.9-1-x64.7z');
        expect(rubyInstallerAsset('3.4.12', 'arm64')).toBe('rubyinstaller-3.4.12-1-arm.7z');
        expect(rubyInstallerUrl('4.0.9', 'x64')).toBe('https://github.com/oneclick/rubyinstaller2/releases/download/RubyInstaller-4.0.9-1/rubyinstaller-4.0.9-1-x64.7z');
        expect(RUBYINSTALLER_DOWNLOADS).toBe('https://rubyinstaller.org/downloads/');
        expect(rubyInstallerShaFromPage(page('4.0.9', 'c'.repeat(64)), '4.0.9', 'x64')).toBe('c'.repeat(64));
        // A file with NO SHA256 of its own is null — never the next file's (measured: 3.3.13 arm is not listed at all).
        expect(rubyInstallerShaFromPage(page('4.0.9', null), '4.0.9', 'x64')).toBeNull();
        expect(rubyInstallerShaFromPage(page('4.0.9', 'nope'), '4.0.9', 'x64')).toBeNull();
        expect(rubyInstallerShaFromPage(page('4.0.9', 'c'.repeat(64)), '3.4.12', 'x64')).toBeNull();
        expect(rubyInstallerShaFromPage('<html>maintenance</html>', '4.0.9', 'x64')).toBeNull();
    });
});

describe('installing one on Windows', () => {
    it("checked, unpacked by Windows' OWN tar.exe, moved to ruby-versions/<version>, PROVEN by ruby and gem", async () => {
        const a = ports();
        expect(await installRubyVersion(V, true, a.p)).toEqual({ kind: 'installed', version: V, dir: DIR });
        expect(a.fetchedUrls).toEqual([rubyInstallerUrl(V, 'x64'), RUBYINSTALLER_DOWNLOADS]);
        expect(a.ran.find((c) => c.startsWith(TAR))).toMatch(new RegExp(`^${TAR.replace(/[\\.]/g, (c) => `\\${c}`)} -xf \\S+rubyinstaller-${V.replace(/[.]/g, '[.]')}-1-x64[.]7z -C \\S+[.]staging-`));
        const proof = a.ran.find((c) => c.startsWith(`${join(DIR, 'bin', 'ruby.exe')} -e`))!;
        for (const lib of ['openssl', 'psych', 'zlib', 'fiddle']) expect(proof).toContain(`require '${lib}'`);
        expect(a.ran).toContain(`${join(DIR, 'bin', 'ruby.exe')} -e require 'rubygems'; print Gem::VERSION`);
        // No build tools are asked for on Windows: nothing is compiled.
        expect(a.ran.some((c) => /^(cc|make|pkg-config) /.test(c))).toBe(false);
        expect(a.leftovers().filter((f) => f.includes('.staging-') || f.endsWith('.7z'))).toEqual([]);
    });

    it("an archive whose sha256 is not the one RubyInstaller lists is never written or unpacked", async () => {
        const a = ports({ hash: 'f'.repeat(64) });
        expect(await installRubyVersion(V, true, a.p)).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/does not match the sha256 RubyInstaller publishes/) });
        expect(a.disk.counts.writeBytes).toBe(0);
        expect(a.ran.some((c) => c.startsWith(TAR))).toBe(false);
    });

    it('a ruby that is another version or platform, or whose gem does not answer, is not an install — nothing left', async () => {
        for (const o of [{ rubySays: `3.4.12 x64-mingw-ucrt` }, { rubySays: `${V} x86_64-linux` }, { gemFails: true }]) {
            const a = ports(o);
            expect((await installRubyVersion(V, true, a.p)).kind, JSON.stringify(o)).toBe('not-installed');
            expect(a.leftovers(), JSON.stringify(o)).toEqual([]);
        }
    });
});

describe('the list and removal on Windows', () => {
    it("Genie's versions (bin\\ruby.exe there) and every recipe offered — no refusal line", async () => {
        const a = ports({ files: [join(ROOT, '3.4.12', 'bin', 'ruby.exe')] });
        expect(managedRuby(a.p).map((m) => m.version)).toEqual(['3.4.12']);
        const view = await listRubyVersions(a.p);
        expect(view.installRefused).toBeUndefined();
        expect(view.available).toEqual(RUBY_RECIPES.map((r) => ({ version: r.version, installed: r.version === '3.4.12' })));
    });

    it('removes what Genie installed', () => {
        const a = ports({ files: [join(DIR, 'bin', 'ruby.exe')] });
        expect(removeRubyVersion(V, a.p)).toEqual({ kind: 'removed', version: V });
        expect(a.leftovers()).toEqual([]);
    });
});
