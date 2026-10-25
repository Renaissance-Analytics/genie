import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHP_INI_EXTENSIONS, PHP_RECIPES, managedVersions, parsePhpBanner, parseSha256Sums, phpZipName, satisfiesPin } from '../src/core/php-versions.js';
import { installPhpVersion, listPhpVersions, removePhpVersion, resolvePhpCgi, type Fetched, type PhpVersionsFs, type PhpVersionsPorts } from '../src/main/php-versions.js';

/**
 * T4 — MANAGED PHP VERSIONS. The list is what is ON DISK with a php-cgi in it; an install is trusted only once its zip
 * matches the sha256 windows.php.net publishes beside it (a mismatch writes nothing and unpacks nothing — counted); a
 * version a site is pinned to is never removed; a pin runs its own binary or is refused, never another PHP.
 * Every effect is a fake that counts. Paths are built with the same `join` the code uses.
 */

const ROOT = join('/data', 'genie2-toolchain', 'php-versions');
const V = '8.4.27';
const RECIPE = PHP_RECIPES.find((r) => r.version === V)!;
const FILE = phpZipName(RECIPE);
const ZIP = new TextEncoder().encode('the official php 8.4.27 nts zip bytes');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const sumsWith = (hash: string) => [
    `${'a'.repeat(64)} *php-8.3.36-nts-Win32-vs16-x64.zip`,
    `${hash} *${FILE}`,
    `${'b'.repeat(64)} *php-debug-pack-${V}-nts-Win32-vs17-x64.zip`,
].join('\n');

/** An in-memory filesystem that counts writes. */
function fakeFs(initial: string[] = []) {
    const files = new Set<string>(initial);
    const dirs = new Set<string>();
    const counts = { writeBytes: 0, writeText: 0, rename: 0, removeTree: 0 };
    const under = (p: string) => [...files, ...dirs].filter((f) => f === p || f.startsWith(p + '/') || f.startsWith(p + '\\'));
    const fs: PhpVersionsFs = {
        exists: (p) => files.has(p) || dirs.has(p) || under(p).length > 0,
        list: (d) => [...new Set([...files, ...dirs].filter((f) => f.startsWith(d) && f !== d).map((f) => f.slice(d.length + 1).split(/[\\/]/)[0]!))],
        mkdirp: (d) => { dirs.add(d); },
        writeText: (p) => { counts.writeText += 1; files.add(p); },
        writeBytes: (p) => { counts.writeBytes += 1; files.add(p); },
        rename: (a, b) => {
            counts.rename += 1;
            for (const f of under(a)) { files.delete(f); dirs.delete(f); (f === a ? dirs : files).add(b + f.slice(a.length)); }
        },
        removeTree: (p) => { counts.removeTree += 1; for (const f of under(p)) { files.delete(f); dirs.delete(f); } },
    };
    return { fs, files, counts };
}

const banner = (v: string, build = 'NTS Visual C++ 2022 x64') => `PHP ${v} (cgi-fcgi) (built: Sep 30 2026 10:00:00) (${build})\nCopyright (c) The PHP Group`;
const MODULES = ['[PHP Modules]', 'Core', 'date', ...PHP_INI_EXTENSIONS, '', '[Zend Modules]', ''].join('\n');

