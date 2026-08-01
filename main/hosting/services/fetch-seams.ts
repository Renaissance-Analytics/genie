import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * The download/unpack I/O the three service fetchers share.
 *
 * `frankenphp-fetch.ts` carries its own copy of this because it was the only
 * fetcher in P2. P3 adds three more — PostgreSQL, the .NET runtime and Garnet —
 * and a fourth copy of "stream a URL through sha256 into a staging directory"
 * would be four places to get a redirect, a hash comparison or an atomic move
 * subtly wrong. So the IMPURE half is factored out here once; each fetcher keeps
 * its own PURE half (which artifact, from where, verified how), because that is
 * the part that actually differs and the part worth unit-testing.
 *
 * Everything here is deliberately dependency-free `node:` code: this runs in the
 * Electron main process before any window exists.
 */

// --- the seam --------------------------------------------------------------

export interface FetchSeams {
    /** GET a URL and parse the body as JSON (a release manifest). */
    fetchJson<T>(url: string): Promise<T>;
    /** Stream `url` to `destPath`, returning the hex sha256 AND sha512 of what
     *  was written. Both, because upstreams publish different digests: GitHub
     *  publishes sha256, Microsoft's .NET metadata publishes sha512. Hashing
     *  twice over one pass is far cheaper than downloading twice. */
    download(url: string, destPath: string): Promise<{ sha256: string; sha512: string }>;
    /**
     * Unpack `archivePath` INTO `destDir`.
     *
     * `members` restricts extraction to those archive paths. The PostgreSQL zip
     * is 330 MB of which ~50 MB is pgAdmin and the docs — a desktop GUI and a
     * manual that a headless managed cluster has no use for. Naming the members
     * we want turns a 330 MB unpack into a 75 MB one.
     */
    extract(archivePath: string, destDir: string, members?: readonly string[]): Promise<void>;
    fileExists(p: string): Promise<boolean>;
    mkdir(p: string): Promise<void>;
    move(from: string, to: string): Promise<void>;
    remove(p: string): Promise<void>;
    chmodExec(p: string): Promise<void>;
}

/** Coarse phases for the UI. Bytes are unknown until the response arrives, so
 *  this reports what is happening rather than a fake percentage. */
export type FetchPhase = 'resolving' | 'downloading' | 'verifying' | 'extracting';

export interface EnsureInstallOptions {
    /** Genie's userData dir — must PERSIST across app updates. */
    baseDir: string;
    platform?: NodeJS.Platform | string;
    arch?: string;
    seams?: FetchSeams;
    onPhase?: (phase: FetchPhase) => void;
}

// --- the shared install dance ----------------------------------------------

/** Where the bytes come from and how they are checked. */
export interface ResolvedArtifact {
    url: string;
    /** File name to download to (also decides zip-vs-raw handling). */
    assetName: string;
    /** Verify the download. Throws with a useful message on a mismatch. */
    verify(digests: { sha256: string; sha512: string }): void;
    /** Archive members to extract, when the asset is an archive. */
    members?: readonly string[];
    /** For raw (non-archive) assets: where the binary lands inside the staging
     *  dir, relative to it. */
    rawDestRelative?: string;
}

export interface StagedInstallPlan {
    /** Where the finished install must end up. */
    installDir: string;
    /** The file whose existence proves the install completed. */
    sentinel: string;
    /**
     * Work out which artifact to fetch — called ONLY when the install is
     * missing.
     *
     * A function rather than a value because two of the three fetchers know
     * their URL from a pinned constant while Garnet's requires a call to the
     * GitHub release API. Deferring it is what keeps the common case — an
     * install that is already there — entirely off the network.
     */
    resolve(): Promise<ResolvedArtifact> | ResolvedArtifact;
}

/**
 * Download → verify → unpack → move into place, atomically.
 *
 * The three properties `frankenphp-fetch.ts` argues for at length hold here for
 * the same reasons, so the reasoning is not repeated: provenance (a pinned
 * official URL), integrity (verified before anything is executed), atomicity
 * (one `move`, so a crash mid-download can never leave a truncated `postgres.exe`
 * at the path the next start would happily spawn).
 *
 * Returns `false` when the install was already there, `true` when this call did
 * the work — which is what tells the caller whether to report a first-use
 * download to the user.
 */
export async function ensureStagedInstall(
    plan: StagedInstallPlan,
    baseDir: string,
    seams: FetchSeams,
    onPhase?: (phase: FetchPhase) => void,
): Promise<boolean> {
    if (await seams.fileExists(plan.sentinel)) return false;

    onPhase?.('resolving');
    const artifact = await plan.resolve();

    const staging = path.join(
        stagingRootFor(baseDir),
        `${path.basename(plan.installDir)}-${crypto.randomBytes(6).toString('hex')}`,
    );
    const stagedOut = path.join(staging, 'out');
    try {
        await seams.mkdir(stagedOut);

        onPhase?.('downloading');
        const archivePath = path.join(staging, artifact.assetName);
        const digests = await seams.download(artifact.url, archivePath);

        onPhase?.('verifying');
        artifact.verify(digests);

        if (isArchive(artifact.assetName)) {
            onPhase?.('extracting');
            await seams.extract(archivePath, stagedOut, artifact.members);
        } else {
            const dest = path.join(stagedOut, artifact.rawDestRelative ?? artifact.assetName);
            await seams.mkdir(path.dirname(dest));
            await seams.move(archivePath, dest);
            // Release artifacts arrive without the executable bit; without this
            // every start fails with EACCES.
            await seams.chmodExec(dest);
        }

        // The sentinel is expressed relative to the FINAL install dir, so check
        // for its staged twin before committing — an archive that unpacked to an
        // unexpected shape must fail here, not at the first spawn.
        const stagedSentinel = path.join(stagedOut, path.relative(plan.installDir, plan.sentinel));
        if (!(await seams.fileExists(stagedSentinel))) {
            throw new Error(
                `${artifact.assetName} did not yield ${path.relative(plan.installDir, plan.sentinel)} — install aborted`,
            );
        }

        await seams.mkdir(path.dirname(plan.installDir));
        await seams.move(stagedOut, plan.installDir);
    } finally {
        await seams.remove(staging).catch(() => {});
    }
    return true;
}

