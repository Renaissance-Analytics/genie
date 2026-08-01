import { describe, expect, it } from 'vitest';
import { assertDigest, ensureStagedInstall, isArchive } from '../fetch-seams';
import { assetFor as postgresAssetFor, ensurePostgres, installedBinDir } from '../postgres-fetch';
import { assetFor as dotnetAssetFor, ensureDotnet, ridFor } from '../dotnet-fetch';
import {
    assetNameFor as garnetAssetNameFor,
    ensureGarnet,
    garnetServerPath,
    selectAsset,
    GARNET_VERSION,
} from '../garnet-fetch';
import type { FetchSeams, StagedInstallPlan } from '../fetch-seams';
import type { GithubRelease } from '../garnet-fetch';

/**
 * Fetch-on-first-use for the three engines a managed service needs.
 *
 * Everything security-relevant lives here — WHICH artifact, from WHERE, and
 * whether its bytes are the ones the publisher signed off on — so the hard cases
 * are ordinary unit tests rather than things we hope never happen in the field:
 * a tampered download, a missing digest, an unsupported platform, an archive
 * that unpacked to the wrong shape, a crash halfway through.
 *
 * Nothing here touches the network or the disk. Every seam is injected, which is
 * what keeps a suite that covers a 330 MB download instant.
 */

// --- a recording fake for the shared seams ---------------------------------

interface Recorder {
    seams: FetchSeams;
    files: Set<string>;
    downloads: Array<{ url: string; dest: string }>;
    extracts: Array<{ archive: string; dest: string; members?: readonly string[] }>;
    moves: Array<{ from: string; to: string }>;
    removed: string[];
    chmodded: string[];
    fetched: string[];
}

const norm = (p: string) => p.replace(/\\/g, '/');

function recorder(
    opts: {
        existing?: string[];
        /** What the download reports the bytes hashed to. */
        digests?: { sha256: string; sha512: string };
        json?: unknown;
        /** Archive members the extract "produces", relative to the dest dir. */
        produces?: string[];
    } = {},
): Recorder {
    const files = new Set((opts.existing ?? []).map(norm));
    const rec: Recorder = {
        files,
        downloads: [],
        extracts: [],
        moves: [],
        removed: [],
        chmodded: [],
        fetched: [],
        seams: {
            async fetchJson<T>(url: string) {
                rec.fetched.push(url);
                return opts.json as T;
            },
            async download(url, dest) {
                rec.downloads.push({ url, dest: norm(dest) });
                files.add(norm(dest));
                return opts.digests ?? { sha256: 'a'.repeat(64), sha512: 'b'.repeat(128) };
            },
            async extract(archive, dest, members) {
                rec.extracts.push({ archive: norm(archive), dest: norm(dest), members });
                for (const produced of opts.produces ?? []) files.add(`${norm(dest)}/${produced}`);
            },
            async fileExists(p) {
                return files.has(norm(p));
            },
            async mkdir(p) {
                files.add(norm(p));
            },
            async move(from, to) {
                rec.moves.push({ from: norm(from), to: norm(to) });
                // Move everything under `from` to `to`, so a staged sentinel
                // becomes the installed one — the property the caller relies on.
                for (const f of [...files]) {
                    if (f === norm(from) || f.startsWith(`${norm(from)}/`)) {
                        files.delete(f);
                        files.add(f.replace(norm(from), norm(to)));
                    }
                }
            },
            async remove(p) {
                rec.removed.push(norm(p));
            },
            async chmodExec(p) {
                rec.chmodded.push(norm(p));
                files.add(norm(p));
            },
        },
    };
    return rec;
}

// --- the shared install dance ----------------------------------------------

