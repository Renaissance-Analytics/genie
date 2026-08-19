import { app, net } from 'electron';

/**
 * Build a human changelog for the update popover by reading a description per
 * git commit between the installed version and the latest release, grouped per
 * version so a user several releases behind sees the changes stacked newest-first.
 * Release commits tag the VERSION as the subject with the note in the body, so a
 * per-commit description is resolved (see describeCommit) rather than the raw
 * subject — otherwise the popover just repeats the version string.
 *
 * Two GitHub calls, then bucket locally:
 *   1. /compare/v{current}...v{latest} → every commit in the range, each
 *      with its subject + author date.
 *   2. /releases?per_page=30 → tag → published_at, to draw the version
 *      boundaries we bucket commits into.
 *
 * Public repo, unauthenticated (genie's releases are public). Best-effort:
 * any failure yields an empty changelog and the popover just shows the
 * version bump without notes.
 */

const REPO = 'Renaissance-Analytics/genie';

export interface ChangelogGroup {
    version: string; // e.g. "0.7.0-alpha.17"
    changes: string[]; // per-commit descriptions, newest-first
}

export interface Changelog {
    current: string;
    latest: string;
    groups: ChangelogGroup[];
    /** True when notes couldn't be fetched (offline, API error). */
    partial: boolean;
}

interface CompareCommit {
    sha: string;
    commit: { message: string; committer?: { date?: string }; author?: { date?: string } };
}

async function ghJson<T>(path: string): Promise<T | null> {
    try {
        const res = await net.fetch(`https://api.github.com${path}`, {
            headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'Genie/0.7 (changelog)',
            },
        });
        if (!res.ok) return null;
        return (await res.json()) as T;
    } catch {
        return null;
    }
}

