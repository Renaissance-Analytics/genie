import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * FETCH-ON-FIRST-USE for the FrankenPHP runtime (Tynn #232, P2).
 *
 * The owner's decision (2026-08-01): Genie does NOT bundle a ~277 MB PHP runtime
 * in its installer. The first time a workspace hosts a **PHP** site we download
 * the official build, verify it, and keep it. A **static** site never reaches
 * this module at all — the static adapter has no PHP dependency, so previewing a
 * built frontend costs nothing, which is the common case.
 *
 * Three properties matter more than anything else here:
 *
 * 1. **Provenance.** The artifact comes from `github.com/php/frankenphp`
 *    releases and nowhere else — no mirror, no CDN we operate, no "latest"
 *    redirect. The tag is PINNED in this file, so two installs of the same Genie
 *    build get the same PHP.
 * 2. **Integrity.** GitHub publishes a `digest` (`sha256:…`) per release asset
 *    on the API, delivered over a DIFFERENT TLS connection than the asset
 *    itself. We stream the download through sha256 and refuse a mismatch. An
 *    asset with no published digest is refused outright rather than trusted.
 * 3. **Atomicity.** Everything lands in a staging directory and is moved into
 *    place in one step. A crash mid-download can therefore never leave a
 *    truncated `frankenphp.exe` at the path the next start will happily spawn.
 *
 * The install is keyed by VERSION, under Genie's userData dir — so it survives
 * app updates (the reason not to put it next to the app bundle) and an upgrade
 * to a newer FrankenPHP installs alongside rather than over a runtime that may
 * be serving a site right now.
 *
 * Split as usual: everything above `--- thin impure ---` is pure and directly
 * unit-tested; the I/O below is behind the {@link FrankenPhpFetchSeams} the
 * tests substitute, so no test in this repo downloads 277 MB.
 */

// --- the pinned release ----------------------------------------------------

/**
 * The FrankenPHP release Genie installs.
 *
 * Pinned, never `latest`: `latest` would change the embedded PHP version under a
 * user between two installs of the SAME Genie build, and a bug report would name
 * a runtime we cannot reproduce. Bumping this is a deliberate, testable change.
 *
 * v1.12.6 = PHP 8.5.9 + Caddy v2.11.4 (the pair the P1 spike + the P2 serve path
 * were verified against).
 */
export const FRANKENPHP_VERSION = 'v1.12.6';

/** The official repository. Not a constant to be reconfigured — a mirror is
 *  exactly the substitution the digest check exists to make useless. */
const FRANKENPHP_REPO = 'php/frankenphp';

/** The release API URL for a tag. */
export function releaseApiUrl(version: string): string {
    return `https://api.github.com/repos/${FRANKENPHP_REPO}/releases/tags/${version}`;
}

// --- the release payload ---------------------------------------------------

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
 * The official asset name for an OS/arch, or `null` when upstream publishes
 * none.
 *
 * Returning `null` is the point: handing a Windows-on-ARM machine the x86_64
 * zip yields a binary that cannot execute, and that failure would surface far
 * away from here as a site that mysteriously refuses to start. Better to say
 * "no build for this platform" at the moment we would have downloaded it.
 *
 * The `-gnu`, `-debug` and `-mimalloc` Linux variants are deliberately not used:
 * the default musl-static build has no host glibc requirement, which is what
 * makes one artifact work across distributions.
 */
export function assetNameFor(platform: NodeJS.Platform | string, arch: string): string | null {
    if (platform === 'win32') return arch === 'x64' ? 'frankenphp-windows-x86_64.zip' : null;
    if (platform === 'darwin') {
        if (arch === 'arm64') return 'frankenphp-mac-arm64';
        return arch === 'x64' ? 'frankenphp-mac-x86_64' : null;
    }
    if (platform === 'linux') {
        if (arch === 'x64') return 'frankenphp-linux-x86_64';
        return arch === 'arm64' ? 'frankenphp-linux-aarch64' : null;
    }
    return null;
}

/** PURE. The asset's URL plus the sha256 GitHub published for it. Throws — with
 *  the reason — rather than returning something unverifiable. */
export function selectAsset(
    release: GithubRelease,
    assetName: string,
): { url: string; sha256: string } {
    const asset = release.assets?.find((a) => a.name === assetName);
    if (!asset) {
        throw new Error(
            `frankenphp: release ${release.tag_name} has no asset named ${assetName}`,
        );
    }
    if (!asset.digest) {
        throw new Error(
            `frankenphp: ${assetName} has no published digest — refusing to install unverifiable bytes`,
        );
    }
    const match = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest.trim());
    if (!match) {
        throw new Error(
            `frankenphp: ${assetName} digest is not a sha256 (${asset.digest}) — refusing to install`,
        );
    }
    return { url: asset.browser_download_url, sha256: match[1]!.toLowerCase() };
}

// --- pure: where it lands --------------------------------------------------

/**
 * The install directory for one version, under Genie's userData.
 *
 * Per-VERSION so an upgrade installs alongside rather than over a runtime that
 * may be serving a site at that very moment — overwriting a running
 * `frankenphp.exe` is impossible on Windows and merely catastrophic elsewhere.
 */