describe('ensureStagedInstall', () => {
    const plan = (over: Partial<StagedInstallPlan> = {}): StagedInstallPlan => ({
        installDir: '/base/hosting/thing/1.0',
        sentinel: '/base/hosting/thing/1.0/bin/thing.exe',
        resolve: () => ({
            url: 'https://example.invalid/thing.zip',
            assetName: 'thing.zip',
            verify: () => {},
        }),
        ...over,
    });

    it('does nothing at all when the install is already there', async () => {
        const rec = recorder({ existing: ['/base/hosting/thing/1.0/bin/thing.exe'] });
        const did = await ensureStagedInstall(plan(), '/base', rec.seams);
        expect(did).toBe(false);
        expect(rec.downloads).toEqual([]);
        expect(rec.fetched).toEqual([]);
    });

    it('does not even RESOLVE when the install is there', async () => {
        // Resolving costs a network round trip for Garnet, so the short-circuit
        // has to come first — otherwise every start hits the GitHub API.
        const rec = recorder({ existing: ['/base/hosting/thing/1.0/bin/thing.exe'] });
        let resolved = false;
        await ensureStagedInstall(
            plan({
                resolve: () => {
                    resolved = true;
                    return { url: 'u', assetName: 'thing.zip', verify: () => {} };
                },
            }),
            '/base',
            rec.seams,
        );
        expect(resolved).toBe(false);
    });

    it('downloads, verifies, extracts and moves ONCE into place', async () => {
        const rec = recorder({ produces: ['bin/thing.exe'] });
        const did = await ensureStagedInstall(plan(), '/base', rec.seams);
        expect(did).toBe(true);
        expect(rec.downloads).toHaveLength(1);
        expect(rec.extracts).toHaveLength(1);
        // Exactly one move into the install dir — that is what makes it atomic.
        const final = rec.moves.filter((m) => m.to === '/base/hosting/thing/1.0');
        expect(final).toHaveLength(1);
        expect(final[0]!.from).toContain('/out');
    });

    it('stages under a sibling directory so the move is a rename, not a copy', async () => {
        const rec = recorder({ produces: ['bin/thing.exe'] });
        await ensureStagedInstall(plan(), '/base', rec.seams);
        expect(rec.downloads[0]!.dest).toContain('/base/hosting/.staging/');
    });

    it('refuses a download whose digest does not match, and installs nothing', async () => {
        const rec = recorder({ produces: ['bin/thing.exe'] });
        await expect(
            ensureStagedInstall(
                plan({
                    resolve: () => ({
                        url: 'u',
                        assetName: 'thing.zip',
                        verify: () => {
                            throw new Error('thing.zip: sha256 mismatch');
                        },
                    }),
                }),
                '/base',
                rec.seams,
            ),
        ).rejects.toThrow(/mismatch/);
        expect(rec.moves.some((m) => m.to === '/base/hosting/thing/1.0')).toBe(false);
    });

    it('cleans up the staging directory even when the install fails', async () => {
        const rec = recorder();
        await expect(
            ensureStagedInstall(
                plan({
                    resolve: () => ({
                        url: 'u',
                        assetName: 'thing.zip',
                        verify: () => {
                            throw new Error('boom');
                        },
                    }),
                }),
                '/base',
                rec.seams,
            ),
        ).rejects.toThrow();
        expect(rec.removed.some((p) => p.includes('/base/hosting/.staging/'))).toBe(true);
    });

    it('refuses an archive that did not contain the executable', async () => {
        // Otherwise a bad unpack installs a directory that looks fine until the
        // first spawn fails with ENOENT, far from here.
        const rec = recorder({ produces: ['bin/something-else'] });
        await expect(ensureStagedInstall(plan(), '/base', rec.seams)).rejects.toThrow(
            /did not yield/,
        );
        expect(rec.moves.some((m) => m.to === '/base/hosting/thing/1.0')).toBe(false);
    });

    it('marks a RAW (non-archive) asset executable', async () => {
        // Release artifacts arrive without the executable bit; without the
        // chmod every start fails with EACCES.
        const rec = recorder();
        await ensureStagedInstall(
            plan({
                installDir: '/base/hosting/thing/1.0',
                sentinel: '/base/hosting/thing/1.0/thing',
                resolve: () => ({
                    url: 'u',
                    assetName: 'thing',
                    rawDestRelative: 'thing',
                    verify: () => {},
                }),
            }),
            '/base',
            rec.seams,
        );
        expect(rec.chmodded).toHaveLength(1);
        expect(rec.extracts).toEqual([]);
    });

    it('passes the wanted members through to the extractor', async () => {
        const rec = recorder({ produces: ['bin/thing.exe'] });
        await ensureStagedInstall(
            plan({
                resolve: () => ({
                    url: 'u',
                    assetName: 'thing.zip',
                    members: ['pgsql/bin'],
                    verify: () => {},
                }),
            }),
            '/base',
            rec.seams,
        );
        expect(rec.extracts[0]!.members).toEqual(['pgsql/bin']);
    });
});

