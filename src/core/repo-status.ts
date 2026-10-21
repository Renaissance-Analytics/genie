/**
 * THE WORKSPACE HEADER'S REPO CHIPS — the board's `api · main` (git-branch icon) and, when a repo's index is locked,
 * a red `web · index.lock held` with "Remove stale lock".
 *
 * Read from `.git` directly, with no library and no guess: `HEAD` names the branch (`ref: refs/heads/main`), a
 * detached HEAD is the short sha, a repo Genie cannot read has no branch — the chip is the slug alone, never a dash.
 * `index.lock` is git's own lock; it is STALE only once it has sat longer than any real git command takes, and the fix
 * is offered only then — a fresh lock is a command in flight, said and left alone.
 */

/** A lock older than this is nobody's: git holds `index.lock` for the length of one command, not minutes. */
export const STALE_LOCK_AFTER_MS = 2 * 60_000;

export function branchFromHead(head: string | null): string | null {
    if (!head) return null;
    const text = head.trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
    if (ref) return ref[1] ?? null;
    if (/^[0-9a-f]{40}$/i.test(text)) return text.slice(0, 7);
    return null;
}

export interface LockState {
    heldSince: number;
    stale: boolean;
}

export function lockState(lockMtime: number | null, now: number): LockState | null {
    if (lockMtime === null) return null;
    return { heldSince: lockMtime, stale: now - lockMtime > STALE_LOCK_AFTER_MS };
}

export interface RepoStatus {
    slug: string;
    branch: string | null;
    lock: LockState | null;
}

export interface RepoChip {
    label: string;
    tone: 'normal' | 'bad';
    /** The one fix the board offers, when it applies. */
    fix: 'Remove stale lock' | null;
}

/**
 * HOW MANY REPO CHIPS SIT IN THE WORKSPACE HEADER'S ROW (beta.33 item 23). The owner: "why the fuck is any content at all
 * behind the fucking chat panel?" — one chip per repo made the header wider than its column. The rest are behind
 * "+N more", one click away.
 */
export const HEADER_REPOS_INLINE = 3;

/**
 * The header's repos: the row, and the rest behind "+N more". A LOCKED repo always comes first — a problem is never
 * behind a click — then the manifest's order. Every repo is in exactly one of the two.
 */
export function headerRepos<R extends { slug: string; lock?: LockState | { heldSince: number; stale: boolean } | null }>(repos: readonly R[], inline = HEADER_REPOS_INLINE): { inline: R[]; more: R[] } {
    const ordered = [...repos.filter((r) => r.lock), ...repos.filter((r) => !r.lock)];
    // Locked repos are never hidden, even past the row's usual count.
    const count = Math.max(inline, repos.filter((r) => r.lock).length);
    return { inline: ordered.slice(0, count), more: ordered.slice(count) };
}

export function repoChip(status: RepoStatus): RepoChip {
    if (status.lock) return { label: `${status.slug} · index.lock held`, tone: 'bad', fix: status.lock.stale ? 'Remove stale lock' : null };
    return { label: status.branch ? `${status.slug} · ${status.branch}` : status.slug, tone: 'normal', fix: null };
}