/** Ports for a Windows install where windows.php.net serves `zip` and publishes `published` as its sha256. */
function winPorts(opts: { published?: string; rootZip?: boolean; reports?: string; systemPhp?: string | null; files?: string[] } = {}) {
    const disk = fakeFs(opts.files);
    const fetched: string[] = [];
    const ran: Array<[string, readonly string[]]> = [];
    const ports: PhpVersionsPorts = {
        platform: 'win32',
        root: ROOT,
        fs: disk.fs,
        fetchBytes: async (url): Promise<Fetched<Uint8Array>> => {
            fetched.push(url);
            // The current release is at the root; `rootZip: false` = it has moved to archives/.
            if (url.includes('/archives/') ? opts.rootZip !== false : opts.rootZip === false) return { ok: false, error: 'HTTP 404' };
            return { ok: true, body: ZIP };
        },
        fetchText: async (url): Promise<Fetched<string>> => { fetched.push(url); return { ok: true, body: sumsWith(opts.published ?? sha(ZIP)) }; },
        run: async (binary, args) => {
            ran.push([binary, args]);
            if (binary === 'powershell.exe') {
                // Expand-Archive: the zip's layout lands in the staging directory.
                const staging = join(ROOT, `.staging-${V}`);
                for (const f of ['php-cgi.exe', 'php.exe', join('ext', 'php_curl.dll')]) disk.files.add(join(staging, f));
                return { stdout: '', exitCode: 0 };
            }
            if (binary === 'php-cgi') {
                if (opts.systemPhp === null || opts.systemPhp === undefined) throw new Error('ENOENT');
                return { stdout: banner(opts.systemPhp), exitCode: 0 };
            }
            if (binary.endsWith('php-cgi.exe')) return { stdout: banner(opts.reports ?? V), exitCode: 0 };
            if (binary.endsWith('php.exe')) return { stdout: MODULES, exitCode: 0 };
            throw new Error(`unexpected ${binary}`);
        },
    };
    return { ports, disk, fetched, ran };
}

const installed = (...versions: string[]) => versions.map((v) => join(ROOT, v, 'php-cgi.exe'));

describe('parsing what windows.php.net publishes and what is on disk', () => {
    it('sha256sum.txt: `<hash> *<file>` lines by file name, lower-cased; anything else skipped', () => {
        const sums = parseSha256Sums([`${'A'.repeat(64)} *${FILE}`, `${'c'.repeat(64)}  php-8.2.34-nts-Win32-vs16-x64.zip`, 'not a line', `${'d'.repeat(63)} *short.zip`, ''].join('\r\n'));
        expect([...sums.entries()]).toEqual([[FILE, 'a'.repeat(64)], ['php-8.2.34-nts-Win32-vs16-x64.zip', 'c'.repeat(64)]]);
    });

    it('the managed list: full-version directories WITH a php-cgi, newest first (8.10 above 8.9); staging and junk are not installs', () => {
        const entries = ['8.9.1', '.staging-8.5.11', '8.10.0', 'notes', '8.3', '8.2.34'];
        const withCgi = new Set(['8.9.1', '8.10.0', '8.3', '.staging-8.5.11']);
        expect(managedVersions(entries, (v) => withCgi.has(v), (v) => `/r/${v}`).map((m) => m.version)).toEqual(['8.10.0', '8.9.1']);
    });

    it('a php banner: its version and its build (NTS / ZTS / unsaid); anything else is not PHP', () => {
        expect(parsePhpBanner(banner('8.4.26'))).toEqual({ version: '8.4.26', threadSafe: false });
        expect(parsePhpBanner(banner('8.4.26', 'ZTS Visual C++ 2022 x64'))).toEqual({ version: '8.4.26', threadSafe: true });
        expect(parsePhpBanner('PHP 8.3.35 (cli)')).toEqual({ version: '8.3.35', threadSafe: null });
        expect(parsePhpBanner("'php-cgi' is not recognized as an internal or external command")).toBeNull();
    });

    it('a pin is a version or a line — split at a dot, so 8.3 never matches 8.30', () => {
        expect(satisfiesPin('8.3.35', '8.3')).toBe(true);
        expect(satisfiesPin('8.3.35', '8.3.35')).toBe(true);
        expect(satisfiesPin('8.30.1', '8.3')).toBe(false);
    });

    it('the view: Genie’s versions (with the sites on each), the PATH php-cgi, and what this release can install', async () => {
        const { ports } = winPorts({ files: installed('8.3.35', V), systemPhp: '8.4.27' });
        const view = await listPhpVersions(ports, [{ host: 'shop.gen', pin: '8.4' }]);
        expect(view.managed.map((m) => [m.version, m.usedBy])).toEqual([[V, ['shop.gen']], ['8.3.35', []]]);
        expect(view.system).toEqual({ version: '8.4.27' });
        expect(view.available).toEqual(PHP_RECIPES.map((r) => ({ version: r.version, installed: r.version === V || r.version === '8.3.35' })));
        expect(view.installRefused).toBeUndefined();
    });

    it('macOS: the system PHP is listed and nothing is offered for install, with the reason (Linux builds from source: php-source-build.test.ts)', async () => {
        const { ports } = winPorts({ systemPhp: '8.3.6' });
        const view = await listPhpVersions({ ...ports, platform: 'darwin' });
        expect(view).toMatchObject({ managed: [], system: { version: '8.3.6' }, available: [] });
        expect(view.installRefused).toMatch(/macOS/);
    });
});

