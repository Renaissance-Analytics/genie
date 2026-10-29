import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHP_INI_EXTENSIONS, PHP_RECIPES, phpZipName } from '../src/core/php-versions.js';
import { installPhpVersion, refreshAllManagedInis, refreshManagedIni, type Fetched, type PhpCaPort, type PhpVersionsFs, type PhpVersionsPorts } from '../src/main/php-versions.js';
import { ensurePhpCaBundle, type ToolchainFs } from '../src/main/toolchain-ops.js';

/**
 * genie#1334. GENIE-MANAGED PHP HAS A CA BUNDLE: AFTER AN INSTALL, A RESTART AND A VERSION SWITCH.
 *
 * fancy, 2026-10-29: after a Genie restart every outbound HTTPS call from Genie's PHP 8.4.27 failed with cURL 60 /
 * verify 20 ("unable to get local issuer certificate"). The managed `php.ini` named no `curl.cainfo` and no
 * `openssl.cafile`, and Genie rewrites it whole when a pinned site starts, so it never got one back.
 *
 * Genie 1 (v0.7.0-beta.342 `toolchain-version-install.ts`, `toolchain-ca.ts`, `toolchain-versions.ts phpIniContents`)
 * exported the machine's root store to a `cacert.pem` BEFORE writing a version's ini, and the ini named it for both curl
 * and openssl. Genie 2's own installer (`php-versions/<v>`, which genie#1306 made the owner's default PHP) dropped that
 * step. These tests hold the generated ini to naming a CA file that EXISTS, on every write.
 *
 * Paths are built with the same `join` the code uses.
 */

const ROOT = join('/data', 'genie2-toolchain', 'php-versions');
const BUNDLE = join('/data', 'genie2-toolchain', 'php', 'cacert.pem');
const V = '8.4.27';
const RECIPE = PHP_RECIPES.find((r) => r.version === V)!;
const FILE = phpZipName(RECIPE);
const ZIP = new TextEncoder().encode('the official php 8.4.27 nts zip bytes');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const RELEASES_JSON = 'https://windows.php.net/downloads/releases/releases.json';
const releases = JSON.stringify({ '8.4': { version: V, 'nts-vs17-x64': { zip: { path: FILE, sha256: sha(ZIP) } } } });
const PEM = (n: number) => Array.from({ length: n }, (_, i) => `# root ${i}\n-----BEGIN CERTIFICATE-----\nMIIB${i}\n-----END CERTIFICATE-----`).join('\n');

/** An in-memory filesystem that KEEPS what is written, so the ini can be read back. */
function memFs(initial: Record<string, string> = {}) {
    const files = new Map<string, string>(Object.entries(initial));
    const dirs = new Set<string>();
    const under = (p: string) => [...files.keys(), ...dirs].filter((f) => f === p || f.startsWith(p + '/') || f.startsWith(p + '\\'));
    const fs: PhpVersionsFs & { readText(path: string): string | null } = {
        exists: (p) => files.has(p) || dirs.has(p) || under(p).length > 0,
        list: (d) => [...new Set([...files.keys(), ...dirs].filter((f) => f.startsWith(d) && f !== d).map((f) => f.slice(d.length + 1).split(/[\\/]/)[0]!))],
        mkdirp: (d) => { dirs.add(d); },
        readText: (p) => files.get(p) ?? null,
        writeText: (p, c) => { files.set(p, c); },
        writeBytes: (p) => { files.set(p, '<bytes>'); },
        rename: (a, b) => {
            for (const f of under(a)) {
                if (files.has(f)) { const c = files.get(f)!; files.delete(f); files.set(b + f.slice(a.length), c); } else { dirs.delete(f); dirs.add(b + f.slice(a.length)); }
            }
        },
        removeTree: (p) => { for (const f of under(p)) { files.delete(f); dirs.delete(f); } },
    };
    return { fs, files };
}

/** What a php.ini sets a directive to (`undefined` = not set at all). */
function directive(ini: string | null | undefined, key: string): string | undefined {
    const m = new RegExp(`^\\s*${key.replace('.', '\\.')}\\s*=\\s*"?([^"\\r\\n]*)"?\\s*$`, 'm').exec(ini ?? '');
    return m ? m[1] : undefined;
}

/** The CA port: the bundle Genie has (current), and making one when there is none (ensure — Windows exports). */
const caPort = (fs: { exists(p: string): boolean }, made?: () => void): PhpCaPort => ({
    current: () => (fs.exists(BUNDLE) ? BUNDLE : null),
    ensure: async () => { made?.(); return fs.exists(BUNDLE) ? BUNDLE : null; },
});

