/**
 * GENIE'S OWN .NET — the pure half (plan `.ai/plans/genie-2-toolchain-rest.md`, row TC6a).
 *
 * Microsoft publishes every .NET SDK as an archive per OS and architecture (`dotnet-sdk-10.0.402-win-x64.zip`,
 * `…-linux-x64.tar.gz`), and each archive's sha512 in its channel's `releases.json` — the same publication the archive
 * comes from. Measured on the Windows test VM (2026-10-25): the archive is flat (dotnet at its top) and relocatable, and
 * nothing is registered. Genie installs from a STATIC list of the supported SDK lines (the other managers' rule).
 */

export type DotnetPlatform = 'win32' | 'linux' | 'darwin';
export type DotnetArch = 'x64' | 'arm64';

export interface DotnetRecipe {
    /** The SDK version. */
    readonly version: string;
    /** Its channel: where its releases.json is. */
    readonly channel: string;
}

/** The supported SDK lines, newest first: 10.0 (LTS), 9.0 (STS), 8.0 (LTS), as releases-index.json listed them on 2026-10-25. */
export const DOTNET_RECIPES: readonly DotnetRecipe[] = [
    { version: '10.0.402', channel: '10.0' },
    { version: '9.0.319', channel: '9.0' },
    { version: '8.0.426', channel: '8.0' },
];

const RID_OS: Record<DotnetPlatform, string> = { win32: 'win', linux: 'linux', darwin: 'osx' };

/** Microsoft's runtime identifier for this machine: `win-x64`, `linux-arm64`, `osx-arm64`. */
export function dotnetRid(platform: DotnetPlatform, arch: DotnetArch): string {
    return `${RID_OS[platform]}-${arch}`;
}

/** The SDK archive: `dotnet-sdk-10.0.402-win-x64.zip`, `dotnet-sdk-10.0.402-linux-x64.tar.gz`. */
export function dotnetArchiveName(version: string, rid: string): string {
    return `dotnet-sdk-${version}-${rid}.${rid.startsWith('win-') ? 'zip' : 'tar.gz'}`;
}

export function dotnetDownloadUrl(version: string, file: string): string {
    return `https://builds.dotnet.microsoft.com/dotnet/Sdk/${version}/${file}`;
}

export function dotnetReleasesUrl(channel: string): string {
    return `https://builds.dotnet.microsoft.com/dotnet/release-metadata/${channel}/releases.json`;
}

export function dotnetBinaryName(platform: DotnetPlatform): string {
    return platform === 'win32' ? 'dotnet.exe' : 'dotnet';
}

/**
 * The sha512 releases.json gives for exactly that SDK's archive for `rid` — only when it names the SAME url Genie
 * downloads, so the hash and the bytes are about one file. Anything else is `null`.
 */
export function dotnetShaFromReleases(json: string, version: string, rid: string): string | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return null;
    }
    const list = (parsed as { releases?: unknown } | null)?.releases;
    if (!Array.isArray(list)) return null;
    const url = dotnetDownloadUrl(version, dotnetArchiveName(version, rid));
    for (const release of list) {
        const sdks = [(release as { sdk?: unknown }).sdk, ...(((release as { sdks?: unknown }).sdks as unknown[] | undefined) ?? [])];
        for (const sdk of sdks) {
            const s = sdk as { version?: unknown; files?: unknown } | undefined;
            if (!s || s.version !== version || !Array.isArray(s.files)) continue;
            for (const f of s.files) {
                const e = f as { rid?: unknown; url?: unknown; hash?: unknown };
                if (e.rid !== rid || e.url !== url) continue;
                return typeof e.hash === 'string' && /^[0-9a-f]{128}$/i.test(e.hash) ? e.hash.toLowerCase() : null;
            }
        }
    }
    return null;
}

/** `dotnet --list-sdks` → each SDK and the directory it is in: `10.0.402 [C:\…\sdk]`. */
export function parseListSdks(output: string): Array<{ version: string; path: string }> {
    const out: Array<{ version: string; path: string }> = [];
    for (const line of output.split(/\r?\n/)) {
        const m = /^(\d+\.\d+\.\d+\S*)\s+\[(.+)\]\s*$/.exec(line.trim());
        if (m) out.push({ version: m[1]!, path: m[2]! });
    }
    return out;
}
