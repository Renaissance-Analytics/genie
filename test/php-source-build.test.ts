import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHP_INI_EXTENSIONS, PHP_RECIPES, managedCgiCommand, phpIniContents, phpReleaseJsonUrl, phpSourceName, phpSourceShaFromJson, phpSourceUrl } from '../src/core/php-versions.js';
import { installPhpVersion, listPhpVersions, managedPhp, removePhpVersion, resolvePhpCgi, type Fetched, type PhpVersionsFs, type PhpVersionsPorts } from '../src/main/php-versions.js';

/**
 * GENIE'S OWN PHP ON LINUX, BUILT FROM php.net's SOURCE (plan `.ai/plans/genie-2-toolchain-rest.md`, TC5; the owner's
 * decision 2). Measured on omarchy-test (2026-10-24, 8.4.27): php.net's release JSON publishes the tarball's sha256;
 * configure 37 s, make 160 s, install 32 s; EVERY extension Genie's PHP enables (PHP_INI_EXTENSIONS) compiled in, plus
 * php-cgi, php-fpm and a loadable opcache. Genie builds it with bindir and sbindir = the version's own directory, so
 * `php`, `php-cgi` and `php.ini` sit where they do on Windows — the managed list, a site's pin, the default's PATH entry
 * and Remove need no second layout. A library configure needs and cannot find is named, with its package, BEFORE a byte
 * is downloaded; whatever is still wrong is configure's own words; and a build that leaves nothing behind otherwise.
 */

const ROOT = join('/data', 'genie2-toolchain', 'php-versions');
const V = PHP_RECIPES[1]!.version; // 8.4.27 — the line the build was measured on
const DIR = join(ROOT, V);
const TARBALL = new TextEncoder().encode('the official php source tarball');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const PKGS = ['libxml-2.0', 'sqlite3', 'openssl', 'zlib', 'libcurl', 'oniguruma', 'libzip', 'icu-i18n', 'libpng', 'libjpeg', 'freetype2', 'libsodium', 'libxslt', 'libpq'];

function releaseJson(version: string, hash: string): string {
    return JSON.stringify({ version, source: [
        { filename: `php-${version}.tar.bz2`, name: `PHP ${version} (tar.bz2)`, sha256: 'a'.repeat(64) },
        { filename: `php-${version}.tar.gz`, name: `PHP ${version} (tar.gz)`, sha256: hash },
        { filename: `php-${version}.tar.xz`, name: `PHP ${version} (tar.xz)`, sha256: 'b'.repeat(64) },
    ] });
}

function fakeFs(initial: string[] = []) {
    const files = new Map<string, string>(initial.map((f) => [f, '']));
    const counts = { writeBytes: 0 };
    const under = (f: string, p: string) => f === p || f.startsWith(`${p}/`) || f.startsWith(`${p}\\`);
    const fs: PhpVersionsFs = {
        exists: (p) => [...files.keys()].some((f) => under(f, p)),
        list: (d) => [...new Set([...files.keys()].filter((f) => f.startsWith(`${d}/`) || f.startsWith(`${d}\\`)).map((f) => f.slice(d.length + 1).split(/[\\/]/)[0]!))],
        mkdirp: (d) => { files.set(`${d}/`, ''); },
        writeText: (p, t) => { files.set(p, t); },
        writeBytes: (p) => { counts.writeBytes += 1; files.set(p, ''); },
        rename: (a, b) => { for (const f of [...files.keys()]) if (under(f, a)) { const v = files.get(f)!; files.delete(f); files.set(b + f.slice(a.length), v); } },
        removeTree: (p) => { for (const f of [...files.keys()]) if (under(f, p)) files.delete(f); },
    };
    return { fs, files, counts };
}

