import { describe, expect, it } from 'vitest';
import {
    assetNameFor,
    ensureFrankenPhp,
    installDirFor,
    layoutFor,
    releaseApiUrl,
    selectAsset,
    FRANKENPHP_VERSION,
} from '../frankenphp-fetch';
import type { FrankenPhpFetchSeams, GithubRelease } from '../frankenphp-fetch';

/**
 * Fetch-on-first-use for the FrankenPHP runtime.
 *
 * The owner's decision (2026-08-01) is that Genie does NOT bake a ~277 MB PHP
 * runtime into its installer: the first time a workspace hosts a PHP site, we
 * download the official build. Everything security-relevant about that lives in
 * this file's subject — WHICH artifact, from WHERE, and whether its bytes are
 * the ones the publisher signed off on.
 *
 * Nothing here touches the network or the disk: every seam is injected, so the
 * hard cases (a tampered download, a missing digest, an unsupported platform, a
 * half-finished install) are ordinary unit tests rather than things we hope
 * never happen in the field.
 */

// --- fixtures --------------------------------------------------------------

const DIGEST = 'a'.repeat(64);

function release(overrides: Partial<GithubRelease> = {}): GithubRelease {
    return {
        tag_name: FRANKENPHP_VERSION,
        assets: [
            {
                name: 'frankenphp-windows-x86_64.zip',
                digest: `sha256:${DIGEST}`,
                browser_download_url: 'https://example.invalid/win.zip',
            },
            {
                name: 'frankenphp-linux-x86_64',
                digest: `sha256:${'b'.repeat(64)}`,
                browser_download_url: 'https://example.invalid/linux',
            },
        ],
        ...overrides,
    };
}

interface Recorder {
    seams: FrankenPhpFetchSeams;
    files: Set<string>;
    dirs: string[];
    downloads: Array<{ url: string; dest: string }>;
    extracts: Array<{ archive: string; dest: string }>;
    moves: Array<{ from: string; to: string }>;
    removed: string[];
    chmodded: string[];
    fetched: string[];
}

function recorder(
    opts: {
        rel?: GithubRelease;
        /** What `download` reports the bytes hashed to. Defaults to the digest
         *  the release advertises, i.e. an untampered download. */
        actualSha?: string;
        /** Files that already exist before the call. */
        existing?: string[];
    } = {},
): Recorder {
    const files = new Set((opts.existing ?? []).map((p) => p.replace(/\\/g, '/')));
    const rec: Recorder = {
        files,
        dirs: [],
        downloads: [],
        extracts: [],
        moves: [],
        removed: [],
        chmodded: [],
        fetched: [],
        seams: {
            async fetchRelease(url) {
                rec.fetched.push(url);
                return opts.rel ?? release();
            },
            async download(url, dest) {
                rec.downloads.push({ url, dest });
                files.add(dest.replace(/\\/g, '/'));
                if (opts.actualSha) return opts.actualSha;
                // An untampered download hashes to whatever THIS asset advertises.
                const asset = (opts.rel ?? release()).assets.find(
                    (a) => a.browser_download_url === url,
                );
                return (asset?.digest ?? '').replace(/^sha256:/, '');
            },
            async extract(archive, dest) {
                rec.extracts.push({ archive, dest });
                // A real extraction materialises the binary inside `dest`.
                files.add(`${dest.replace(/\\/g, '/')}/frankenphp.exe`);
            },
            async fileExists(p) {
                return files.has(p.replace(/\\/g, '/'));
            },
            async mkdir(p) {
                rec.dirs.push(p.replace(/\\/g, '/'));
            },
            async move(from, to) {
                rec.moves.push({ from, to });
                const f = from.replace(/\\/g, '/');
                const t = to.replace(/\\/g, '/');
                for (const existing of [...files]) {
                    if (existing === f) {
                        files.delete(existing);
                        files.add(t);
                    } else if (existing.startsWith(`${f}/`)) {
                        files.delete(existing);
                        files.add(t + existing.slice(f.length));
                    }
                }
            },
            async remove(p) {
                rec.removed.push(p.replace(/\\/g, '/'));
            },
            async chmodExec(p) {
                rec.chmodded.push(p.replace(/\\/g, '/'));
            },
        },
    };
    return rec;
}

const BASE = 'C:/genie/userData';

// --- pure ------------------------------------------------------------------

describe('assetNameFor', () => {
    it('maps each supported OS/arch to the OFFICIAL asset name', () => {
        // Pinned as literals: these are the file names php/frankenphp actually
        // publishes, so a typo here is a 404 at first use on that platform and
        // nowhere else. Captured from the v1.12.6 release listing.
        expect(assetNameFor('win32', 'x64')).toBe('frankenphp-windows-x86_64.zip');
        expect(assetNameFor('darwin', 'arm64')).toBe('frankenphp-mac-arm64');
        expect(assetNameFor('darwin', 'x64')).toBe('frankenphp-mac-x86_64');
        expect(assetNameFor('linux', 'x64')).toBe('frankenphp-linux-x86_64');
        expect(assetNameFor('linux', 'arm64')).toBe('frankenphp-linux-aarch64');
    });

    it('returns null where upstream publishes nothing — Windows on ARM', () => {
        // Reported as "unsupported", never guessed at: handing the x86_64 zip to
        // an ARM machine produces a binary that cannot execute, and the failure
        // would surface as an unexplained site that refuses to start.
        expect(assetNameFor('win32', 'arm64')).toBeNull();
        expect(assetNameFor('freebsd', 'x64')).toBeNull();
    });
});

