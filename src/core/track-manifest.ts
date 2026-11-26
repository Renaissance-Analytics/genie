import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { compareTrackBuilds, parseTrackBuild } from './protocol-version.js';
import type { UpdateChannel } from './update-channel.js';

/**
 * THE SIGNED TRACK MANIFEST (Tynn #1058 L1; spec: .ai/plans/genie-2-host-split-2026-10-31.md, "Launcher build spec").
 *
 * Genie ships its programs each on its own TRACK with its own build number (`<schema>-<release>[.<hotfix>]`,
 * core/protocol-version.ts): the client, the host, the browser and the launcher. Each updates on its own (the owner,
 * 2026-11-26): a client, browser or launcher update never restarts or stops the host; a host update always comes with a
 * client, so a host package names the client build it ships with (`withClient`), and the updater (L6) applies the two
 * together. GApps join later as tracks of their own, in a new format. Every package of every track carries a
 * `manifest.json` that lists each of its files with its size and SHA-256, signed with Ed25519. The launcher runs nothing
 * it has not verified: the signature, the shape, that it is the package asked for, that it is newer than what is
 * installed, and then every file. The format is the contract in contracts/track-manifest.schema.json; the Rust launcher
 * (native/launcher, L2) reads the same bytes, and the release side writes them (scripts/pack-track.mjs,
 * scripts/sign-manifest.mjs).
 *
 * THE SIGNATURE is over the EXACT bytes of manifest.json, never a re-serialisation. manifest.json.sig is the 64-byte
 * signature in standard padded base64 on one line; trailing ASCII whitespace is read past (a CRLF checkout). A public key
 * is the raw 32 bytes, base64. KEY ROTATION: a manifest may name `nextKey`; its own signature by a trusted key is what
 * vouches for it (`trustedKeysAfter`).
 */

/** Format 2 (L3): the browser track and a host's `withClient`. Format 1 was never published. */
export const MANIFEST_FORMAT = 2;
/** The tracks that ship as packages, each updated on its own. */
export const PACKAGE_TRACKS = ['client', 'host', 'browser', 'launcher'] as const;
export type PackageTrack = (typeof PACKAGE_TRACKS)[number];

/** Only a host update restarts the host: a client, browser or launcher package is applied with the host left running. */
export function restartsHost(track: PackageTrack): boolean {
    return track === 'host';
}

/** The client build a host package ships with; `null` for any other track. */
export function hostClient(m: Pick<TrackManifest, 'track' | 'withClient'>): string | null {
    return m.track === 'host' ? m.withClient ?? null : null;
}
export const CHANNELS = ['stable', 'dev'] as const satisfies readonly UpdateChannel[];
export const PLATFORMS = ['win32', 'linux'] as const;
export type PackagePlatform = (typeof PLATFORMS)[number];
export const ARCHES = ['x64', 'arm64'] as const;
export type PackageArch = (typeof ARCHES)[number];

export interface ManifestFile {
    /** Relative, `/`-separated. */
    readonly path: string;
    readonly size: number;
    /** Lower-case hex. */
    readonly sha256: string;
}

export interface TrackManifest {
    readonly format: 2;
    readonly track: PackageTrack;
    readonly build: string;
    readonly schema: string;
    readonly channel: UpdateChannel;
    readonly platform: PackagePlatform;
    readonly arch: PackageArch;
    /** A host package's client build: the two are applied together. Required of a host, absent from every other track. */
    readonly withClient?: string;
    /** The oldest launcher build that may install it; `null` for none. */
    readonly minLauncher: string | null;
    readonly files: readonly ManifestFile[];
    readonly notes: string;
    /** The next Ed25519 public key (raw 32 bytes, base64), vouched for by this manifest's signature. */
    readonly nextKey?: string;
}

/** What the reader asks for: the package it wants, and what it has. */
export interface ManifestExpect {
    readonly track: PackageTrack;
    readonly platform: PackagePlatform;
    readonly arch: PackageArch;
    /** The install's channel: stable takes stable builds only, dev takes both. */
    readonly channel: UpdateChannel;
    /** The installed `current` build of the track; `null` on a first install. A build must be newer (no downgrade). */
    readonly current: string | null;
    /** The running launcher's build; `null` when the reader is not the launcher (nothing to compare). */
    readonly launcher: string | null;
}

export type ManifestRefusal = 'signature' | 'format' | 'track' | 'platform' | 'arch' | 'channel' | 'downgrade' | 'launcher-too-old';

export type ManifestVerdict =
    | { readonly ok: true; readonly manifest: TrackManifest; /** The trusted key that signed it. */ readonly key: string }
    | { readonly ok: false; readonly code: ManifestRefusal; readonly reason: string };