describe('install — only with consent, and only a zip that matches the published sha256', () => {
    it('a matching zip is unpacked, moved into place with its php.ini, and PROVEN (NTS, the asked version, its extensions)', async () => {
        const { ports, disk, fetched, ran } = winPorts();
        const r = await installPhpVersion(V, true, ports);
        expect(r).toEqual({ kind: 'installed', version: V, dir: join(ROOT, V) });
        expect(fetched).toEqual([`https://windows.php.net/downloads/releases/${FILE}`, 'https://windows.php.net/downloads/releases/sha256sum.txt']);
        expect(disk.counts.writeBytes).toBe(1);
        expect(disk.files.has(join(ROOT, V, 'php.ini'))).toBe(true);
        expect(disk.files.has(join(ROOT, V, 'php-cgi.exe'))).toBe(true);
        expect(ran.map(([b]) => b)).toEqual(['powershell.exe', join(ROOT, V, 'php-cgi.exe'), join(ROOT, V, 'php.exe')]);
        expect((await listPhpVersions(ports)).managed.map((m) => m.version)).toEqual([V]);
    });

    it('a MISMATCH is refused: nothing written, nothing unpacked, nothing listed — and the control above shows the same ports do write', async () => {
        const { ports, disk, ran } = winPorts({ published: sha(new TextEncoder().encode('something else')) });
        const r = await installPhpVersion(V, true, ports);
        expect(r.kind).toBe('not-installed');
        expect((r as { reason: string }).reason).toMatch(/does not match the sha256 windows\.php\.net publishes/);
        expect(disk.counts.writeBytes).toBe(0);
        expect(disk.counts.rename).toBe(0);
        expect(ran.filter(([b]) => b === 'powershell.exe')).toHaveLength(0);
        expect((await listPhpVersions(ports)).managed).toEqual([]);
    });

    it('a zip the checksums file does not list is not trusted either', async () => {
        const { ports, disk } = winPorts();
        const r = await installPhpVersion(V, true, { ...ports, fetchText: async () => ({ ok: true, body: `${'a'.repeat(64)} *php-other.zip` }) });
        expect(r).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/lists no sha256/) });
        expect(disk.counts.writeBytes).toBe(0);
    });

    it('a release moved to archives/: the zip AND its checksum are read from archives/', async () => {
        const { ports, fetched } = winPorts({ rootZip: false });
        expect((await installPhpVersion(V, true, ports)).kind).toBe('installed');
        expect(fetched).toEqual([
            `https://windows.php.net/downloads/releases/${FILE}`,
            `https://windows.php.net/downloads/releases/archives/${FILE}`,
            'https://windows.php.net/downloads/releases/archives/sha256sum.txt',
        ]);
    });

    it('a binary that reports another version is not an install, and leaves nothing behind', async () => {
        const { ports, disk } = winPorts({ reports: '8.4.25' });
        expect(await installPhpVersion(V, true, ports)).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/reports 8\.4\.25/) });
        expect([...disk.files].filter((f) => f.startsWith(ROOT))).toEqual([]);
    });

    it('no consent, a version this release does not install, or a non-Windows machine: refused before anything is fetched', async () => {
        const { ports, fetched } = winPorts();
        expect((await installPhpVersion(V, false, ports)).kind).toBe('refused');
        expect(await installPhpVersion('8.4.99', true, ports)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/no installer for PHP 8\.4\.99/) });
        expect((await installPhpVersion(V, true, { ...ports, platform: 'darwin' })).kind).toBe('refused');
        expect(fetched).toEqual([]);
    });
});

