import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/**
 * THE BUNDLED CADDY RUNTIME (§6.6).
 *
 * Genie serves static and php sites and the external-browser front door with its OWN Caddy, shipped
 * beside the app under `resources/runtime/` (electron-builder `extraResources`), fetched at build
 * time by `scripts/fetch-caddy.mjs` from Caddy's GitHub release — pinned by VERSION and the sha512
 * Caddy publishes for each archive, so a build cannot silently pick up a different binary. An install
 * without the binary answers `null`, and a static/php site is then refused with the fix named rather
 * than served by something hand-rolled.
 */

export const CADDY_VERSION = '2.11.7';

const SUMS: Readonly<Record<string, string>> = {
    linux_amd64: 'a7a433a1b133efc3c8d10eb0b99d52a24b5ef5c322dc77f5282182b1c0402139ab83f3a99f0c52409df77d20123fb0b523edad8a66d8f5e49136197bf61ef0e7',
    linux_arm64: '3db36ba90c7a6e8dda40ee3dd71fa08844c76b5fb08f61b31e5e78d2ed38e71c51dc7baed875e50d1ca1279196e84302967237386ae87c91ae9f2aaceada682e',
    mac_amd64: '147886811fa2320a8881c6116dc8cc3f0562e2f686509ccc60f55cf85dfd5ea78e9f5f770c75da13bf124a2536b72e887b975fefd58706de3dafb57483610e70',
    mac_arm64: '68f592df8f0ec058fbdb9b137b64e9a0aa792d28c06e1e3b9ec12d0e7fb371683a54e73ef6d8e6d0dd70dc6b941a5b5d5b73faedd3f89de119ad2eb78bdc668e',
    windows_amd64: 'c308154504e53755958ffc62d8a2657ab17eefd6dd25c45dbb2c3d93d29519971f77ca652f7d0f2bcb7f980b9ba3822478865e29969d0272d7613550a43152b1',
    windows_arm64: '5e232f5fd68968c288034d98f8b4a6b16f246da6d5f1d3a8c7543b83327f1de0bf5d01d627768fbfd1dd254d7d53eb94589a40b126c29def10ac01365a3fe982',
};

export interface CaddyDownload {
    readonly url: string;
    readonly sha512: string;
    readonly archive: 'tar.gz' | 'zip';
    readonly binaryInArchive: 'caddy' | 'caddy.exe';
}

/** The pinned release archive for a platform/arch, with the sum Caddy published for it. */
export function caddyDownload(platform: 'win32' | 'darwin' | 'linux', arch: 'x64' | 'arm64'): CaddyDownload {
    const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'mac' : 'linux';
    const cpu = arch === 'arm64' ? 'arm64' : 'amd64';
    const archive = platform === 'win32' ? 'zip' : 'tar.gz';
    const key = `${os}_${cpu}`;
    const sha512 = SUMS[key];
    if (!sha512) throw new Error(`no pinned Caddy archive for ${key}`);
    return {
        url: `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_${key}.${archive}`,
        sha512,
        archive,
        binaryInArchive: platform === 'win32' ? 'caddy.exe' : 'caddy',
    };
}

/** The binary in a packaged app, or `null` when this install has none. */
export function caddyBinPath(resourcesPath: string, platform: NodeJS.Platform, exists: (p: string) => boolean = existsSync): string | null {
    // A packaged Windows path is a Windows path wherever this runs (the test machine is Linux).
    const file = (platform === 'win32' ? win32 : posix).join(resourcesPath, 'runtime', platform === 'win32' ? 'caddy.exe' : 'caddy');
    return exists(file) ? file : null;
}
