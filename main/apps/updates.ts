/**
 * PURE. Is there a newer version of an installed GApp? (Tynn #250)
 *
 * A GitHub install pins a commit, deliberately — "main" is whatever happens to be
 * there later, and what was reviewed was one commit. The cost of pinning is that an
 * app can sit for months on a version whose author fixed a bug the same week, and
 * nothing ever says so.
 *
 * This answers the question and nothing else. It does NOT update anything: a new
 * version can ask for more permissions than the user consented to, so an update has
 * to go back through the review and the consent modal like any other install.
 * Anything that quietly pulled a new commit would be an escalation path with a
 * friendly name.
 */

import type { AppGrantSource } from '../db';

export type AppUpdateState =
    /** Pinned to what the repo has. */
    | 'current'
    /** The repo has moved on; the user can review the new version. */
    | 'update-available'
    /** Nothing to compare against — no upstream, or Genie could not reach it. */
    | 'unknown'
    /** Not from a repo at all, so there is no such question. */
    | 'not-tracked';

/**
 * Two commit ids for the same commit.
 *
 * `git ls-remote` returns the full sha; what was recorded may be either form, and a
 * length mismatch must never read as "a new version is available".
 */
function sameCommit(a: string, b: string): boolean {
    const [x, y] = [a.trim().toLowerCase(), b.trim().toLowerCase()];
    if (!x || !y) return false;
    const shortest = Math.min(x.length, y.length);
    return x.slice(0, shortest) === y.slice(0, shortest);
}

export function appUpdateState(
    source: AppGrantSource | null | undefined,
    remoteHead: string | null | undefined,
): AppUpdateState {
    // A local folder has no upstream, and calling one "up to date" would be a
    // claim Genie cannot make.
    if (!source || source.kind !== 'github') return 'not-tracked';
    // Unknown, NOT current. A network failure that read as "up to date" would be
    // Genie quietly promising something it never checked.
    if (!source.commit || !remoteHead) return 'unknown';
    return sameCommit(source.commit, remoteHead) ? 'current' : 'update-available';
}

export interface UpdatableApp {
    id: string;
    origin: string;
    commit: string;
}

/**
 * The apps worth asking GitHub about, and where to ask.
 *
 * Callers should resolve each distinct ORIGIN once: a monorepo can hold several
 * apps, and hitting the same remote once per app is a rate limit waiting to happen.
 */
export function updatableApps(
    apps: ReadonlyArray<{ id: string; source: AppGrantSource | null | undefined }>,
): UpdatableApp[] {
    return apps.flatMap((app) =>
        app.source?.kind === 'github' && app.source.commit
            ? [{ id: app.id, origin: app.source.origin, commit: app.source.commit }]
            : [],
    );
}