describe('assertDigest', () => {
    it('accepts a match regardless of case', () => {
        expect(() => assertDigest('a.zip', 'sha256', 'ABC', 'abc')).not.toThrow();
    });

    it('names the artifact and both values on a mismatch', () => {
        expect(() => assertDigest('a.zip', 'sha256', 'aaa', 'bbb')).toThrow(
            /a\.zip[\s\S]*aaa[\s\S]*bbb/,
        );
    });
});

describe('isArchive', () => {
    it('recognises every container the fetchers use', () => {
        expect(isArchive('x.zip')).toBe(true);
        expect(isArchive('x.tar.gz')).toBe(true);
        expect(isArchive('x.tar.xz')).toBe(true);
        expect(isArchive('frankenphp-mac-arm64')).toBe(false);
    });
});

// --- postgres --------------------------------------------------------------

describe('postgres assetFor', () => {
    it('offers the official Windows and macOS distributions', () => {
        expect(postgresAssetFor('win32', 'x64')!.name).toBe(
            'postgresql-17.6-1-windows-x64-binaries.zip',
        );
        expect(postgresAssetFor('darwin', 'arm64')!.name).toBe(
            'postgresql-17.6-1-osx-binaries.zip',
        );
    });

    it('serves BOTH Macs from one universal artifact', () => {
        // Verified: the macOS binaries are a fat Mach-O carrying x86_64 and
        // arm64, so Apple Silicon needs no Rosetta and no second download.
        expect(postgresAssetFor('darwin', 'x64')!.name).toBe(
            postgresAssetFor('darwin', 'arm64')!.name,
        );
    });

    it('fetches only from EDB, over https', () => {
        for (const platform of ['win32', 'darwin']) {
            const asset = postgresAssetFor(platform, 'x64')!;
            expect(asset.url.startsWith('https://get.enterprisedb.com/postgresql/')).toBe(true);
        }
    });

    it('pins a real sha256 for every artifact it offers', () => {
        // The digest cannot be fetched (EDB publishes none), so an unpinned
        // artifact would be installed unverified. See postgres-fetch.ts.
        for (const [platform, arch] of [
            ['win32', 'x64'],
            ['darwin', 'arm64'],
        ] as const) {
            expect(postgresAssetFor(platform, arch)!.sha256).toMatch(/^[0-9a-f]{64}$/);
        }
    });

    it('says NO rather than guessing where upstream publishes nothing', () => {
        // Linux: EDB ships no binary distribution at all.
        expect(postgresAssetFor('linux', 'x64')).toBeNull();
        expect(postgresAssetFor('win32', 'arm64')).toBeNull();
        expect(postgresAssetFor('freebsd', 'x64')).toBeNull();
    });

    it('skips pgAdmin and the docs — a managed cluster needs neither', () => {
        const members = postgresAssetFor('win32', 'x64')!.members;
        expect([...members]).toEqual(['pgsql/bin', 'pgsql/lib', 'pgsql/share']);
    });
});