/** Drop noise that doesn't belong in a user-facing changelog. */
function isNoise(subject: string): boolean {
    return (
        /^merge\b/i.test(subject) ||
        /^(chore|ci|build)(\(|:)/i.test(subject) ||
        subject.toLowerCase().startsWith('remove throwaway') ||
        subject.toLowerCase().includes('retrigger deploy')
    );
}

/**
 * Strip a leading release-version prefix from a line: `v0.7.0-beta.100 — Foo`
 * → `Foo`. The separator may be an em-dash (—), en-dash (–), or hyphen (-), and
 * must be whitespace-flanked so a prerelease hyphen (e.g. `-beta.100`) is never
 * mistaken for the separator. A line with no such prefix is returned unchanged.
 */
function stripVersionPrefix(text: string): string {
    const m = /^v?\d+\.\d+\.\d+[0-9A-Za-z.-]*\s+[—–-]\s+(.+)$/.exec(text);
    return m ? m[1].trim() : text;
}

/** True when a line is JUST a version, e.g. `v0.7.0-beta.100` (nothing after). */
function isVersionOnly(text: string): boolean {
    return /^v?\d+\.\d+\.\d+[\w.-]*$/.test(text.trim());
}

/**
 * The line the update popover shows for one commit — or `''` for the commits
 * that should never reach it, which is most of them (genie#224).
 *
 * This used to return the commit SUBJECT. Subjects are written for the repo, so
 * the popover showed the owner things like "Stop classifying a site by its
 * PUBLISHED port — a running container read as host-native": engineering
 * reasoning rendered as a product surface, next to a Restart button.
 *
 * Filtering cannot fix that. What separates an internal subject from a
 * user-facing note is INTENT, not vocabulary, so any blocklist keeps leaking
 * whatever it failed to anticipate. Notes are therefore OPT-IN — nothing appears
 * unless it was written to appear:
 *
 *   1. A `Release-Note:` trailer, anywhere in the message. The escape hatch for
 *      an ordinary commit that genuinely changes something people will notice.
 *   2. Otherwise a RELEASE commit's headline (`vX.Y.Z — the thing that changed`),
 *      which is already written for people and is what the popover has always
 *      really been showing when it looked right.
 *   3. Otherwise nothing.
 */
const RELEASE_NOTE_TRAILER = /^\s*Release-Note:\s*(.+)$/im;

export function describeCommit(message: string): string {
    const trailer = RELEASE_NOTE_TRAILER.exec(message);
    if (trailer) {
        const note = stripVersionPrefix(trailer[1].trim());
        if (note && !isVersionOnly(note)) return note;
    }

    // A RELEASE commit — and only a release commit. The version prefix is what
    // marks a subject as deliberately written for this popover.
    const subject = (message.split('\n')[0] ?? '').trim();
    const headline = stripVersionPrefix(subject);
    if (headline !== subject && headline && !isVersionOnly(headline)) return headline;

    // A bare `vX.Y.Z` subject: the note is the first meaningful body line.
    if (isVersionOnly(subject)) {
        const bodyLine = message
            .split('\n')
            .slice(1)
            .map((l) => l.trim())
            .find((l) => l.length > 0);
        if (bodyLine) {
            const fromBody = stripVersionPrefix(bodyLine);
            if (fromBody && !isVersionOnly(fromBody)) return fromBody;
        }
    }

    return '';
}

let cache: { key: string; value: Changelog } | null = null;

export async function getChangelog(latest: string): Promise<Changelog> {
    const current = app.getVersion();
    const key = `${current}->${latest}`;
    if (cache && cache.key === key) return cache.value;

    const result: Changelog = { current, latest, groups: [], partial: false };

    if (!latest || latest === current) {
        cache = { key, value: result };
        return result;
    }

    const compare = await ghJson<{ commits: CompareCommit[] }>(
        `/repos/${REPO}/compare/v${current}...v${latest}`,
    );
    if (!compare || !Array.isArray(compare.commits)) {
        result.partial = true;
        cache = { key, value: result };
        return result;
    }

    // Tag → published date, ascending, for versions in (current, latest].
    const releases =
        (await ghJson<Array<{ tag_name: string; published_at: string }>>(
            `/repos/${REPO}/releases?per_page=30`,
        )) ?? [];
    const boundaries = releases
        .map((r) => ({
            version: r.tag_name.replace(/^v/i, ''),
            at: Date.parse(r.published_at),
        }))
        .filter((b) => Number.isFinite(b.at) && isNewer(b.version, current))
        .sort((a, b) => a.at - b.at); // ascending

    // Each commit → the earliest release whose publish time is >= the
    // commit's date (that's the version it shipped in). Commits past the
    // last known release date fall under `latest`.
    const byVersion = new Map<string, string[]>();
    for (const c of compare.commits) {
        // Resolve a meaningful description (release commits tag the version as
        // the subject and put the note in the body); '' drops version-only/empty.
        const change = describeCommit(c.commit.message);
        if (!change || isNoise(change)) continue;
        const when = Date.parse(
            c.commit.committer?.date ?? c.commit.author?.date ?? '',
        );
        let version = latest;
        if (Number.isFinite(when)) {
            const hit = boundaries.find((b) => when <= b.at + 60_000);
            if (hit) version = hit.version;
        }
        if (!byVersion.has(version)) byVersion.set(version, []);
        byVersion.get(version)!.push(change);
    }

    // Emit groups newest-first. GitHub's compare returns commits oldest →
    // newest, so reverse within each group too.
    const versionsDesc = Array.from(byVersion.keys()).sort((a, b) =>
        isNewer(a, b) ? -1 : 1,
    );
    result.groups = versionsDesc.map((version) => ({
        version,
        changes: (byVersion.get(version) ?? []).reverse(),
    }));

    cache = { key, value: result };
    return result;
}

/** Minimal semver-ish "a newer than b" — major.minor.patch then prerelease. */
function isNewer(a: string, b: string): boolean {
    const pa = parse(a);
    const pb = parse(b);
    if (!pa || !pb) return a > b;
    for (let i = 0; i < 3; i++) {
        if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i];
    }
    if (pa.pre === pb.pre) return false;
    if (!pa.pre) return true; // release > prerelease
    if (!pb.pre) return false;
    return comparePre(pa.pre, pb.pre) > 0;
}

/** Compare dot-separated prerelease ids, numeric segments numerically
 *  (so alpha.10 > alpha.2). Returns 1 if a>b, -1 if a<b, 0 if equal. */
function comparePre(a: string, b: string): number {
    const as = a.split('.');
    const bs = b.split('.');
    for (let i = 0; i < Math.max(as.length, bs.length); i++) {
        const x = as[i];
        const y = bs[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        const xn = /^\d+$/.test(x);
        const yn = /^\d+$/.test(y);
        if (xn && yn) {
            if (+x !== +y) return +x > +y ? 1 : -1;
        } else if (x !== y) {
            return x > y ? 1 : -1;
        }
    }
    return 0;
}

function parse(v: string): { nums: [number, number, number]; pre: string } | null {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v.replace(/^v/i, ''));
    if (!m) return null;
    return { nums: [+m[1], +m[2], +m[3]], pre: m[4] ?? '' };
}
