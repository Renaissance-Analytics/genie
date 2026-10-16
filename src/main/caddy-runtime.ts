import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, copyFile as nodeCopyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, posix, win32 } from 'node:path';

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

/** sha256 of a file, streamed (the binary is tens of megabytes). */
export function sha256OfFile(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(path)
            .on('data', (chunk) => hash.update(chunk))
            .on('error', reject)
            .on('end', () => resolve(hash.digest('hex')));
    });
}

export interface CaddyCopy {
    /** The binary to RUN: the per-user copy, or — when the copy could not be made — the bundled one. */
    readonly path: string;
    /** Whether this call copied (the bundled binary is new to this machine, or its copy was incomplete). */
    readonly copied: boolean;
    /** Why the copy could not be made; the bundled binary is then what runs. */
    readonly error: string | null;
}

const COPY_DIR = /^[0-9a-f]{16}$/;

/**
 * THE CADDY THAT SURVIVES AN UPDATE (Genie 1's genie#265). Run from `resources/runtime/` inside the install, Caddy sits
 * in the NSIS installer's path sweep: every update kills the front door — and every static/php site's server — mid
 * session. So Genie runs it from a per-user copy under its data dir, in a folder named by the bundled binary's sha256:
 *
 * - the same bundled binary → the copy already there (its `.complete` names the hash), copied NOTHING;
 * - a new bundled binary (an update that bumped Caddy) → a new folder beside the old; a running old copy is never
 *   overwritten, and the folders of other hashes are removed when they can be (a locked one is left for next time);
 * - a copy is committed by its `.complete` marker, written last, after the copied bytes hash to the bundled ones — an
 *   interrupted copy is never run.
 *
 * Never throws: a copy that cannot be made answers the bundled path with the reason (sites still serve; they go down on
 * the next update, as before).
 */
export async function userCaddyCopy(bundled: string, baseDir: string, deps: { copyFile?: (from: string, to: string) => Promise<void>; platform?: NodeJS.Platform } = {}): Promise<CaddyCopy> {
    const copyFile = deps.copyFile ?? nodeCopyFile;
    const platform = deps.platform ?? process.platform;
    try {
        const sha = await sha256OfFile(bundled);
        const dir = join(baseDir, sha.slice(0, 16));
        const name = basename(bundled);
        const dest = join(dir, name);
        const marker = join(dir, '.complete');
        const committed = await readFile(marker, 'utf8').then((t) => t.trim() === sha, () => false);
        const present = await stat(dest).then((s) => s.isFile(), () => false);
        let copied = false;
        if (!committed || !present) {
            await mkdir(dir, { recursive: true });
            await rm(marker, { force: true });
            const tmp = join(dir, `${name}.partial-${process.pid}`);
            await copyFile(bundled, tmp);
            const got = await sha256OfFile(tmp);
            if (got !== sha) {
                await rm(tmp, { force: true });
                throw new Error(`the copy of ${bundled} does not match it (sha256 ${got.slice(0, 16)}…, expected ${sha.slice(0, 16)}…)`);
            }
            if (platform !== 'win32') await chmod(tmp, 0o755);
            await rm(dest, { force: true });
            await rename(tmp, dest);
            await writeFile(marker, sha, 'utf8');
            copied = true;
        }
        // Other hashes' folders: an earlier Caddy. Removed when nothing holds them; a locked one waits for a later boot.
        for (const entry of await readdir(baseDir).catch(() => [] as string[])) {
            if (entry === sha.slice(0, 16) || !COPY_DIR.test(entry)) continue;
            await rm(join(baseDir, entry), { recursive: true, force: true }).catch(() => undefined);
        }
        return { path: dest, copied, error: null };
    } catch (error) {
        return { path: bundled, copied: false, error: `Genie runs its Caddy from the install folder this session — the per-user copy could not be made: ${error instanceof Error ? error.message : String(error)}` };
    }
}