describe('ensurePostgres', () => {
    /** The fake download hashes to exactly what the module pinned — anything
     *  else is refused, which the mismatch tests above already prove. */
    const pinned = (platform: 'win32' | 'darwin', arch: string) => ({
        sha256: postgresAssetFor(platform, arch)!.sha256,
        sha512: 'b'.repeat(128),
    });

    it('installs and reports the tool paths', async () => {
        const installDir = '/base/hosting/postgres/17.6';
        const rec = recorder({
            produces: ['pgsql/bin/postgres.exe'],
            digests: pinned('win32', 'x64'),
        });
        const install = await ensurePostgres({
            baseDir: '/base',
            platform: 'win32',
            arch: 'x64',
            seams: rec.seams,
        });
        expect(install.downloaded).toBe(true);
        expect(norm(install.binDir)).toBe(norm(installedBinDir(installDir)));
        expect(norm(install.initdbPath)).toContain('initdb.exe');
        expect(norm(install.pgCtlPath)).toContain('pg_ctl.exe');
    });

    it('short-circuits on a second call', async () => {
        const rec = recorder({ existing: ['/base/hosting/postgres/17.6/pgsql/bin/postgres.exe'] });
        const install = await ensurePostgres({
            baseDir: '/base',
            platform: 'win32',
            arch: 'x64',
            seams: rec.seams,
        });
        expect(install.downloaded).toBe(false);
        expect(rec.downloads).toEqual([]);
    });

    it('explains itself on a platform with no build', async () => {
        await expect(
            ensurePostgres({ baseDir: '/base', platform: 'linux', arch: 'x64' }),
        ).rejects.toThrow(/no official binary distribution/);
    });

    it('drops unnamed tools on posix (no .exe)', async () => {
        const rec = recorder({
            produces: ['pgsql/bin/postgres'],
            digests: pinned('darwin', 'arm64'),
        });
        const install = await ensurePostgres({
            baseDir: '/base',
            platform: 'darwin',
            arch: 'arm64',
            seams: rec.seams,
        });
        expect(norm(install.serverPath).endsWith('/pgsql/bin/postgres')).toBe(true);
    });
});

// --- dotnet ----------------------------------------------------------------

describe('dotnet assetFor', () => {
    it('covers every platform/arch Genie ships to', () => {
        for (const [platform, arch] of [
            ['win32', 'x64'],
            ['win32', 'arm64'],
            ['darwin', 'x64'],
            ['darwin', 'arm64'],
            ['linux', 'x64'],
            ['linux', 'arm64'],
        ] as const) {
            const asset = dotnetAssetFor(platform, arch);
            expect(asset, `${platform}/${arch}`).not.toBeNull();
            expect(asset!.sha512).toMatch(/^[0-9a-f]{128}$/);
            expect(asset!.url.startsWith('https://builds.dotnet.microsoft.com/')).toBe(true);
        }
    });

    it('maps platforms to Microsoft runtime identifiers', () => {
        expect(ridFor('win32', 'x64')).toBe('win-x64');
        expect(ridFor('darwin', 'arm64')).toBe('osx-arm64');
        expect(ridFor('linux', 'x64')).toBe('linux-x64');
        expect(ridFor('linux', 'ia32')).toBeNull();
    });

    it('uses the platform-appropriate container', () => {
        expect(dotnetAssetFor('win32', 'x64')!.name.endsWith('.zip')).toBe(true);
        expect(dotnetAssetFor('linux', 'x64')!.name.endsWith('.tar.gz')).toBe(true);
    });
});

describe('ensureDotnet', () => {
    it('reports the DOTNET_ROOT the redis runtime needs', async () => {
        const rec = recorder({
            produces: ['dotnet.exe'],
            digests: {
                sha256: 'a'.repeat(64),
                sha512: dotnetAssetFor('win32', 'x64')!.sha512,
            },
        });
        const install = await ensureDotnet({
            baseDir: '/base',
            platform: 'win32',
            arch: 'x64',
            seams: rec.seams,
        });
        // Without this, Garnet's app host looks for a SYSTEM .NET and refuses
        // to start on a machine that has none.
        expect(norm(install.dotnetRoot)).toBe('/base/hosting/dotnet/10.0.10');
        expect(norm(install.hostPath)).toBe('/base/hosting/dotnet/10.0.10/dotnet.exe');
    });
});

// --- garnet ----------------------------------------------------------------