function winInstallPorts(disk: ReturnType<typeof memFs>): PhpVersionsPorts {
    return {
        platform: 'win32',
        root: ROOT,
        fs: disk.fs,
        fetchBytes: async (): Promise<Fetched<Uint8Array>> => ({ ok: true, body: ZIP }),
        fetchText: async (url): Promise<Fetched<string>> => (url === RELEASES_JSON ? { ok: true, body: releases } : { ok: false, error: 'HTTP 404' }),
        run: async (binary) => {
            if (binary === 'powershell.exe') {
                const staging = join(ROOT, `.staging-${V}`);
                for (const f of ['php-cgi.exe', 'php.exe', join('ext', 'php_curl.dll')]) disk.files.set(join(staging, f), '<bin>');
                return { stdout: '', exitCode: 0 };
            }
            if (binary.endsWith('php-cgi.exe')) return { stdout: `PHP ${V} (cgi-fcgi) (built: Sep 30 2026 10:00:00) (NTS Visual C++ 2022 x64)`, exitCode: 0 };
            if (binary.endsWith('php.exe')) return { stdout: ['[PHP Modules]', 'Core', ...PHP_INI_EXTENSIONS, ''].join('\n'), exitCode: 0 };
            throw new Error(`unexpected ${binary}`);
        },
        ca: caPort(disk.fs),
    };
}

describe('genie#1334: a freshly installed PHP names a CA bundle that exists', () => {
    it('Windows install (what an Update runs, genie#1306): the bundle is made BEFORE the ini, and the ini names it for curl and openssl', async () => {
        const disk = memFs({ [BUNDLE]: PEM(3) });
        let ensured = 0;
        const ports: PhpVersionsPorts = { ...winInstallPorts(disk), ca: caPort(disk.fs, () => { ensured += 1; }) };
        const outcome = await installPhpVersion(V, true, ports);
        expect(outcome.kind).toBe('installed');
        expect(ensured).toBe(1);
        const ini = disk.files.get(join(ROOT, V, 'php.ini'));
        expect(directive(ini, 'curl.cainfo')).toBe(BUNDLE);
        expect(directive(ini, 'openssl.cafile')).toBe(BUNDLE);
        expect(disk.fs.exists(directive(ini, 'curl.cainfo')!)).toBe(true);
    });

    it('no bundle could be made: neither directive is written (naming a missing file turns errno 60 into 77 and hides the cause)', async () => {
        const disk = memFs();
        const outcome = await installPhpVersion(V, true, winInstallPorts(disk));
        expect(outcome.kind).toBe('installed');
        const ini = disk.files.get(join(ROOT, V, 'php.ini'));
        expect(directive(ini, 'curl.cainfo')).toBeUndefined();
        expect(directive(ini, 'openssl.cafile')).toBeUndefined();
    });
});

