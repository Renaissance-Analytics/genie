import { describe, expect, it } from 'vitest';
import path from 'path';
import { ensureFrankenphp, type FrankenphpInstallEffects } from '../frankenphp-install';
import { FRANKENPHP_VERSION } from '../frankenphp';

/**
 * GETTING FRANKENPHP ONTO A MACHINE (genie#668).
 *
 * The official binaries are 150–180 MB, so Genie downloads the one for this
 * machine the first time a site needs it rather than shipping three in every
 * installer. What has to be true of that:
 *
 *  - SUCCESS IS THE BINARY SAYING WHAT IT IS. Bytes on disk are not an install;
 *    `frankenphp version` naming the pinned release is, and anything else is torn
 *    down and reported.
 *  - On Windows the zip is a PHP of its own that loads NO php.ini — Genie writes
 *    the same ini it writes for its own PHP installs, or mbstring, openssl and
 *    pdo never load (measured on the real 1.12.7 zip). And PHP on Windows needs
 *    the Visual C++ runtime, which Genie installs rather than names.
 *  - An install already there is used, not downloaded again.
 */

const OK_VERSION = `FrankenPHP ${FRANKENPHP_VERSION} PHP 8.5.10 Caddy v2.11.4 h1:abc\n`;

function fakes(over: Partial<FrankenphpInstallEffects> & { present?: boolean; versionOut?: string } = {}) {
    const calls: string[] = [];
    let installed = over.present ?? false;
    const written: Record<string, string> = {};
    const effects: FrankenphpInstallEffects = {
        exists: () => installed,
        download: async (url) => {
            calls.push(`download ${url}`);
            return { ok: true, path: '/tmp/dl' };
        },
        unzip: async (archive, dest) => {
            calls.push(`unzip ${archive} -> ${dest}`);
            installed = true;
            return { ok: true };
        },
        placeBinary: async (from, to) => {
            calls.push(`place ${from} -> ${to}`);
            installed = true;
        },
        writeFile: async (file, body) => {
            written[file] = body;
            calls.push(`write ${path.basename(file)}`);
        },
        version: async (exe) => {
            calls.push(`version ${path.basename(exe)}`);
            return over.versionOut ?? OK_VERSION;
        },
        removeDir: async (dir) => {
            calls.push(`remove ${dir}`);
            installed = false;
        },
        ensurePrerequisite: async (name) => {
            calls.push(`prereq ${name}`);
            return { ok: true };
        },
        caBundle: async () => null,
        ...over,
    };
    return { effects, calls, written };
}

const DIR_WIN = 'C:\\gd\\toolchain\\frankenphp\\1.12.7';
const DIR_LINUX = '/gd/toolchain/frankenphp/1.12.7';

describe('ensureFrankenphp', () => {
    it('on Windows: installs the VC++ runtime, downloads and unzips, writes php.ini, and proves the binary runs', async () => {
        const f = fakes();
        const res = await ensureFrankenphp({ dir: DIR_WIN, platform: 'win32', arch: 'x64', effects: f.effects });

        expect(res).toEqual({ ok: true, exe: path.join(DIR_WIN, 'frankenphp.exe'), phpVersion: '8.5.10' });
        expect(f.calls[0]).toBe('prereq vcredist');
        expect(f.calls).toContain(
            `download https://github.com/php/frankenphp/releases/download/v${FRANKENPHP_VERSION}/frankenphp-windows-x86_64.zip`,
        );
        expect(f.calls.findIndex((c) => c.startsWith('unzip'))).toBeLessThan(f.calls.indexOf('write php.ini'));
        expect(f.calls.indexOf('write php.ini')).toBeLessThan(f.calls.lastIndexOf('version frankenphp.exe'));
        // The ini is Genie's own PHP ini, pointed at THIS install's ext/.
        const ini = f.written[path.join(DIR_WIN, 'php.ini')] ?? '';
        expect(ini).toContain('extension=mbstring');
        expect(ini).toContain('extension=pdo_pgsql');
        expect(ini.replace(/\\/g, '/')).toContain('C:/gd/toolchain/frankenphp/1.12.7');
    });

    it('on Linux/macOS: places the single binary — no runtime, no ini', async () => {
        const f = fakes();
        const res = await ensureFrankenphp({ dir: DIR_LINUX, platform: 'linux', arch: 'x64', effects: f.effects });
        expect(res).toEqual({ ok: true, exe: path.join(DIR_LINUX, 'frankenphp'), phpVersion: '8.5.10' });
        expect(f.calls).toContain(`place /tmp/dl -> ${path.join(DIR_LINUX, 'frankenphp')}`);
        expect(f.calls.some((c) => c.startsWith('prereq'))).toBe(false);
        expect(f.calls).not.toContain('write php.ini');
    });

    it('uses an install that is already there and says the right version — no download', async () => {
        const f = fakes({ present: true });
        const res = await ensureFrankenphp({ dir: DIR_LINUX, platform: 'linux', arch: 'x64', effects: f.effects });
        expect(res.ok).toBe(true);
        expect(f.calls.some((c) => c.startsWith('download'))).toBe(false);
    });

    it('REPLACES an install that is there but is a different release', async () => {
        let first = true;
        const f = fakes({
            present: true,
            version: async () => {
                const out = first ? 'FrankenPHP 1.11.0 PHP 8.4.1 Caddy v2.10.0' : OK_VERSION;
                first = false;
                return out;
            },
        });
        const res = await ensureFrankenphp({ dir: DIR_LINUX, platform: 'linux', arch: 'x64', effects: f.effects });
        expect(res.ok).toBe(true);
        expect(f.calls.some((c) => c.startsWith('download'))).toBe(true);
    });

    it('FAILS and tears down an install whose binary does not say what it is', async () => {
        const f = fakes({ versionOut: 'Segmentation fault' });
        const res = await ensureFrankenphp({ dir: DIR_LINUX, platform: 'linux', arch: 'x64', effects: f.effects });
        expect(res.ok).toBe(false);
        expect(res.ok ? '' : res.error).toMatch(/Segmentation fault/);
        expect(f.calls).toContain(`remove ${DIR_LINUX}`);
    });

    it('FAILS with the download\'s own reason, having installed nothing', async () => {
        const f = fakes({ download: async () => ({ ok: false, error: 'HTTP 503' }) });
        const res = await ensureFrankenphp({ dir: DIR_LINUX, platform: 'linux', arch: 'x64', effects: f.effects });
        expect(res).toEqual({ ok: false, error: expect.stringContaining('HTTP 503') });
    });

    it('FAILS when the Visual C++ runtime cannot be installed, saying so', async () => {
        const f = fakes({ ensurePrerequisite: async () => ({ ok: false, error: 'elevation declined' }) });
        const res = await ensureFrankenphp({ dir: DIR_WIN, platform: 'win32', arch: 'x64', effects: f.effects });
        expect(res.ok).toBe(false);
        expect(res.ok ? '' : res.error).toMatch(/Visual C\+\+.*elevation declined/);
        expect(f.calls.some((c) => c.startsWith('download'))).toBe(false);
    });

    it('FAILS on a machine FrankenPHP publishes no binary for, naming it', async () => {
        const f = fakes();
        const res = await ensureFrankenphp({ dir: DIR_WIN, platform: 'win32', arch: 'arm64', effects: f.effects });
        expect(res.ok).toBe(false);
        expect(res.ok ? '' : res.error).toMatch(/win32.*arm64|arm64.*Windows/i);
    });
});