export function installDirFor(baseDir: string, version = FRANKENPHP_VERSION): string {
    return path.join(baseDir, 'hosting', 'frankenphp', version);
}

/** Staging root — siblings of the install dirs, so the final move is a rename
 *  within one filesystem rather than a cross-device copy. */
export function stagingRootFor(baseDir: string): string {
    return path.join(baseDir, 'hosting', '.staging');
}

export interface RuntimeLayout {
    /** ABSOLUTE path to the executable. */
    binaryPath: string;
    /**
     * The dynamic-extension directory, or `null` when this build has its
     * extensions compiled in.
     *
     * This distinction is load-bearing, not cosmetic. The Windows artifact is
     * the official PHP binary distribution — extensions are DLLs in `ext/` and
     * NONE are enabled without a generated ini (see `php-ini.ts`). The
     * macOS/Linux artifacts are single static binaries with those same
     * extensions already built in; generating `extension = curl` for them makes
     * PHP fail to load a library it already has. So the layout says which world
     * we are in, and `frankenphp.ts` only writes an ini when there is a real
     * `ext/` to point at.
     */
    extensionDir: string | null;
}

/** PURE. Where the binary and (on Windows) the extension dir sit inside an
 *  installed runtime. */
export function layoutFor(installDir: string, platform: NodeJS.Platform | string): RuntimeLayout {
    if (platform === 'win32') {
        return {
            binaryPath: path.join(installDir, 'frankenphp.exe'),
            extensionDir: path.join(installDir, 'ext'),
        };
    }
    return { binaryPath: path.join(installDir, 'frankenphp'), extensionDir: null };
}

/** PURE. Windows ships the runtime as a zip; every other platform ships the raw
 *  executable. */
export function isArchive(assetName: string): boolean {
    return assetName.endsWith('.zip');
}

// --- thin impure: the seams ------------------------------------------------

export interface FrankenPhpFetchSeams {
    /** GET the release JSON. */
    fetchRelease(url: string): Promise<GithubRelease>;
    /** Stream `url` to `destPath`, returning the hex sha256 of what was written. */
    download(url: string, destPath: string): Promise<string>;
    /** Unpack an archive INTO `destDir` (which already exists). */
    extract(archivePath: string, destDir: string): Promise<void>;
    fileExists(p: string): Promise<boolean>;
    mkdir(p: string): Promise<void>;
    move(from: string, to: string): Promise<void>;
    remove(p: string): Promise<void>;
    chmodExec(p: string): Promise<void>;
}

export interface EnsureFrankenPhpOptions {
    /** Genie's userData dir — must PERSIST across app updates. */
    baseDir: string;
    version?: string;
    platform?: NodeJS.Platform | string;
    arch?: string;
    seams?: FrankenPhpFetchSeams;
    /** Progress for the UI: bytes are unknown until the response arrives, so
     *  this reports coarse phases rather than a fake percentage. */
    onPhase?: (phase: 'resolving' | 'downloading' | 'verifying' | 'extracting') => void;
}

export interface FrankenPhpInstall extends RuntimeLayout {
    version: string;
    installDir: string;
    /** True when THIS call performed the download (i.e. first use). */
    downloaded: boolean;
}

/**
 * Ensure the pinned FrankenPHP runtime is installed, downloading it once.
 *
 * Safe to call on every PHP site start: an installed runtime short-circuits
 * before any network request.
 */
export async function ensureFrankenPhp(
    opts: EnsureFrankenPhpOptions,
): Promise<FrankenPhpInstall> {
    const version = opts.version ?? FRANKENPHP_VERSION;
    const platform = opts.platform ?? process.platform;
    const arch = opts.arch ?? process.arch;
    const seams = opts.seams ?? defaultSeams;

    const installDir = installDirFor(opts.baseDir, version);
    const layout = layoutFor(installDir, platform);

    if (await seams.fileExists(layout.binaryPath)) {
        return { ...layout, version, installDir, downloaded: false };
    }

    const assetName = assetNameFor(platform, arch);
    if (!assetName) {
        throw new Error(
            `frankenphp: no official build for ${platform}/${arch} — PHP sites cannot be hosted on this platform`,
        );
    }

    opts.onPhase?.('resolving');
    const release = await seams.fetchRelease(releaseApiUrl(version));
    if (release.tag_name !== version) {
        // The digest would verify perfectly against the WRONG runtime, so the
        // tag is the only thing tying these bytes to the version Genie was
        // tested with.
        throw new Error(
            `frankenphp: asked for ${version} but the release API returned ${release.tag_name}`,
        );
    }
    const { url, sha256 } = selectAsset(release, assetName);

    const staging = path.join(
        stagingRootFor(opts.baseDir),
        `${version}-${crypto.randomBytes(6).toString('hex')}`,
    );
    const stagedOut = path.join(staging, 'out');
    try {
        await seams.mkdir(stagedOut);

        opts.onPhase?.('downloading');
        const archivePath = path.join(staging, assetName);
        const actual = await seams.download(url, archivePath);

        opts.onPhase?.('verifying');
        if (actual.toLowerCase() !== sha256) {
            throw new Error(
                `frankenphp: checksum mismatch for ${assetName}\n` +
                    `  expected ${sha256}\n` +
                    `  actual   ${actual.toLowerCase()}\n` +
                    'The download was discarded.',
            );
        }

        const stagedLayout = layoutFor(stagedOut, platform);
        if (isArchive(assetName)) {
            opts.onPhase?.('extracting');
            await seams.extract(archivePath, stagedOut);
        } else {
            await seams.move(archivePath, stagedLayout.binaryPath);
            // The release artifact arrives without the executable bit; without
            // this every start fails with EACCES.
            await seams.chmodExec(stagedLayout.binaryPath);
        }

        if (!(await seams.fileExists(stagedLayout.binaryPath))) {
            throw new Error(
                `frankenphp: ${assetName} did not yield ${path.basename(stagedLayout.binaryPath)} — install aborted`,
            );
        }

        // One move = the install is atomic. Anything that fails above leaves
        // only the staging directory, which the `finally` removes.
        await seams.mkdir(path.dirname(installDir));
        await seams.move(stagedOut, installDir);
    } finally {
        await seams.remove(staging).catch(() => {});
    }

    return { ...layout, version, installDir, downloaded: true };
}

