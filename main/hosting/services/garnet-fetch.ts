import path from 'node:path';
import {
    assertDigest,
    defaultFetchSeams,
    engineInstallDir,
    ensureStagedInstall,
    type EnsureInstallOptions,
    type FetchSeams,
} from './fetch-seams';
import { DOTNET_TFM } from './dotnet-fetch';

/**
 * FETCH-ON-FIRST-USE for Garnet — the engine behind the `redis` service
 * (Tynn #232, P3).
 *
 * See `types.ts#ServiceEngine` for WHY the Redis slot runs Garnet rather than
 * Redis: upstream Redis ships source only and does not support Windows, so there
 * is no official Redis binary to fetch on any platform. Garnet is Microsoft's
 * MIT-licensed RESP server, published as prebuilt binaries for every
 * platform/arch Genie ships to.
 *
 * Provenance works the same way `frankenphp-fetch.ts` does — and can, because
 * Garnet releases live on GitHub: the release API publishes a `digest` per asset
 * over a DIFFERENT TLS connection than the asset itself, so the expected hash
 * does not come from the host serving the bytes. That is why this file has no
 * pinned constants while `postgres-fetch.ts` does; EDB publishes no digest, and
 * the difference is argued there.
 *
 * The download is ~48 MB and needs a .NET runtime beside it — see
 * `dotnet-fetch.ts`, which is fetched the same way and pointed at with
 * `DOTNET_ROOT`.
 */

// --- the pinned release ----------------------------------------------------

/** The Garnet release Genie installs. Pinned, never `latest`. */
export const GARNET_VERSION = 'v2.1.1';

/** The official repository. */
const GARNET_REPO = 'microsoft/garnet';

export function releaseApiUrl(version: string = GARNET_VERSION): string {
    return `https://api.github.com/repos/${GARNET_REPO}/releases/tags/${version}`;
}

export interface GithubReleaseAsset {
    name: string;
    /** `sha256:<hex>` — GitHub's published digest for the asset. */
    digest?: string | null;
    browser_download_url: string;
}

export interface GithubRelease {
    tag_name: string;
    assets: GithubReleaseAsset[];
}

// --- pure: which artifact --------------------------------------------------

/**
 * PURE. The official asset name for a platform/arch, or `null`.
 *
 * Windows gets the `readytorun` zip (precompiled, so the server starts without
 * a JIT warm-up); the others get the plain per-rid tarball, which is what
 * upstream publishes for them. The `portable` asset is deliberately unused: it
 * is the same code without a native app host, so it would need `dotnet
 * GarnetServer.dll` and a second way to launch.
 */
export function assetNameFor(platform: NodeJS.Platform | string, arch: string): string | null {
    const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
    if (!cpu) return null;
    if (platform === 'win32') return `win-${cpu}-based-readytorun.zip`;
    if (platform === 'darwin') return `osx-${cpu}-based.tar.xz`;
    if (platform === 'linux') return `linux-${cpu}-based.tar.xz`;
    return null;
}

/**
 * PURE. The asset's URL plus the sha256 GitHub published for it.
 *
 * Refuses an asset with no digest, or one whose digest is not a sha256, rather
 * than installing bytes it cannot check — the same stance, and for the same
 * reason, as `selectAsset` in `frankenphp-fetch.ts`.
 */
export function selectAsset(
    release: GithubRelease,
    assetName: string,
): { url: string; sha256: string } {
    const asset = release.assets?.find((a) => a.name === assetName);
    if (!asset) {
        throw new Error(`garnet: release ${release.tag_name} has no asset named ${assetName}`);
    }
    if (!asset.digest) {
        throw new Error(
            `garnet: ${assetName} has no published digest — refusing to install unverifiable bytes`,
        );
    }
    const match = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest.trim());
    if (!match) {
        throw new Error(`garnet: ${assetName} digest is not a sha256 (${asset.digest})`);
    }
    return { url: asset.browser_download_url, sha256: match[1]!.toLowerCase() };
}

// --- pure: where it lands --------------------------------------------------

export function garnetInstallDir(baseDir: string, version = GARNET_VERSION): string {
    return engineInstallDir(baseDir, 'garnet', version);
}

/**
 * PURE. The server executable inside an install.
 *
 * Every Garnet artifact unpacks to one directory per target framework
 * (`net8.0/`, `net10.0/`); we run the one matching the runtime `dotnet-fetch.ts`
 * installs, so the two pins move together.
 */
export function garnetServerPath(
    installDir: string,
    platform: NodeJS.Platform | string,
    tfm: string = DOTNET_TFM,
): string {
    return path.join(installDir, tfm, platform === 'win32' ? 'GarnetServer.exe' : 'GarnetServer');
}

// --- thin impure -----------------------------------------------------------

export interface GarnetInstall {
    version: string;
    installDir: string;
    serverPath: string;
    downloaded: boolean;
}

export async function ensureGarnet(opts: EnsureInstallOptions): Promise<GarnetInstall> {
    const platform = opts.platform ?? process.platform;
    const arch = opts.arch ?? process.arch;
    const seams: FetchSeams = opts.seams ?? defaultFetchSeams;

    const assetName = assetNameFor(platform, arch);
    if (!assetName) {
        throw new Error(
            `garnet: no official build for ${platform}/${arch} — the redis service cannot run here`,
        );
    }

    const installDir = garnetInstallDir(opts.baseDir);
    const serverPath = garnetServerPath(installDir, platform);

    const downloaded = await ensureStagedInstall(
        {
            installDir,
            sentinel: serverPath,
            resolve: async () => {
                const release = await seams.fetchJson<GithubRelease>(releaseApiUrl());
                if (release.tag_name !== GARNET_VERSION) {
                    // The digest would verify perfectly against the WRONG build,
                    // so the tag is the only thing tying these bytes to the
                    // version Genie was tested against.
                    throw new Error(
                        `garnet: asked for ${GARNET_VERSION} but the release API returned ${release.tag_name}`,
                    );
                }
                const { url, sha256 } = selectAsset(release, assetName);
                return {
                    url,
                    assetName,
                    verify: (d) => assertDigest(assetName, 'sha256', sha256, d.sha256),
                };
            },
        },
        opts.baseDir,
        seams,
        opts.onPhase,
    );

    return { version: GARNET_VERSION, installDir, serverPath, downloaded };
}