export type TreeVerdict =
    | { readonly ok: true }
    | { readonly ok: false; readonly code: 'missing-file' | 'unlisted-file' | 'not-a-file' | 'size' | 'sha256'; readonly path: string; readonly reason: string };

/** Files beside the package's own in an installed `<build>` folder, at its root only. */
export const BUILD_FOLDER_FILES = ['manifest.json', 'manifest.json.sig', '.complete'] as const;

const MAX_PATH = 1024;
const MAX_NOTES = 65_536;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9+/]{43}=$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const FIELDS = new Set(['format', 'track', 'build', 'schema', 'channel', 'platform', 'arch', 'withClient', 'minLauncher', 'files', 'notes', 'nextKey']);
const FILE_FIELDS = new Set(['path', 'size', 'sha256']);

/** A build a manifest may name: a track build with no `+metadata`. */
function isManifestBuild(build: unknown): build is string {
    return typeof build === 'string' && !build.includes('+') && build.trim() === build && parseTrackBuild(build) !== null;
}

/**
 * The semver electron-builder and package.json need for a track build: `2026.11.25-1` as it is, `2026.01.05-1` as
 * `2026.1.5-1` (semver forbids leading zeros). `+metadata` is dropped. `null` for anything that is not a track build.
 */
export function semverOf(build: string): string | null {
    const parsed = parseTrackBuild(build);
    if (!parsed) return null;
    const [y, m, d] = parsed.schema.split('.').map(Number);
    return `${y}.${m}.${d}-${parsed.release}${parsed.hotfix ? `.${parsed.hotfix}` : ''}`;
}

/** A track's release tag: `client-v2026.11.25-1`. */
export function trackTag(track: PackageTrack, build: string): string {
    return `${track}-v${build}`;
}

/** A release tag read back; `null` for the old single-app tags (`v2.0.0`, the bridge) and anything else. */
export function parseTrackTag(tag: string): { track: PackageTrack; build: string } | null {
    const m = /^([a-z]+)-v(.+)$/.exec(tag);
    if (!m || !(PACKAGE_TRACKS as readonly string[]).includes(m[1]!) || !isManifestBuild(m[2])) return null;
    return { track: m[1] as PackageTrack, build: m[2]! };
}

/** A program's own track build, stamped at release into GENIE_TRACK_BUILD; `null` in a dev run or a pre-launcher build. */
export function trackBuildFromEnv(env: Readonly<Record<string, string | undefined>>): string | null {
    const b = env.GENIE_TRACK_BUILD;
    return isManifestBuild(b) ? b : null;
}

