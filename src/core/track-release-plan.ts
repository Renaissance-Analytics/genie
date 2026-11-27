import { createHash } from 'node:crypto';
import { compareTrackBuilds, parseTrackBuild } from './protocol-version.js';
import { parseTrackTag, type PackageTrack } from './track-manifest.js';
import type { UpdateChannel } from './update-channel.js';

/**
 * A TRACK RELEASES ONLY WHEN IT CHANGED (Tynn #1058 L8; the envelope's .ai/plans/genie-2-host-split-2026-10-31.md,
 * "Launcher build spec", slice 8). `.github/workflows/release.yml` runs a ROUND for one approved tag:
 *
 *   tracks-v<build>       a stable round: every changed track gets a full-release draft <track>-v<build>
 *   tracks-dev-v<build>   a dev round: the same, as prereleases (only the dev channel reads them)
 *
 * Every track is built at that build; each track's FINGERPRINT is compared with the one its last PUBLISHED release
 * carries (`<track>-<build>.fingerprint.json`, an asset beside its packages), and only the tracks that differ are drafted.
 * A draft nobody published is no release: no install has it, so it is never what a track is compared with.
 *
 * WHAT A FINGERPRINT COVERS (scripts/track-release-plan.ts `fingerprints` reads the files; this module hashes them):
 *   launcher  native/launcher (its source, Cargo.lock, its window's ui/, the release key keys.rs builds in) and
 *             build/tray-icon.png, which it embeds (the job's GENIE_MANIFEST_PUBLIC_KEY must be that release key)
 *   host      dist/main/host.js and every built file only it reaches (its import graph), package-lock.json (its
 *             node_modules and Electron, its runtime), and the scripts that lay it out and fetch its Caddy
 *   client    every other built file (dist/, the renderer, the preload, the window's main and the chunks it shares with
 *             the host), package-lock.json, electron-builder.yml, build/ and the scripts that lay it out
 *   browser   its browser.json (scripts/track-packages.mjs): it runs on the client build its manifest names
 *
 * The built files are read, not the sources, for the client and the host: what separates them is the bundler's import
 * graph, and the host's own identity (genieHostHash, Tynn #413) is already its built bundle. A file a build makes
 * differently each time (a timestamp, a random id) would only ever release a track that did not need it, never skip one
 * that did, and so would a source file that feeds no package.
 *
 * THE OWNER'S RULES ON TOP (2026-11-26): "host updates always come with a UI update", so a changed host brings its
 * client; the browser runs on the client build its manifest names (the host's and the browser's manifests name THIS
 * build's client, scripts/build-track-packages.mjs), so a new client brings a new browser and a new browser its client.
 * Unknown is changed: a track never released, or whose fingerprint cannot be read, is released.
 */

/** The order drafts are made and uploaded: a host after the client it names. */
export const RELEASE_ORDER = ['launcher', 'client', 'browser', 'host'] as const satisfies readonly PackageTrack[];

export type TrackFingerprints = Record<PackageTrack, string>;

const ROUND = /^tracks-(?:(dev)-)?v(.+)$/;

/** A round tag read: its build and channel; `null` for anything else (an app tag, a track's own tag, a bad build). */
export function parseRoundTag(tag: string): { build: string; channel: UpdateChannel } | null {
    const m = ROUND.exec(tag);
    if (!m) return null;
    const build = m[2]!;
    // A track build exactly, as a manifest may name it: no `+metadata`, a real date, release 1 or more.
    if (build.includes('+') || !parseTrackTag(`client-v${build}`)) return null;
    return { build, channel: m[1] === 'dev' ? 'dev' : 'stable' };
}

