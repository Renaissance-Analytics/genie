import path from 'node:path';
import {
    assertDigest,
    defaultFetchSeams,
    engineInstallDir,
    ensureStagedInstall,
    type EnsureInstallOptions,
    type FetchSeams,
} from './fetch-seams';

/**
 * FETCH-ON-FIRST-USE for the .NET runtime (Tynn #232, P3).
 *
 * This exists only because Garnet — the engine behind the `redis` service, see
 * `types.ts` — is a .NET program, and Microsoft publishes it FRAMEWORK-DEPENDENT:
 * the release zip carries an app host and 32 MB of ReadyToRun code, but no
 * runtime. Running it on a machine without .NET produces exactly one message,
 * "You must install .NET to run this application", which is measured behaviour
 * and not something to leave a user to discover.
 *
 * Genie will not tell anyone to install .NET, and will not silently use a system
 * install whose version it did not choose. It fetches a PRIVATE runtime under
 * userData and points `DOTNET_ROOT` at it, exactly the way `frankenphp-fetch.ts`
 * fetches a private PHP. Nothing is installed system-wide, nothing goes on PATH,
 * and uninstalling Genie removes it with the rest of userData.
 *
 * It is a smaller download than it sounds: ~28 MB compressed, against
 * FrankenPHP's 277 MB and PostgreSQL's 330 MB.
 */

// --- the pinned release ----------------------------------------------------

/**
 * The .NET runtime Genie installs.
 *
 * .NET 10 rather than 8: both are LTS and Garnet ships a build for each, but
 * 8 leaves support in November 2026 and 10 in November 2028. Pinning the older
 * one would mean shipping a runtime that goes unsupported within the year.
 *
 * Pinned to an exact patch for the reason every pin in this directory is: two
 * installs of the same Genie build must produce the same runtime, or a bug
 * report names something we cannot reproduce.
 */
export const DOTNET_VERSION = '10.0.10';

/** The `net<major>` Garnet build directory this runtime can execute. */
export const DOTNET_TFM = 'net10.0';

const DOTNET_BASE = 'https://builds.dotnet.microsoft.com/dotnet/Runtime';

export interface DotnetAsset {
    name: string;
    url: string;
    /** Microsoft publishes sha512 for these, not sha256. */
    sha512: string;
}

/**
 * The published sha512 per runtime identifier.
 *
 * Taken from Microsoft's official release metadata
 * (`release-metadata/10.0/releases.json`) for {@link DOTNET_VERSION} and pinned
 * here rather than fetched at run time. Fetching would have been easier, but the
 * metadata is served by the SAME host as the binary — so comparing one against
 * the other proves only that a CDN did not corrupt the bytes. A constant in
 * reviewed source cannot be changed after the fact by anything short of a commit,
 * which is the property worth having for a runtime Genie is about to execute.
 *
 * The `win-x64` entry was additionally verified by downloading the artifact and
 * hashing it (2026-08-01); the rest are the publisher's own recorded digests.
 */
const HASHES: Readonly<Record<string, string>> = {
    'win-x64':
        '2161dfa1cf027cdc074de7195b5f206b17ebd829ae415b9e7c9ee5f06d3952b6583030022dbe0d6e9221b5c577c411d7cd5322241f6d2299d9c886641215699b',
    'win-arm64':
        '69f575e8a612adcb360689b0c4099c097e58ce48905b9ab2c109855513e0acda0e688cd40326b7ba3eef8b26b793589cf2a4c68423f73d3d4c8f9e3dc4c254c4',
    'osx-x64':
        '4269fde5d17bee092f47fb63387c0bb1ab58b21d4af8eb0ead118b51d677fc7dada9b8f46cf3d1e25449c07f7e0350938cd741e882ed43bf6ab1541dccd489da',
    'osx-arm64':
        '79cbc64bfeb806d5f2a9e0a2a2ed336c7aa275b0438bbd88d36236a1b6203950546b49ff307cc5067c89434ffe22c021a594b2f8adad71146a5ece825652bd85',
    'linux-x64':
        '74b2b41ee177fe72da02741d5ba30e8a3c5ead44151d7a72a04ed81a0a933e827f5f8cfcc048ba4e8de5aeb7651953761b7586277d0bcce2e01323ca29ccb813',
    'linux-arm64':
        '3ea2ac626fdb0f26bb52f02584ae5e68ee88c275e740b34d93918ad380985d0dbfa1632c017658dfddc5fba396114b62748efc11b25897877814a4a4c5022edc',
};

/** PURE. Microsoft's runtime identifier for a platform/arch, or null. */
export function ridFor(platform: NodeJS.Platform | string, arch: string): string | null {
    const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
    if (!cpu) return null;
    if (platform === 'win32') return `win-${cpu}`;
    if (platform === 'darwin') return `osx-${cpu}`;
    if (platform === 'linux') return `linux-${cpu}`;
    return null;
}

/** PURE. The artifact for a platform/arch, or `null` when there is none. */
export function assetFor(platform: NodeJS.Platform | string, arch: string): DotnetAsset | null {
    const rid = ridFor(platform, arch);
    if (!rid) return null;
    const sha512 = HASHES[rid];
    if (!sha512) return null;
    const name = `dotnet-runtime-${DOTNET_VERSION}-${rid}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
    return { name, url: `${DOTNET_BASE}/${DOTNET_VERSION}/${name}`, sha512 };
}

// --- pure: where it lands --------------------------------------------------

export function dotnetInstallDir(baseDir: string, version = DOTNET_VERSION): string {
    return engineInstallDir(baseDir, 'dotnet', version);
}

/** PURE. The `dotnet` host executable inside an install. */
export function dotnetHostPath(installDir: string, platform: NodeJS.Platform | string): string {
    return path.join(installDir, platform === 'win32' ? 'dotnet.exe' : 'dotnet');
}

// --- thin impure -----------------------------------------------------------

export interface DotnetInstall {
    version: string;
    installDir: string;
    /** Goes in the child's environment as `DOTNET_ROOT`; that is the whole
     *  mechanism by which Garnet's app host finds THIS runtime and not a system
     *  one. */
    dotnetRoot: string;
    hostPath: string;
    downloaded: boolean;
}

export async function ensureDotnet(opts: EnsureInstallOptions): Promise<DotnetInstall> {
    const platform = opts.platform ?? process.platform;
    const arch = opts.arch ?? process.arch;
    const seams: FetchSeams = opts.seams ?? defaultFetchSeams;

    const asset = assetFor(platform, arch);
    if (!asset) {
        throw new Error(
            `dotnet: no runtime build for ${platform}/${arch} — the redis service cannot run here`,
        );
    }

    const installDir = dotnetInstallDir(opts.baseDir);
    const hostPath = dotnetHostPath(installDir, platform);

    const downloaded = await ensureStagedInstall(
        {
            installDir,
            sentinel: hostPath,
            resolve: () => ({
                url: asset.url,
                assetName: asset.name,
                verify: (d) => assertDigest(asset.name, 'sha512', asset.sha512, d.sha512),
            }),
        },
        opts.baseDir,
        seams,
        opts.onPhase,
    );

    return { version: DOTNET_VERSION, installDir, dotnetRoot: installDir, hostPath, downloaded };
}