function ports(opts: { missingPkgs?: string[]; noCc?: boolean; configureFails?: string; banner?: string; modules?: string; apiHash?: string; files?: string[] } = {}) {
    const disk = fakeFs(opts.files ?? []);
    const ran: string[] = [];
    const fetchedUrls: string[] = [];
    let vc = 0;
    const p: PhpVersionsPorts = {
        platform: 'linux', root: ROOT, fs: disk.fs, cpus: 4,
        ensureVcRuntime: async () => { vc += 1; return { ok: true }; },
        run: async (bin, args) => {
            ran.push(`${bin} ${args.join(' ')}`);
            if (bin === 'cc' || (bin === 'make' && args[0] === '--version') || (bin === 'pkg-config' && args[0] === '--version')) return opts.noCc && bin === 'cc' ? Promise.reject(Object.assign(new Error('spawn cc ENOENT'), { code: 'ENOENT' })) : { stdout: 'ok', exitCode: 0 };
            if (bin === 'pkg-config' && args[0] === '--exists') return { stdout: '', exitCode: (opts.missingPkgs ?? []).includes(args[1]!) ? 1 : 0 };
            if (bin === 'php-cgi') return Promise.reject(Object.assign(new Error('spawn php-cgi ENOENT'), { code: 'ENOENT' }));
            if (bin === 'tar') { disk.files.set(join(args[args.indexOf('-C') + 1]!, `php-${V}`, 'configure'), ''); return { stdout: '', exitCode: 0 }; }
            if (bin === 'env') return opts.configureFails ? { stdout: opts.configureFails, exitCode: 1 } : { stdout: '', exitCode: 0 };
            if (bin === 'make' && args.includes('install')) { for (const f of ['php', 'php-cgi', 'php-fpm', 'lib/php/extensions/no-debug-non-zts-20240924/opcache.so']) disk.files.set(join(DIR, ...f.split('/')), ''); return { stdout: '', exitCode: 0 }; }
            if (bin === 'make') return { stdout: '', exitCode: 0 };
            if (bin === join(DIR, 'php-cgi')) return { stdout: `${opts.banner ?? `PHP ${V} (cgi-fcgi) (built: Oct 24 2026 23:52:58) (NTS)`}\n`, exitCode: 0 };
            if (bin === join(DIR, 'php')) return { stdout: opts.modules ?? `[PHP Modules]\nCore\n${PHP_INI_EXTENSIONS.join('\n')}\n\n[Zend Modules]\nZend OPcache\n`, exitCode: 0 };
            return { stdout: '', exitCode: 0 };
        },
        fetchBytes: async (u): Promise<Fetched<Uint8Array>> => { fetchedUrls.push(u); return { ok: true, body: TARBALL }; },
        fetchText: async (u): Promise<Fetched<string>> => { fetchedUrls.push(u); return { ok: true, body: releaseJson(V, opts.apiHash ?? sha(TARBALL)) }; },
    };
    const leftovers = () => [...disk.files.keys()].filter((f) => f.startsWith(ROOT));
    return { p, disk, ran, fetchedUrls, leftovers, vc: () => vc };
}

describe('what Genie builds', () => {
    it("php.net's gzipped source, with the sha256 its release JSON publishes for EXACTLY that file", () => {
        expect(phpSourceName('8.4.27')).toBe('php-8.4.27.tar.gz');
        expect(phpSourceUrl('8.4.27')).toBe('https://www.php.net/distributions/php-8.4.27.tar.gz');
        expect(phpReleaseJsonUrl('8.4.27')).toBe('https://www.php.net/releases/index.php?json&version=8.4.27');
        expect(phpSourceShaFromJson(releaseJson('8.4.27', 'c'.repeat(64)), '8.4.27')).toBe('c'.repeat(64));
        expect(phpSourceShaFromJson(releaseJson('8.4.27', 'c'.repeat(64)), '8.3.36')).toBeNull();
        expect(phpSourceShaFromJson(releaseJson('8.4.27', 'nope'), '8.4.27')).toBeNull();
        expect(phpSourceShaFromJson('{"error":"Unknown version"}', '8.4.27')).toBeNull();
    });

    it("Linux's php.ini: no extension= lines (they are compiled in) and opcache by name; Windows' is unchanged", () => {
        const ini = phpIniContents(DIR, 'linux');
        expect(ini).not.toMatch(/^extension=/m);
        expect(ini).not.toMatch(/extension_dir/);
        expect(ini).toMatch(/^zend_extension=opcache$/m);
        expect(ini).not.toContain('\\');
        expect(phpIniContents('C:\\g\\8.4.27')).toMatch(/^extension=curl$/m);
    });
});

