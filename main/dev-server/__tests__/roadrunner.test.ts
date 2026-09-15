import { describe, expect, it } from 'vitest';
import path from 'path';
import { ROADRUNNER_VERSION, parseRoadrunnerVersion, roadrunnerAssetFor } from '../roadrunner';
import { ensureRoadrunner, type RoadrunnerInstallEffects } from '../roadrunner-install';

/**
 * RoadRunner's `rr` for Octane sites, installed by Genie (genie#668).
 *
 * Octane looks for `rr` in the project root or on PATH. When it finds none it
 * asks to download one, and `vendor/bin/rr get-binary` then writes the binary
 * INTO the user's repo. Genie installs the pinned release into its own toolchain
 * and puts it on the site's PATH instead, the same way it provides FrankenPHP.
 *
 * Read off the real v2025.1.15 release before this was written:
 *  - assets `roadrunner-2025.1.15-{windows-amd64.zip, linux-amd64.tar.gz,
 *    linux-arm64.tar.gz, darwin-amd64.zip, darwin-arm64.tar.gz}` — there is no
 *    Windows arm64 build, and darwin-amd64 alone is a zip;
 *  - every archive nests `roadrunner-2025.1.15-<os>-<arch>/rr[.exe]`;
 *  - `rr.exe --version` prints `rr.exe version 2025.1.15 (build time: …)`,
 *    `rr --version` prints `rr version 2025.1.15 …`.
 */

const B = `https://github.com/roadrunner-server/roadrunner/releases/download/v${ROADRUNNER_VERSION}`;

describe('roadrunnerAssetFor — the official archive for a machine', () => {
    it('pins a release Octane accepts (>= 2023.3.0)', () => {
        expect(ROADRUNNER_VERSION).toBe('2025.1.15');
    });

    it.each([
        ['win32', 'x64', `roadrunner-${ROADRUNNER_VERSION}-windows-amd64.zip`, 'zip', 'rr.exe'],
        ['linux', 'x64', `roadrunner-${ROADRUNNER_VERSION}-linux-amd64.tar.gz`, 'tar.gz', 'rr'],
        ['linux', 'arm64', `roadrunner-${ROADRUNNER_VERSION}-linux-arm64.tar.gz`, 'tar.gz', 'rr'],
        ['darwin', 'x64', `roadrunner-${ROADRUNNER_VERSION}-darwin-amd64.zip`, 'zip', 'rr'],
        ['darwin', 'arm64', `roadrunner-${ROADRUNNER_VERSION}-darwin-arm64.tar.gz`, 'tar.gz', 'rr'],
    ] as const)('%s %s → %s', (os, arch, file, artifact, exe) => {
        const asset = roadrunnerAssetFor({ os, arch });
        expect(asset).toEqual({
            url: `${B}/${file}`,
            artifact,
            // The archive's own top directory, where the binary sits.
            dir: file.replace(/\.(zip|tar\.gz)$/, ''),
            exe,
        });
    });

    it('has nothing for a machine RoadRunner publishes no build for', () => {
        expect(roadrunnerAssetFor({ os: 'win32', arch: 'arm64' })).toBeUndefined();
        expect(roadrunnerAssetFor({ os: 'freebsd', arch: 'x64' })).toBeUndefined();
    });
});

describe('parseRoadrunnerVersion — what `rr --version` says', () => {
    it('reads both spellings of the banner', () => {
        expect(parseRoadrunnerVersion('rr version 2025.1.15 (build time: 2026-06-17T16:05:23+0000, go1.26.4), OS: linux, arch: amd64')).toBe('2025.1.15');
        expect(parseRoadrunnerVersion('rr.exe version 2025.1.15 (build time: 2026-06-17T16:05:23+0000, go1.26.4), OS: windows, arch: amd64')).toBe('2025.1.15');
    });

    it('is null for anything else', () => {
        expect(parseRoadrunnerVersion('')).toBeNull();
        expect(parseRoadrunnerVersion('FrankenPHP 1.12.7 PHP 8.5.10')).toBeNull();
    });
});