/** Staging root — a sibling of the install dirs, so the final move is a rename
 *  within one filesystem rather than a cross-device copy. */
export function stagingRootFor(baseDir: string): string {
    return path.join(baseDir, 'hosting', '.staging');
}

/** Where one engine's versioned install lives under Genie's userData.
 *
 *  Per-VERSION, for the reason `frankenphp-fetch.ts` gives: an upgrade installs
 *  ALONGSIDE rather than over a binary that may be serving a workspace's data
 *  right now, and overwriting a running `postgres.exe` is impossible on Windows
 *  and merely catastrophic elsewhere. */
export function engineInstallDir(baseDir: string, engine: string, version: string): string {
    return path.join(baseDir, 'hosting', engine, version);
}

export function isArchive(assetName: string): boolean {
    return /\.(zip|tar\.gz|tar\.xz|tgz)$/.test(assetName);
}

/** PURE. Compare a published digest to what we hashed, and say which artifact
 *  disagreed. Throws rather than returning a boolean so no caller can forget. */
export function assertDigest(
    assetName: string,
    algorithm: 'sha256' | 'sha512',
    expected: string,
    actual: string,
): void {
    if (expected.trim().toLowerCase() === actual.trim().toLowerCase()) return;
    throw new Error(
        `${assetName}: ${algorithm} mismatch\n` +
            `  expected ${expected.toLowerCase()}\n` +
            `  actual   ${actual.toLowerCase()}\n` +
            'The download was discarded.',
    );
}

// --- default seams (real I/O) ----------------------------------------------

const USER_AGENT = 'Genie-Hosting-Runtime';

/** A single GET that follows the publisher's redirect to its CDN. */
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
                    reject(new Error(`hosting-fetch: too many redirects for ${url}`));
                    return;
                }
                const next = new URL(location, url);
                // Only ever follow to https. The digest check would still catch
                // tampering on a plaintext hop, but there is no reason to put
                // the bytes on the wire in the clear.
                if (next.protocol !== 'https:') {
                    reject(
                        new Error(`hosting-fetch: refusing non-https redirect to ${next.protocol}`),
                    );
                    return;
                }
                resolve(httpsGet(next.toString(), headers, redirectsLeft - 1));
                return;
            }
            if (status !== 200) {
                res.resume();
                reject(new Error(`hosting-fetch: ${url} responded ${status}`));
                return;
            }
            resolve(res);
        });
        req.on('error', reject);
    });
}

/**
 * bsdtar, which Windows has shipped in System32 since Windows 10 1803 and which
 * reads zip as well as tar. Resolved through `%SystemRoot%` rather than PATH so
 * a `tar` earlier on the user's PATH cannot be what unpacks a service binary.
 */
function systemTarPath(): string {
    if (process.platform !== 'win32') return 'tar';
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    return path.join(root, 'System32', 'tar.exe');
}

export const defaultFetchSeams: FetchSeams = {
    async fetchJson<T>(url: string): Promise<T> {
        const res = await httpsGet(url, {
            'user-agent': USER_AGENT,
            accept: 'application/json, application/vnd.github+json',
        });
        const chunks: Buffer[] = [];
        for await (const chunk of res) chunks.push(chunk as Buffer);
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
    },

    async download(url, destPath) {
        const res = await httpsGet(url, { 'user-agent': USER_AGENT, accept: '*/*' });
        const sha256 = crypto.createHash('sha256');
        const sha512 = crypto.createHash('sha512');
        await fsp.mkdir(path.dirname(destPath), { recursive: true });
        const out = fs.createWriteStream(destPath);
        await new Promise<void>((resolve, reject) => {
            res.on('data', (chunk: Buffer) => {
                sha256.update(chunk);
                sha512.update(chunk);
            });
            res.on('error', reject);
            out.on('error', reject);
            out.on('finish', resolve);
            res.pipe(out);
        });
        return { sha256: sha256.digest('hex'), sha512: sha512.digest('hex') };
    },

    async extract(archivePath, destDir, members) {
        await new Promise<void>((resolve, reject) => {
            const child = spawn(
                systemTarPath(),
                ['-xf', archivePath, '-C', destDir, ...(members ?? [])],
                { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
            );
            let stderr = '';
            child.stderr?.on('data', (c) => {
                stderr = (stderr + String(c)).slice(-2000);
            });
            child.on('error', reject);
            child.on('close', (code) =>
                code === 0
                    ? resolve()
                    : reject(new Error(`hosting-fetch: extraction failed (${code}): ${stderr}`)),
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