describe('genie#1334: the ini Genie REWRITES keeps a CA bundle (a restart, a pinned site starting)', () => {
    const DIR = join(ROOT, V);
    const OLD_INI = '; Genie-managed php.ini — rewritten when Genie reinstalls this version.\nextension=curl\nextension=openssl\n';

    it('a pinned site start rewrites the ini whole, and the rewrite names the existing bundle (fancy’s 05:24:25Z rewrite)', () => {
        const disk = memFs({ [join(DIR, 'php-cgi.exe')]: '<bin>', [join(DIR, 'php.ini')]: OLD_INI, [BUNDLE]: PEM(3) });
        refreshManagedIni('8.4', { platform: 'win32', root: ROOT, fs: disk.fs, ca: caPort(disk.fs) });
        const ini = disk.files.get(join(DIR, 'php.ini'));
        expect(directive(ini, 'curl.cainfo')).toBe(BUNDLE);
        expect(directive(ini, 'openssl.cafile')).toBe(BUNDLE);
    });

    it('a CA file the person set in that ini is never emptied: it survives the rewrite, bundle or not', () => {
        const mine = 'D:\\certs\\corp-roots.pem';
        for (const withBundle of [true, false]) {
            const disk = memFs({
                [join(DIR, 'php-cgi.exe')]: '<bin>',
                [join(DIR, 'php.ini')]: `${OLD_INI}curl.cainfo = "${mine}"\nopenssl.cafile = "${mine}"\n`,
                [mine]: PEM(1),
                ...(withBundle ? { [BUNDLE]: PEM(3) } : {}),
            });
            refreshManagedIni('8.4', { platform: 'win32', root: ROOT, fs: disk.fs, ca: caPort(disk.fs) });
            const ini = disk.files.get(join(DIR, 'php.ini'));
            expect(directive(ini, 'curl.cainfo')).toBe(mine);
            expect(directive(ini, 'openssl.cafile')).toBe(mine);
        }
    });

    it('at boot, EVERY managed version’s ini is brought to name the bundle — the default after a version switch included', () => {
        const OLD = join(ROOT, '8.4.24');
        const disk = memFs({
            [join(OLD, 'php-cgi.exe')]: '<bin>', [join(OLD, 'php.ini')]: OLD_INI,
            [join(DIR, 'php-cgi.exe')]: '<bin>', [join(DIR, 'php.ini')]: OLD_INI,
            [BUNDLE]: PEM(3),
        });
        const refreshAll = refreshAllManagedInis;
        const written = refreshAll({ platform: 'win32', root: ROOT, fs: disk.fs, ca: caPort(disk.fs) });
        expect(written.sort()).toEqual([join(DIR, 'php.ini'), join(OLD, 'php.ini')].sort());
        for (const d of [OLD, DIR]) {
            expect(directive(disk.files.get(join(d, 'php.ini')), 'curl.cainfo')).toBe(BUNDLE);
            expect(directive(disk.files.get(join(d, 'php.ini')), 'openssl.cafile')).toBe(BUNDLE);
        }
        // Idempotent: a second boot writes nothing.
        expect(refreshAll({ platform: 'win32', root: ROOT, fs: disk.fs, ca: caPort(disk.fs) })).toEqual([]);
    });

    it('Linux (a source-built PHP): the ini names the system bundle Genie found', () => {
        const LROOT = '/home/genie/.genie/genie2-toolchain/php-versions';
        const LDIR = join(LROOT, V);
        const SYS = '/etc/ssl/certs/ca-certificates.crt';
        const disk = memFs({ [join(LDIR, 'php-cgi')]: '<bin>', [join(LDIR, 'php.ini')]: OLD_INI, [SYS]: PEM(2) });
        refreshManagedIni('8.4', { platform: 'linux', root: LROOT, fs: disk.fs, ca: { current: () => SYS, ensure: async () => SYS } });
        const ini = disk.files.get(join(LDIR, 'php.ini'));
        expect(directive(ini, 'curl.cainfo')).toBe(SYS);
        expect(directive(ini, 'openssl.cafile')).toBe(SYS);
    });
});

describe('genie#1334: the bundle itself — made once, verified, kept', () => {
    const DATA = join('/data', 'genie2-toolchain');
    function opsFs(initial: Record<string, string> = {}): ToolchainFs & { files: Map<string, string> } {
        const files = new Map<string, string>(Object.entries(initial));
        return { files, exists: (p) => files.has(p), readText: (p) => files.get(p) ?? null, writeText: (p, c) => { files.set(p, c); }, mkdirp: () => {}, remove: (p) => { files.delete(p); } };
    }
    const ensure = () => ensurePhpCaBundle;

    it('Windows, no bundle yet: the machine’s roots are exported (Genie 1’s read-only export), counted, and the path returned', async () => {
        const fs = opsFs();
        const ran: string[] = [];
        const path = await ensure()({ platform: 'win32', dataDir: DATA, fs, run: async (bin: string) => { ran.push(bin); fs.files.set(BUNDLE, PEM(5)); return { stdout: '5', exitCode: 0 }; } });
        expect(ran).toEqual(['powershell.exe']);
        expect(path).toBe(BUNDLE);
    });

    it('Windows, a bundle with certificates already there: nothing runs (a restart costs nothing)', async () => {
        const fs = opsFs({ [BUNDLE]: PEM(5) });
        const path = await ensure()({ platform: 'win32', dataDir: DATA, fs, run: async () => { throw new Error('must not run'); } });
        expect(path).toBe(BUNDLE);
    });

    it('Windows, an export that wrote no certificates: removed, and none is named (an empty bundle reads as "trust solved")', async () => {
        const fs = opsFs();
        const path = await ensure()({ platform: 'win32', dataDir: DATA, fs, run: async () => { fs.files.set(BUNDLE, ''); return { stdout: '0', exitCode: 0 }; } });
        expect(path).toBeNull();
        expect(fs.files.has(BUNDLE)).toBe(false);
    });

    it('Linux: the platform’s own bundle, nothing run', async () => {
        const SYS = '/etc/ssl/certs/ca-certificates.crt';
        const fs = opsFs({ [SYS]: PEM(2) });
        const path = await ensure()({ platform: 'linux', dataDir: DATA, fs, run: async () => { throw new Error('must not run'); } });
        expect(path).toBe(SYS);
    });
});