function fakes(over: Partial<RoadrunnerInstallEffects> & { present?: boolean; versionOut?: string } = {}) {
    const calls: string[] = [];
    let installed = over.present ?? false;
    const effects: RoadrunnerInstallEffects = {
        exists: () => installed,
        download: async (url) => {
            calls.push(`download ${url}`);
            return { ok: true, path: '/tmp/rr-archive' };
        },
        extract: async (archive, artifact, dest) => {
            calls.push(`extract ${artifact} ${archive} -> ${dest}`);
            installed = true;
            return { ok: true };
        },
        makeExecutable: async (file) => {
            calls.push(`chmod ${path.basename(file)}`);
        },
        version: async (exe) => {
            calls.push(`version ${path.basename(exe)}`);
            return over.versionOut ?? `rr version ${ROADRUNNER_VERSION} (build time: x)`;
        },
        removeDir: async (dir) => {
            calls.push(`remove ${dir}`);
            installed = false;
        },
        ...over,
    };
    return { effects, calls };
}

const DIR_WIN = `C:\\gd\\toolchain\\roadrunner\\${ROADRUNNER_VERSION}`;
const DIR_LINUX = `/gd/toolchain/roadrunner/${ROADRUNNER_VERSION}`;

describe('ensureRoadrunner — getting rr onto a machine', () => {
    it('downloads, unpacks into its version directory, and proves the binary runs', async () => {
        const f = fakes({ versionOut: `rr.exe version ${ROADRUNNER_VERSION} (build time: x)` });
        const res = await ensureRoadrunner({ dir: DIR_WIN, platform: 'win32', arch: 'x64', effects: f.effects });
        const exe = path.join(DIR_WIN, `roadrunner-${ROADRUNNER_VERSION}-windows-amd64`, 'rr.exe');
        expect(res).toEqual({ ok: true, exe });
        expect(f.calls).toEqual([
            `download ${B}/roadrunner-${ROADRUNNER_VERSION}-windows-amd64.zip`,
            `remove ${DIR_WIN}`,
            `extract zip /tmp/rr-archive -> ${DIR_WIN}`,
            'version rr.exe',
        ]);
    });

    it('marks the posix binary executable before asking it anything', async () => {
        const f = fakes();
        const res = await ensureRoadrunner({ dir: DIR_LINUX, platform: 'linux', arch: 'x64', effects: f.effects });
        expect(res.ok).toBe(true);
        expect(f.calls.indexOf('chmod rr')).toBeGreaterThan(f.calls.findIndex((c) => c.startsWith('extract tar.gz')));
        expect(f.calls.indexOf('chmod rr')).toBeLessThan(f.calls.indexOf('version rr'));
    });

    it('uses an install already there when it is the pinned release — no download', async () => {
        const f = fakes({ present: true });
        const res = await ensureRoadrunner({ dir: DIR_LINUX, platform: 'linux', arch: 'x64', effects: f.effects });
        expect(res.ok).toBe(true);
        expect(f.calls.some((c) => c.startsWith('download'))).toBe(false);
    });

    it('replaces an install that is some other release', async () => {
        let asked = 0;
        const f = fakes({
            present: true,
            version: async () => (asked++ === 0 ? 'rr version 2024.3.5 (build time: x)' : `rr version ${ROADRUNNER_VERSION} (build time: x)`),
        });
        const res = await ensureRoadrunner({ dir: DIR_LINUX, platform: 'linux', arch: 'x64', effects: f.effects });
        expect(res.ok).toBe(true);
        expect(f.calls.some((c) => c.startsWith('download'))).toBe(true);
    });

    it('tears down and reports a binary that does not run as the pinned release', async () => {
        const f = fakes({ versionOut: 'segmentation fault' });
        const res = await ensureRoadrunner({ dir: DIR_LINUX, platform: 'linux', arch: 'x64', effects: f.effects });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toContain('segmentation fault');
        expect(f.calls.filter((c) => c === `remove ${DIR_LINUX}`)).toHaveLength(2);
    });

    it('reports a failed download and leaves any existing install alone', async () => {
        const f = fakes({ download: async () => ({ ok: false, error: 'HTTP 503' }) });
        const res = await ensureRoadrunner({ dir: DIR_LINUX, platform: 'linux', arch: 'x64', effects: f.effects });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toContain('HTTP 503');
        expect(f.calls.some((c) => c.startsWith('remove'))).toBe(false);
    });

    it('refuses a machine with no build, naming what to use instead', async () => {
        const f = fakes();
        const res = await ensureRoadrunner({ dir: DIR_WIN, platform: 'win32', arch: 'arm64', effects: f.effects });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toMatch(/FrankenPHP/);
        expect(f.calls).toEqual([]);
    });
});