/** The release asset's base name: `<track>-<build>-<platform>-<arch>`. */
export function packageBaseName(m: Pick<TrackManifest, 'track' | 'build' | 'platform' | 'arch'>): string {
    return `${m.track}-${m.build}-${m.platform}-${m.arch}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pathProblem(path: unknown): string | null {
    if (typeof path !== 'string' || path.length === 0) return 'a file has no path';
    if (path.length > MAX_PATH) return `a path is longer than ${MAX_PATH} characters`;
    // Every control character (Unicode Cc: C0, DEL and C1), as the contract says and the Rust reader refuses.
    // eslint-disable-next-line no-control-regex
    if (/[\\:\u0000-\u001f\u007f-\u009f]/.test(path)) return `the path ${JSON.stringify(path)} has a backslash, a colon or a control character`;
    for (const segment of path.split('/')) {
        if (segment === '' || segment === '.' || segment === '..') return `the path ${JSON.stringify(path)} is not a plain relative path`;
    }
    return null;
}

/** A manifest's shape, checked against the contract. Unknown fields refuse: a new field is a new format. */
export function parseManifest(value: unknown): { ok: true; manifest: TrackManifest } | { ok: false; code: 'format'; reason: string } {
    const bad = (why: string) => ({ ok: false as const, code: 'format' as const, reason: `This update's manifest is not one Genie can read: ${why}. Nothing was installed.` });
    if (!isPlainObject(value)) return bad('it is not an object');
    for (const k of Object.keys(value)) if (!FIELDS.has(k)) return bad(`it has a field "${k}" this Genie does not know`);
    const v = value;
    if (v.format !== MANIFEST_FORMAT) return bad(`format ${JSON.stringify(v.format)}, not ${MANIFEST_FORMAT}`);
    if (!(PACKAGE_TRACKS as readonly unknown[]).includes(v.track)) return bad(`the track ${JSON.stringify(v.track)}`);
    if (!isManifestBuild(v.build)) return bad(`the build ${JSON.stringify(v.build)} is not a track build`);
    if (v.schema !== parseTrackBuild(v.build)!.schema) return bad(`the schema ${JSON.stringify(v.schema)} is not the build's`);
    if (!(CHANNELS as readonly unknown[]).includes(v.channel)) return bad(`the channel ${JSON.stringify(v.channel)}`);
    if (!(PLATFORMS as readonly unknown[]).includes(v.platform)) return bad(`the platform ${JSON.stringify(v.platform)}`);
    if (!(ARCHES as readonly unknown[]).includes(v.arch)) return bad(`the architecture ${JSON.stringify(v.arch)}`);
    if (v.track === 'host' && !isManifestBuild(v.withClient)) return bad(`a host names the client build it ships with, and withClient is ${JSON.stringify(v.withClient)}`);
    if (v.track !== 'host' && v.withClient !== undefined) return bad(`only a host names withClient, and this is the ${String(v.track)}`);
    if (v.minLauncher !== null && !isManifestBuild(v.minLauncher)) return bad(`minLauncher ${JSON.stringify(v.minLauncher)}`);
    if (typeof v.notes !== 'string' || v.notes.length > MAX_NOTES) return bad('the notes');
    if (v.nextKey !== undefined && (typeof v.nextKey !== 'string' || !KEY.test(v.nextKey))) return bad('nextKey is not a 32-byte key');
    if (!Array.isArray(v.files) || v.files.length === 0) return bad('it lists no files');
    const files: ManifestFile[] = [];
    const folded = new Set<string>();
    let previous: string | null = null;
    for (const f of v.files) {
        if (!isPlainObject(f)) return bad('a file entry is not an object');
        for (const k of Object.keys(f)) if (!FILE_FIELDS.has(k)) return bad(`a file has a field "${k}"`);
        const problem = pathProblem(f.path);
        if (problem) return bad(problem);
        const path = f.path as string;
        if (!Number.isSafeInteger(f.size) || (f.size as number) < 0) return bad(`${path} has no size`);
        if (typeof f.sha256 !== 'string' || !SHA256.test(f.sha256)) return bad(`${path} has no SHA-256`);
        if (previous !== null && !(Buffer.compare(Buffer.from(previous), Buffer.from(path)) < 0)) return bad('its files are not sorted by path');
        const lower = path.toLowerCase();
        if (folded.has(lower)) return bad(`two files are ${path} but for case`);
        folded.add(lower);
        previous = path;
        files.push({ path, size: f.size as number, sha256: f.sha256 });
    }
    const manifest: TrackManifest = {
        format: 2, track: v.track as PackageTrack, build: v.build, schema: v.schema as string, channel: v.channel as UpdateChannel,
        platform: v.platform as PackagePlatform, arch: v.arch as PackageArch, ...(v.track === 'host' ? { withClient: v.withClient as string } : {}),
        minLauncher: v.minLauncher as string | null, files,
        notes: v.notes, ...(v.nextKey !== undefined ? { nextKey: v.nextKey as string } : {}),
    };
    return { ok: true, manifest };
}

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** A raw 32-byte public key in base64 as a KeyObject; `null` when it is not one. */
function publicKeyFrom(raw: string): KeyObject | null {
    if (typeof raw !== 'string' || !KEY.test(raw)) return null;
    try { return createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(raw, 'base64')]), format: 'der', type: 'spki' }); } catch { return null; }
}

/** What an untrusted manifest says it is, for words only ("client 2026.11.25-1"); never acted on. */
function saysItIs(bytes: Uint8Array): string {
    try {
        const v = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
        const track = typeof v.track === 'string' && (PACKAGE_TRACKS as readonly string[]).includes(v.track) ? v.track : null;
        const build = isManifestBuild(v.build) ? v.build : null;
        return track && build ? ` (it says ${track} ${build})` : '';
    } catch { return ''; }
}

/**
 * VERIFY BEFORE RUN. In order: the signature over the exact `bytes` by one of `keys`; the shape; the track, platform,
 * architecture and channel asked for; newer than `current` (equal refuses: no downgrade, and a rollback goes to the local
 * `previous`, never through here); `minLauncher`. Files are checked after, by `verifyTree` as they unpack. Never throws.
 */