describe('building one on Linux', () => {
    it('pre-flight, checked, configured into its own directory (bin = the version dir), built, ini written, PROVEN', async () => {
        const a = ports();
        expect(await installPhpVersion(V, true, a.p)).toEqual({ kind: 'installed', version: V, dir: DIR });
        expect(a.vc()).toBe(0); // the Visual C++ runtime is Windows'
        const src = join(ROOT, `.staging-${V}`, `php-${V}`);
        const configure = a.ran.find((c) => c.startsWith('env '))!;
        expect(configure.startsWith(`env -C ${src} ./configure -q --prefix=${DIR} --bindir=${DIR} --sbindir=${DIR} --mandir=${join(DIR, 'share', 'man')} --datadir=${join(DIR, 'share')} --with-config-file-path=${DIR} `)).toBe(true);
        // MEASURED (omarchy-test, real build): with bindir = the prefix, PHP's default man/data dirs (<prefix>/php/…)
        // collide with the `php` binary and `make install` fails after "Installing PHP CLI man page". Nothing may be
        // installed under <dir>/php/: that path IS the binary.
        expect(configure).toContain(` --mandir=${join(DIR, 'share', 'man')}`);
        expect(configure).toContain(` --datadir=${join(DIR, 'share')}`);
        expect(configure).not.toMatch(new RegExp(`=${join(DIR, 'php').replace(/[.]/g, '[.]')}(/|\\s|$)`));
        for (const flag of ['--enable-cgi', '--with-openssl', '--with-curl', '--enable-gd', '--enable-intl', '--enable-mbstring', '--with-pdo-mysql=mysqlnd', '--with-pdo-pgsql', '--with-pdo-sqlite', '--with-sodium', '--with-zip', '--with-xsl']) expect(configure).toContain(` ${flag}`);
        expect(a.ran).toContain(`make -s -C ${src} -j4`);
        expect(a.ran).toContain(`make -s -C ${src} install`);
        expect(a.disk.files.get(join(DIR, 'php.ini'))).toMatch(/^zend_extension=opcache$/m);
        expect(a.ran).toContain(`${join(DIR, 'php-cgi')} -c ${join(DIR, 'php.ini')} -v`);
        expect(a.ran).toContain(`${join(DIR, 'php')} -c ${join(DIR, 'php.ini')} -m`);
        expect(a.leftovers().filter((f) => f.includes('.staging-') || f.endsWith('.tar.gz'))).toEqual([]);
        // What a pinned site runs: that build's own php-cgi and php.ini — the same command shape as Windows.
        expect(resolvePhpCgi(V, a.p)).toEqual({ ok: true, command: managedCgiCommand(DIR, 'linux') });
    });

    it('libraries configure needs and cannot find: ALL named with their packages, BEFORE anything is downloaded', async () => {
        const a = ports({ missingPkgs: ['oniguruma', 'libzip', 'libpq'] });
        const r = await installPhpVersion(V, true, a.p);
        expect(r.kind).toBe('refused');
        const reason = r.kind === 'refused' ? r.reason : '';
        for (const s of ['oniguruma', 'libzip', 'libpq', 'libonig-dev', 'libzip-dev', 'libpq-dev', 'oniguruma-devel', 'postgresql-libs']) expect(reason).toContain(s);
        expect(a.fetchedUrls).toEqual([]);
        // Every library that has a pkg-config file is asked about.
        for (const pkg of PKGS) expect(a.ran).toContain(`pkg-config --exists ${pkg}`);
    });

    it('no C compiler: refused before anything is downloaded, naming the build tools', async () => {
        const a = ports({ noCc: true });
        expect(await installPhpVersion(V, true, a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/C compiler, make and pkg-config/) });
        expect(a.fetchedUrls).toEqual([]);
    });

    it("a sha256 that is not php.net's is never written or unpacked", async () => {
        const a = ports({ apiHash: 'f'.repeat(64) });
        expect(await installPhpVersion(V, true, a.p)).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/does not match the sha256 php[.]net publishes/) });
        expect(a.fetchedUrls).toContain(phpReleaseJsonUrl(V));
        expect(a.disk.counts.writeBytes).toBe(0);
    });

    it("configure's own words when it stops (a library without a pkg-config file), and nothing is left", async () => {
        const a = ports({ configureFails: 'configure: error: Please reinstall the BZip2 distribution' });
        expect(await installPhpVersion(V, true, a.p)).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/BZip2/) });
        expect(a.leftovers()).toEqual([]);
    });

    it('a build that does not load every extension, or is another version, or is thread-safe: not an install, nothing left', async () => {
        for (const o of [{ modules: '[PHP Modules]\nCore\ncurl\n' }, { banner: 'PHP 8.4.26 (cgi-fcgi) (NTS)' }, { banner: `PHP ${V} (cgi-fcgi) (ZTS)` }]) {
            const a = ports(o);
            expect((await installPhpVersion(V, true, a.p)).kind, JSON.stringify(o)).toBe('not-installed');
            expect(a.leftovers(), JSON.stringify(o)).toEqual([]);
        }
    });

    it('the floor still comes first: a version under it is refused by name before anything runs', async () => {
        const a = ports();
        expect(await installPhpVersion('8.4.24', true, a.p)).toMatchObject({ kind: 'refused' });
        expect(a.ran).toEqual([]);
    });
});

describe('the list and removal on Linux', () => {
    it("Genie's built versions (php-cgi there) and every recipe offered; no refusal line", async () => {
        const a = ports({ files: [join(ROOT, '8.3.36', 'php-cgi')] });
        expect(managedPhp(a.p).map((m) => m.version)).toEqual(['8.3.36']);
        const view = await listPhpVersions(a.p);
        expect(view.installRefused).toBeUndefined();
        expect(view.available).toEqual(PHP_RECIPES.map((r) => ({ version: r.version, installed: r.version === '8.3.36' })));
    });

    it('removes what Genie built', () => {
        const a = ports({ files: [join(DIR, 'php-cgi')] });
        expect(removePhpVersion(V, [], a.p)).toEqual({ kind: 'removed', version: V });
        expect(a.leftovers()).toEqual([]);
    });
});

describe('macOS', () => {
    it('still refused by name, nothing fetched', async () => {
        const a = ports();
        const mac = { ...a.p, platform: 'darwin' as const };
        expect(await installPhpVersion(V, true, mac)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/macOS/) });
        expect(a.fetchedUrls).toEqual([]);
        expect((await listPhpVersions(mac)).installRefused).toMatch(/macOS/);
    });
});