describe('releaseApiUrl', () => {
    it('asks GitHub for the PINNED tag, not `latest`', () => {
        // `latest` would silently change the PHP version under a user between
        // two installs of the same Genie build, and there would be no way to
        // reproduce a report against "the runtime they had".
        expect(releaseApiUrl(FRANKENPHP_VERSION)).toBe(
            `https://api.github.com/repos/php/frankenphp/releases/tags/${FRANKENPHP_VERSION}`,
        );
    });

    it('points at php/frankenphp — the official repository', () => {
        expect(releaseApiUrl('v1.0.0')).toMatch(
            /^https:\/\/api\.github\.com\/repos\/php\/frankenphp\//,
        );
    });
});

describe('selectAsset', () => {
    it('returns the download URL and the PUBLISHED sha256', () => {
        expect(selectAsset(release(), 'frankenphp-linux-x86_64')).toEqual({
            url: 'https://example.invalid/linux',
            sha256: 'b'.repeat(64),
        });
    });

    it('refuses an asset the release does not carry', () => {
        expect(() => selectAsset(release(), 'frankenphp-plan9')).toThrow(/frankenphp-plan9/);
    });

    it('refuses an asset with NO published digest rather than trusting the bytes', () => {
        // An unverifiable download is the one case where "carry on anyway" is
        // indistinguishable from a supply-chain compromise, so it is fatal.
        const rel = release({
            assets: [
                {
                    name: 'frankenphp-linux-x86_64',
                    digest: null,
                    browser_download_url: 'https://example.invalid/linux',
                },
            ],
        });
        expect(() => selectAsset(rel, 'frankenphp-linux-x86_64')).toThrow(/no published/i);
    });

    it('refuses a digest that is not a sha256', () => {
        const rel = release({
            assets: [
                {
                    name: 'frankenphp-linux-x86_64',
                    digest: 'md5:deadbeef',
                    browser_download_url: 'https://example.invalid/linux',
                },
            ],
        });
        expect(() => selectAsset(rel, 'frankenphp-linux-x86_64')).toThrow(/sha256/i);
    });
});

describe('installDirFor / layoutFor', () => {
    it('installs per VERSION, so an upgrade never overwrites a running runtime', () => {
        expect(installDirFor(BASE, 'v1.12.6').replace(/\\/g, '/')).toBe(
            'C:/genie/userData/hosting/frankenphp/v1.12.6',
        );
    });

    it('finds frankenphp.exe and a DYNAMIC ext/ dir on Windows', () => {
        const layout = layoutFor('C:/rt', 'win32');
        expect(layout.binaryPath.replace(/\\/g, '/')).toBe('C:/rt/frankenphp.exe');
        expect(layout.extensionDir?.replace(/\\/g, '/')).toBe('C:/rt/ext');
    });

    it('reports NO extension dir on macOS/Linux — those builds are static', () => {
        // The mac/linux artifacts are single static binaries with the
        // extensions compiled in. Generating an ini that says
        // `extension = curl` against a non-existent ext/ makes PHP fail to load
        // a library it already has, so the layout has to say so explicitly.
        expect(layoutFor('/opt/rt', 'linux').extensionDir).toBeNull();
        expect(layoutFor('/opt/rt', 'darwin').extensionDir).toBeNull();
        expect(layoutFor('/opt/rt', 'linux').binaryPath.replace(/\\/g, '/')).toBe(
            '/opt/rt/frankenphp',
        );
    });
});

// --- ensure ----------------------------------------------------------------