export function verifyManifest(bytes: Uint8Array, sig: string | Uint8Array, keys: readonly string[], expect: ManifestExpect): ManifestVerdict {
    const text = (typeof sig === 'string' ? sig : Buffer.from(sig).toString('latin1')).replace(/[\r\n\t ]+$/, '');
    let key: string | null = null;
    // Canonical base64 only: Buffer.from ignores the padding bits of the last character, which the Rust reader (and the
    // contract's one spelling of 64 bytes) does not, so a re-encoding must give back the same text.
    if (SIGNATURE.test(text) && Buffer.from(text, 'base64').toString('base64') === text) {
        const signature = Buffer.from(text, 'base64');
        for (const k of keys) {
            const pub = publicKeyFrom(k);
            try { if (pub && verify(null, bytes, pub, signature)) { key = k; break; } } catch { /* not this key */ }
        }
    }
    if (!key) return { ok: false, code: 'signature', reason: `This update's signature is not Genie's. Nothing was installed.${saysItIs(bytes)}` };

    let value: unknown;
    const buf = Buffer.from(bytes);
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        return { ok: false, code: 'format', reason: 'This update\'s manifest is not one Genie can read: it starts with a byte-order mark. Nothing was installed.' };
    }
    try { value = JSON.parse(buf.toString('utf8')); } catch {
        return { ok: false, code: 'format', reason: 'This update\'s manifest is not one Genie can read: it is not JSON. Nothing was installed.' };
    }
    const parsed = parseManifest(value);
    if (!parsed.ok) return parsed;
    const m = parsed.manifest;
    const name = `${m.track} ${m.build}`;
    if (m.track !== expect.track) return { ok: false, code: 'track', reason: `This update is ${name}, not the ${expect.track} asked for. Nothing was installed.` };
    if (m.platform !== expect.platform) return { ok: false, code: 'platform', reason: `This update (${name}) is for ${m.platform}, not ${expect.platform}. Nothing was installed.` };
    if (m.arch !== expect.arch) return { ok: false, code: 'arch', reason: `This update (${name}) is for ${m.arch}, not ${expect.arch}. Nothing was installed.` };
    if (expect.channel === 'stable' && m.channel !== 'stable') return { ok: false, code: 'channel', reason: `This update (${name}) is a ${m.channel} build; this Genie takes stable builds only. Nothing was installed.` };
    if (expect.current !== null && compareTrackBuilds(m.build, expect.current) <= 0) {
        return { ok: false, code: 'downgrade', reason: `This update (${name}) is not newer than the installed ${expect.current}. Nothing was installed.` };
    }
    if (expect.launcher !== null && m.minLauncher !== null && compareTrackBuilds(expect.launcher, m.minLauncher) < 0) {
        return { ok: false, code: 'launcher-too-old', reason: `This update (${name}) needs launcher ${m.minLauncher} or newer; this one is ${expect.launcher}. Update the launcher first.` };
    }
    return { ok: true, manifest: m, key };
}

/** The trusted keys after a verdict: a verified manifest's `nextKey` joins them; anything else changes nothing. */
export function trustedKeysAfter(keys: readonly string[], verdict: ManifestVerdict): string[] {
    const out = [...keys];
    if (verdict.ok && verdict.manifest.nextKey && !out.includes(verdict.manifest.nextKey)) out.push(verdict.manifest.nextKey);
    return out;
}

async function fileHash(path: string): Promise<{ size: number; sha256: string }> {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) { hash.update(chunk); size += chunk.byteLength; }
    return { size, sha256: hash.digest('hex') };
}

/**
 * Every file the manifest lists is in `root` with its size and SHA-256, and nothing else is (but the build folder's own
 * manifest.json, manifest.json.sig and .complete at its root). A link or any other non-file refuses.
 */
export async function verifyTree(manifest: TrackManifest, root: string): Promise<TreeVerdict> {
    const listed = new Map(manifest.files.map((f) => [f.path, f]));
    const found = new Set<string>();
    async function walk(rel: string): Promise<TreeVerdict | null> {
        const entries = await readdir(join(root, rel), { withFileTypes: true });
        for (const e of entries) {
            const path = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) { const r = await walk(path); if (r) return r; continue; }
            if (!rel && (BUILD_FOLDER_FILES as readonly string[]).includes(e.name)) continue;
            if (!e.isFile()) return { ok: false, code: 'not-a-file', path, reason: `${path} in this ${manifest.track} build is not a plain file.` };
            const entry = listed.get(path);
            if (!entry) return { ok: false, code: 'unlisted-file', path, reason: `${path} is in this ${manifest.track} build but not in its manifest.` };
            const got = await fileHash(join(root, path));
            if (got.size !== entry.size) return { ok: false, code: 'size', path, reason: `${path} is ${got.size} bytes; the manifest says ${entry.size}.` };
            if (got.sha256 !== entry.sha256) return { ok: false, code: 'sha256', path, reason: `${path} is not the file the manifest signed.` };
            found.add(path);
        }
        return null;
    }
    const r = await walk('');
    if (r) return r;
    for (const f of manifest.files) {
        if (!found.has(f.path)) return { ok: false, code: 'missing-file', path: f.path, reason: `${f.path} is missing from this ${manifest.track} build.` };
    }
    return { ok: true };
}