describe('garnet assetNameFor', () => {
    it('covers every platform/arch Genie ships to', () => {
        expect(garnetAssetNameFor('win32', 'x64')).toBe('win-x64-based-readytorun.zip');
        expect(garnetAssetNameFor('win32', 'arm64')).toBe('win-arm64-based-readytorun.zip');
        expect(garnetAssetNameFor('darwin', 'arm64')).toBe('osx-arm64-based.tar.xz');
        expect(garnetAssetNameFor('linux', 'x64')).toBe('linux-x64-based.tar.xz');
        expect(garnetAssetNameFor('linux', 'ia32')).toBeNull();
    });
});

describe('garnet selectAsset', () => {
    const release = (over: Partial<GithubRelease> = {}): GithubRelease => ({
        tag_name: GARNET_VERSION,
        assets: [
            {
                name: 'win-x64-based-readytorun.zip',
                digest: `sha256:${'a'.repeat(64)}`,
                browser_download_url: 'https://example.invalid/win.zip',
            },
        ],
        ...over,
    });

    it('returns the url and the published digest', () => {
        expect(selectAsset(release(), 'win-x64-based-readytorun.zip')).toEqual({
            url: 'https://example.invalid/win.zip',
            sha256: 'a'.repeat(64),
        });
    });

    it('refuses an asset with NO published digest', () => {
        const r = release({
            assets: [{ name: 'win-x64-based-readytorun.zip', browser_download_url: 'u' }],
        });
        expect(() => selectAsset(r, 'win-x64-based-readytorun.zip')).toThrow(/unverifiable/);
    });

    it('refuses a digest that is not a sha256', () => {
        const r = release({
            assets: [
                {
                    name: 'win-x64-based-readytorun.zip',
                    digest: 'md5:abc',
                    browser_download_url: 'u',
                },
            ],
        });
        expect(() => selectAsset(r, 'win-x64-based-readytorun.zip')).toThrow(/not a sha256/);
    });

    it('explains a missing asset', () => {
        expect(() => selectAsset(release(), 'osx-arm64-based.tar.xz')).toThrow(/no asset named/);
    });
});

describe('ensureGarnet', () => {
    const release: GithubRelease = {
        tag_name: GARNET_VERSION,
        assets: [
            {
                name: 'win-x64-based-readytorun.zip',
                digest: `sha256:${'a'.repeat(64)}`,
                browser_download_url: 'https://example.invalid/win.zip',
            },
        ],
    };

    it('resolves through the GitHub release API and installs', async () => {
        const rec = recorder({
            json: release,
            produces: ['net10.0/GarnetServer.exe'],
            digests: { sha256: 'a'.repeat(64), sha512: 'b'.repeat(128) },
        });
        const install = await ensureGarnet({
            baseDir: '/base',
            platform: 'win32',
            arch: 'x64',
            seams: rec.seams,
        });
        expect(install.downloaded).toBe(true);
        expect(rec.fetched[0]).toContain('api.github.com/repos/microsoft/garnet');
        expect(norm(install.serverPath)).toBe(
            norm(garnetServerPath('/base/hosting/garnet/v2.1.1', 'win32')),
        );
    });

    it('refuses bytes whose hash is not the one GitHub published', async () => {
        const rec = recorder({
            json: release,
            produces: ['net10.0/GarnetServer.exe'],
            digests: { sha256: 'c'.repeat(64), sha512: 'b'.repeat(128) },
        });
        await expect(
            ensureGarnet({ baseDir: '/base', platform: 'win32', arch: 'x64', seams: rec.seams }),
        ).rejects.toThrow(/mismatch/);
    });

    it('refuses a release whose tag is not the one we pinned', async () => {
        // The digest would verify perfectly against the WRONG build, so the tag
        // is the only thing tying these bytes to the version we tested.
        const rec = recorder({
            json: { ...release, tag_name: 'v9.9.9' },
            produces: ['net10.0/GarnetServer.exe'],
        });
        await expect(
            ensureGarnet({ baseDir: '/base', platform: 'win32', arch: 'x64', seams: rec.seams }),
        ).rejects.toThrow(/asked for v2\.1\.1.*returned v9\.9\.9/);
    });
});