describe('ensureFrankenPhp', () => {
    it('downloads, verifies and installs on first use', async () => {
        const rec = recorder();
        const install = await ensureFrankenPhp({
            baseDir: BASE,
            platform: 'win32',
            arch: 'x64',
            seams: rec.seams,
        });

        expect(rec.downloads).toHaveLength(1);
        expect(rec.downloads[0]?.url).toBe('https://example.invalid/win.zip');
        expect(install.downloaded).toBe(true);
        expect(install.binaryPath.replace(/\\/g, '/')).toBe(
            `C:/genie/userData/hosting/frankenphp/${FRANKENPHP_VERSION}/frankenphp.exe`,
        );
        expect(install.extensionDir?.replace(/\\/g, '/')).toBe(
            `C:/genie/userData/hosting/frankenphp/${FRANKENPHP_VERSION}/ext`,
        );
    });

    it('does nothing at all when the runtime is already installed', async () => {
        // Idempotence is what makes this safe to call on EVERY php site start:
        // no network request, no 277 MB re-download, no staging directory.
        const binary = `${BASE}/hosting/frankenphp/${FRANKENPHP_VERSION}/frankenphp.exe`;
        const rec = recorder({ existing: [binary] });
        const install = await ensureFrankenPhp({
            baseDir: BASE,
            platform: 'win32',
            arch: 'x64',
            seams: rec.seams,
        });
        expect(install.downloaded).toBe(false);
        expect(rec.fetched).toEqual([]);
        expect(rec.downloads).toEqual([]);
        expect(rec.extracts).toEqual([]);
    });

    it('REFUSES a download whose bytes do not match the published digest', async () => {
        const rec = recorder({ actualSha: 'f'.repeat(64) });
        await expect(
            ensureFrankenPhp({ baseDir: BASE, platform: 'win32', arch: 'x64', seams: rec.seams }),
        ).rejects.toThrow(/checksum/i);
        // And leaves nothing half-installed behind.
        expect(rec.moves).toEqual([]);
        expect(rec.removed.some((p) => p.includes('staging'))).toBe(true);
    });

    it('names both digests when it refuses, so a report is actionable', async () => {
        const rec = recorder({ actualSha: 'f'.repeat(64) });
        await expect(
            ensureFrankenPhp({ baseDir: BASE, platform: 'win32', arch: 'x64', seams: rec.seams }),
        ).rejects.toThrow(new RegExp(`${DIGEST}[\\s\\S]*${'f'.repeat(64)}`));
    });

    it('extracts the Windows archive, and only the Windows archive', async () => {
        const win = recorder();
        await ensureFrankenPhp({ baseDir: BASE, platform: 'win32', arch: 'x64', seams: win.seams });
        expect(win.extracts).toHaveLength(1);
        expect(win.chmodded).toEqual([]);

        const linux = recorder();
        await ensureFrankenPhp({
            baseDir: BASE,
            platform: 'linux',
            arch: 'x64',
            seams: linux.seams,
        });
        // The Linux artifact IS the executable — nothing to unpack, but it
        // arrives without the executable bit, so it must be set or every start
        // fails with EACCES.
        expect(linux.extracts).toEqual([]);
        expect(linux.chmodded).toHaveLength(1);
        expect(linux.chmodded[0]).toMatch(/frankenphp$/);
    });

    it('installs by MOVING a fully-staged directory into place', async () => {
        // Extracting straight into the final path would leave a half-written
        // runtime behind if the app quit mid-extract, and the next start would
        // find `frankenphp.exe` present, skip the download, and run a truncated
        // binary. Staging + one move makes the install atomic.
        const rec = recorder();
        await ensureFrankenPhp({ baseDir: BASE, platform: 'win32', arch: 'x64', seams: rec.seams });
        expect(rec.moves).toHaveLength(1);
        const move = rec.moves[0]!;
        expect(move.from.replace(/\\/g, '/')).toContain('staging');
        expect(move.to.replace(/\\/g, '/')).toBe(
            `C:/genie/userData/hosting/frankenphp/${FRANKENPHP_VERSION}`,
        );
        // The extract target is inside the staging area, never the install dir.
        expect(rec.extracts[0]?.dest.replace(/\\/g, '/')).toContain('staging');
        expect(rec.extracts[0]?.dest.replace(/\\/g, '/')).not.toContain(
            '/hosting/frankenphp/v',
        );
    });

    it('cleans up its staging directory on success', async () => {
        const rec = recorder();
        await ensureFrankenPhp({ baseDir: BASE, platform: 'win32', arch: 'x64', seams: rec.seams });
        expect(rec.removed.some((p) => p.includes('staging'))).toBe(true);
    });

    it('says which platform is unsupported instead of downloading the wrong build', async () => {
        const rec = recorder();
        await expect(
            ensureFrankenPhp({
                baseDir: BASE,
                platform: 'win32',
                arch: 'arm64',
                seams: rec.seams,
            }),
        ).rejects.toThrow(/win32\/arm64/);
        expect(rec.downloads).toEqual([]);
    });

    it('refuses a release whose tag is not the one we asked for', async () => {
        // A redirect, a cache or a repo rename could return a different
        // release; the digest would then verify perfectly against the WRONG
        // runtime. The tag is the only thing that ties the bytes to the version
        // Genie was tested with.
        const rec = recorder({ rel: release({ tag_name: 'v9.9.9' }) });
        await expect(
            ensureFrankenPhp({ baseDir: BASE, platform: 'win32', arch: 'x64', seams: rec.seams }),
        ).rejects.toThrow(/v9\.9\.9/);
        expect(rec.downloads).toEqual([]);
    });

    it('fails when the archive did not contain the binary it promised', async () => {
        const rec = recorder();
        // An extraction that yields no `frankenphp.exe` must not be reported as
        // a successful install — the next start would spawn a path that is not
        // there and blame the site.
        rec.seams.extract = async () => {};
        await expect(
            ensureFrankenPhp({ baseDir: BASE, platform: 'win32', arch: 'x64', seams: rec.seams }),
        ).rejects.toThrow(/frankenphp\.exe/);
    });
});
