/**
 * GENIE'S OWN GO — the pure half (the owner, 2026-10-18: the toolchain "should not be partial to any language";
 * 2026-10-25: "rest of the toolchain"; plan `.ai/plans/genie-2-toolchain-rest.md`, row TC2a).
 *
 * go.dev publishes relocatable builds for every OS, and the sha256 of every archive in its own JSON index. Genie installs
 * from a STATIC list of the supported lines (the Node and PHP managers' rule: a box that accepts any string mostly
 * produces failed downloads), and reads each archive's checksum from that index at install time — the same publication
 * the archive comes from.
 */

export type GoPlatform = 'win32' | 'linux' | 'darwin';
export type GoArch = 'x64' | 'arm64';

export interface GoRecipe {
    readonly version: string;
}

/** The supported lines, newest first: go.dev's two stable releases on 2026-10-25 (`?mode=json`). */
export const GO_RECIPES: readonly GoRecipe[] = [{ version: '1.27.3' }, { version: '1.26.10' }];

/** go.dev's release index, every release with every file's sha256. */
export const GO_DL_INDEX = 'https://go.dev/dl/?mode=json&include=all';

const GOOS: Record<GoPlatform, string> = { win32: 'windows', linux: 'linux', darwin: 'darwin' };
const GOARCH: Record<GoArch, string> = { x64: 'amd64', arm64: 'arm64' };

/** go.dev's archive file name: `go1.27.3.windows-amd64.zip`, `go1.27.3.linux-arm64.tar.gz`. */
export function goArchiveName(version: string, platform: GoPlatform, arch: GoArch): string {
    return `go${version}.${GOOS[platform]}-${GOARCH[arch]}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
}

/** What `go version` names as this machine: `windows/amd64`. */
export function goPlatformTag(platform: GoPlatform, arch: GoArch): string {
    return `${GOOS[platform]}/${GOARCH[arch]}`;
}

export function goDownloadUrl(file: string): string {
    return `https://go.dev/dl/${file}`;
}

export function goBinaryName(platform: GoPlatform): string {
    return platform === 'win32' ? 'go.exe' : 'go';
}

/** The sha256 go.dev's index gives for exactly `file`, or `null` — a missing or malformed entry is never guessed at. */
export function goShaFromIndex(json: string, file: string): string | null {
    let releases: unknown;
    try {
        releases = JSON.parse(json);
    } catch {
        return null;
    }
    if (!Array.isArray(releases)) return null;
    for (const release of releases) {
        const files = (release as { files?: unknown }).files;
        if (!Array.isArray(files)) continue;
        for (const f of files) {
            const entry = f as { filename?: unknown; sha256?: unknown };
            if (entry.filename === file && typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(entry.sha256)) return entry.sha256.toLowerCase();
        }
    }
    return null;
}

/** `go version go1.27.3 linux/amd64` → its version and platform; `null` when it is not that. */
export function parseGoVersion(output: string): { version: string; platform: string } | null {
    const m = /^go version go(\d+\.\d+(?:\.\d+)?)\S* (\S+\/\S+)\s*$/m.exec(output.trim());
    return m ? { version: m[1]!, platform: m[2]! } : null;
}