// --- default seams (real I/O) ----------------------------------------------

/** GitHub asks every API client to identify itself; an anonymous request is
 *  rejected outright. */
const USER_AGENT = 'Genie-Hosting-Runtime';

/** A single GET that follows GitHub's redirect to the release CDN. */
function httpsGet(
    url: string,
    headers: Record<string, string>,
    redirectsLeft = 5,
): Promise<import('node:http').IncomingMessage> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers }, (res) => {
            const status = res.statusCode ?? 0;
            const location = res.headers.location;
            if (status >= 300 && status < 400 && location) {
                res.resume();
                if (redirectsLeft <= 0) {
                    reject(new Error(`frankenphp: too many redirects for ${url}`));
                    return;
                }
                // Release assets redirect to objects.githubusercontent.com. Only
                // ever follow to https — a downgrade to http would put the bytes
                // on the wire in the clear (the digest check would still catch
                // tampering, but there is no reason to allow it).
                const next = new URL(location, url);
                if (next.protocol !== 'https:') {
                    reject(new Error(`frankenphp: refusing non-https redirect to ${next.protocol}`));
                    return;
                }
                resolve(httpsGet(next.toString(), headers, redirectsLeft - 1));
                return;
            }
            if (status !== 200) {
                res.resume();
                reject(new Error(`frankenphp: ${url} responded ${status}`));
                return;
            }
            resolve(res);
        });
        req.on('error', reject);
    });
}

/**
 * bsdtar, which Windows has shipped in System32 since Windows 10 1803 and which
 * reads zip archives. Resolved through `%SystemRoot%` rather than PATH so a
 * `tar` earlier on the user's PATH cannot be what unpacks a 277 MB runtime.
 */
function systemTarPath(): string {
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    return path.join(root, 'System32', 'tar.exe');
}

const defaultSeams: FrankenPhpFetchSeams = {
    async fetchRelease(url) {
        const res = await httpsGet(url, {
            'user-agent': USER_AGENT,
            accept: 'application/vnd.github+json',
        });
        const chunks: Buffer[] = [];
        for await (const chunk of res) chunks.push(chunk as Buffer);
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as GithubRelease;
    },

    async download(url, destPath) {
        const res = await httpsGet(url, { 'user-agent': USER_AGENT, accept: '*/*' });
        const hash = crypto.createHash('sha256');
        const out = fs.createWriteStream(destPath);
        await new Promise<void>((resolve, reject) => {
            res.on('data', (chunk: Buffer) => hash.update(chunk));
            res.on('error', reject);
            out.on('error', reject);
            out.on('finish', resolve);
            res.pipe(out);
        });
        return hash.digest('hex');
    },

    async extract(archivePath, destDir) {
        if (process.platform !== 'win32') {
            throw new Error('frankenphp: archive extraction is only used on Windows');
        }
        await new Promise<void>((resolve, reject) => {
            const child = spawn(systemTarPath(), ['-xf', archivePath, '-C', destDir], {
                shell: false,
                windowsHide: true,
                stdio: ['ignore', 'ignore', 'pipe'],
            });
            let stderr = '';
            child.stderr?.on('data', (c) => {
                stderr = (stderr + String(c)).slice(-2000);
            });
            child.on('error', reject);
            child.on('close', (code) =>
                code === 0
                    ? resolve()
                    : reject(new Error(`frankenphp: extraction failed (${code}): ${stderr}`)),
            );
        });
    },

    async fileExists(p) {
        try {
            await fsp.access(p);
            return true;
        } catch {
            return false;
        }
    },

    async mkdir(p) {
        await fsp.mkdir(p, { recursive: true });
    },

    async move(from, to) {
        await fsp.rename(from, to);
    },

    async remove(p) {
        await fsp.rm(p, { recursive: true, force: true });
    },

    async chmodExec(p) {
        await fsp.chmod(p, 0o755);
    },
};