/** Which tracks this round drafts, and why each is in or out. */
export function tracksToRelease(
    now: TrackFingerprints,
    last: Partial<Record<PackageTrack, string | null | undefined>>,
): { release: PackageTrack[]; why: Record<PackageTrack, string> } {
    const changed = (t: PackageTrack) => {
        const was = last[t];
        return typeof was !== 'string' || was === '' ? 'never released, or its fingerprint could not be read' : was !== now[t] ? 'changed' : null;
    };
    const why = {} as Record<PackageTrack, string>;
    for (const t of RELEASE_ORDER) why[t] = changed(t) ?? 'unchanged';
    const out = new Set<PackageTrack>(RELEASE_ORDER.filter((t) => why[t] !== 'unchanged'));
    if (out.has('host') && !out.has('client')) {
        out.add('client');
        why.client = 'unchanged, released with the host (a host update always comes with its client)';
    }
    if (out.has('browser') && !out.has('client')) {
        out.add('client');
        why.client = "unchanged, released with the browser (the browser names this build's client)";
    }
    if (out.has('client') && !out.has('browser')) {
        out.add('browser');
        why.browser = 'unchanged, released with the client it runs on';
    }
    return { release: RELEASE_ORDER.filter((t) => out.has(t)), why };
}

export interface ReleaseListing {
    readonly tagName: string;
    readonly isDraft: boolean;
    readonly isPrerelease: boolean;
}

/**
 * The release a track is compared with: its newest PUBLISHED release before `build` that `channel` reads (stable: full
 * releases; dev: prereleases too). `null` when it has none.
 */
export function lastPublished(releases: readonly ReleaseListing[], track: PackageTrack, channel: UpdateChannel, build: string): { tag: string; build: string } | null {
    let best: { tag: string; build: string } | null = null;
    for (const r of releases) {
        if (r.isDraft || (channel === 'stable' && r.isPrerelease)) continue;
        const t = parseTrackTag(r.tagName);
        if (!t || t.track !== track || compareTrackBuilds(t.build, build) >= 0) continue;
        if (!best || compareTrackBuilds(t.build, best.build) > 0) best = { tag: r.tagName, build: t.build };
    }
    return best;
}

/** One fingerprint over a set of files: SHA-256 of `path NUL sha256 LF` per file, sorted by path. */
export function fingerprintOf(files: ReadonlyArray<{ path: string; sha256: string }>): string {
    const lines = files.map((f) => `${f.path}\u0000${f.sha256}\n`).sort();
    return createHash('sha256').update(lines.join('')).digest('hex');
}

/** The release asset that carries a track's fingerprint: beside its packages, outside the stem the launcher reads. */
export function fingerprintAssetName(track: PackageTrack, build: string): string {
    if (!parseTrackBuild(build)) throw new Error(`not a track build: ${build}`);
    return `${track}-${build}.fingerprint.json`;
}

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(["'])(\.{1,2}\/[^"'\s]+)\1/g;

/** The relative specifiers a built ES module imports (static, re-exported or dynamic); bare and `node:` ones are not files. */
export function importsOf(source: string): string[] {
    const out = new Set<string>();
    for (const m of source.matchAll(IMPORT)) out.add(m[2]!);
    return [...out];
}

function join(from: string, spec: string): string {
    const parts = from.split('/').slice(0, -1);
    for (const s of spec.split('/')) {
        if (s === '..') parts.pop();
        else if (s !== '.') parts.push(s);
    }
    return parts.join('/');
}

function reach(entries: readonly string[], read: (path: string) => string | null): Set<string> {
    const seen = new Set<string>();
    const todo = [...entries];
    while (todo.length) {
        const p = todo.pop()!;
        if (seen.has(p)) continue;
        const text = read(p);
        if (text === null) continue;
        seen.add(p);
        for (const spec of importsOf(text)) todo.push(join(p, spec));
    }
    return seen;
}

/** The built files only the host reaches: `hostEntry` and its import graph, less everything `others` reach. */
export function hostOnlyFiles(hostEntry: string, others: readonly string[], read: (path: string) => string | null): string[] {
    const theirs = reach(others, read);
    return [...reach([hostEntry], read)].filter((p) => !theirs.has(p));
}