describe('remove — refused while a site is pinned to it', () => {
    it('a version a site pins (exactly or by its line) is refused, naming the site; nothing is deleted', () => {
        const { ports, disk } = winPorts({ files: installed(V, '8.3.35') });
        for (const pin of [V, '8.4', '8']) {
            const r = removePhpVersion(V, [{ host: 'shop.gen', pin }], ports);
            expect(r).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/pinned by shop\.gen/) });
        }
        expect(disk.counts.removeTree).toBe(0);
        expect(disk.files.has(join(ROOT, V, 'php-cgi.exe'))).toBe(true);
    });

    it('control: pinned to ANOTHER version, it is removed and no longer listed', async () => {
        const { ports, disk } = winPorts({ files: installed(V, '8.3.35') });
        expect(removePhpVersion(V, [{ host: 'shop.gen', pin: '8.3' }], ports)).toEqual({ kind: 'removed', version: V });
        expect(disk.counts.removeTree).toBe(1);
        expect((await listPhpVersions(ports)).managed.map((m) => m.version)).toEqual(['8.3.35']);
    });

    it('a version Genie did not install is refused', () => {
        const { ports } = winPorts();
        expect(removePhpVersion(V, [], ports).kind).toBe('refused');
    });
});

describe('the php-cgi a site starts', () => {
    it('pinned: that managed version’s own binary and php.ini; a line pin takes the newest of the line', () => {
        const { ports } = winPorts({ files: installed('8.4.20', V, '8.3.35') });
        expect(resolvePhpCgi(V, ports)).toEqual({ ok: true, command: `${join(ROOT, V, 'php-cgi.exe')} -c ${join(ROOT, V, 'php.ini')}` });
        expect(resolvePhpCgi('8.4', ports)).toEqual(resolvePhpCgi(V, ports));
        expect(resolvePhpCgi('8.3', ports)).toEqual({ ok: true, command: `${join(ROOT, '8.3.35', 'php-cgi.exe')} -c ${join(ROOT, '8.3.35', 'php.ini')}` });
    });

    it('control — unpinned: the php-cgi on PATH, exactly as before T4', () => {
        const { ports } = winPorts({ files: installed(V) });
        expect(resolvePhpCgi(undefined, ports)).toEqual({ ok: true, command: 'php-cgi' });
    });

    it('a pin to a version Genie does not manage is an explicit refusal naming what it does manage — never a fallback', () => {
        const { ports } = winPorts({ files: installed(V) });
        const r = resolvePhpCgi('8.2', ports);
        expect(r.ok).toBe(false);
        expect((r as { reason: string }).reason).toMatch(/pinned to PHP 8\.2, which Genie does not manage on this machine.*8\.4\.27/);
        expect(resolvePhpCgi('latest', ports)).toMatchObject({ ok: false, reason: expect.stringMatching(/not a PHP version/) });
    });

    it('a path with a space is quoted for the pty’s command-line parser', () => {
        const spaced = join('/Users/Jo Example/genie2-toolchain', 'php-versions');
        const { ports } = winPorts();
        const disk = fakeFs([join(spaced, V, 'php-cgi.exe')]);
        expect(resolvePhpCgi(V, { ...ports, root: spaced, fs: disk.fs })).toEqual({ ok: true, command: `"${join(spaced, V, 'php-cgi.exe')}" -c "${join(spaced, V, 'php.ini')}"` });
    });
});
