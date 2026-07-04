import type {
    GithubCapabilities,
    GithubCapabilityKey,
    WatchFeedItem,
    WatchFetchError,
    WatchRepoView,
    WorkspaceWatchStatus,
} from './genie';

/**
 * Issue Watch repo-list ↔ Activity-feed consistency.
 *
 * The repo-list count badge and the Activity feed MUST always agree about
 * whether a repo has an open item. They used to drift: the badge was a
 * seen-based "unread" count (zeroed by mark-seen) read from one poll, while the
 * feed listed all open items from another (racing) read — so a repo could show
 * a "1" badge over an empty feed, or no badge over a feed that lists its issue.
 *
 * The fix is to derive the badge from the SAME feed array the Activity list
 * renders. These pure helpers are that single source of truth: the badge count
 * is exactly the number of feed items attributed to the repo row, so the two can
 * never contradict on existence.
 */

/** The repo-row fields needed to attribute a feed item (the watched repo + its
 *  optional fork-upstream). */
export type RepoRef = Pick<WatchRepoView, 'owner' | 'repo' | 'upstream'>;

/**
 * Whether a feed item belongs to a given repo ROW. An OWN item belongs to the
 * repo whose owner/repo it carries. An UPSTREAM item is folded in from a fork's
 * parent, so it carries the UPSTREAM slug — it belongs to the fork row whose
 * `upstream` matches. (Both kinds originate from the same watched repo's poll,
 * so every feed item maps to exactly one row in a consistent snapshot.)
 */
export function feedItemBelongsToRepo(item: WatchFeedItem, repo: RepoRef): boolean {
    if (item.source === 'upstream') {
        return (
            !!repo.upstream &&
            item.owner === repo.upstream.owner &&
            item.repo === repo.upstream.repo
        );
    }
    return item.owner === repo.owner && item.repo === repo.repo;
}

/**
 * The open-item count to badge on a repo row — derived from the SAME feed the
 * Activity list renders, so the badge and the feed can never disagree about
 * whether a repo has an open item. Counts the repo's own items AND the upstream
 * items folded in for that fork (both appear in the feed).
 */
export function openCountForRepo(feed: WatchFeedItem[], repo: RepoRef): number {
    let n = 0;
    for (const it of feed) if (feedItemBelongsToRepo(it, repo)) n += 1;
    return n;
}

/**
 * The Issue Watch capability keys the flyout gates on, in display order — the
 * five `issue-watch.*` capabilities (mirrors main's `IW_CAPABILITY_KEYS`).
 */
export const IW_CAPABILITY_KEYS: readonly GithubCapabilityKey[] = [
    'issue-watch.issues',
    'issue-watch.pulls',
    'issue-watch.dependabot',
    'issue-watch.code-scanning',
    'issue-watch.secret-scanning',
];

/** The GitHub-auth GATE the Issue Watch flyout renders once the workspace's
 *  status has loaded: which top-level state to show, scoped to whose GitHub the
 *  user must act on. */
export type IwGateView =
    /** The stored session is dead. `scope:'local'` → the device-flow Reconnect
     *  banner; `scope:'host'` → "reconnect on the host machine" (no local flow). */
    | { view: 'reconnect'; scope: 'local' | 'host' }
    /** GitHub isn't connected. `scope:'local'` → "connect in Settings";
     *  `scope:'host'` → "connect GitHub on the host machine". */
    | { view: 'connect'; scope: 'local' | 'host' }
    /** Connected & authed — show the feed, with `gatedCaps` disabled by a
     *  missing GitHub App permission. */
    | { view: 'feed'; gatedCaps: GithubCapabilityKey[] };

export interface IwGateInput {
    /** True in a remote (Work-Mode host) window — the gate reflects the HOST. */
    remote: boolean;
    /**
     * The per-workspace status. In a remote window this is HOST-sourced (the
     * bridge routes `issueWatch.status` to `/api/desktop/issue-watch/status`),
     * so its `connected` / `needsReauth` / `error` / `missingCapabilities` are
     * the HOST's. In a local window it's the client's own status.
     */
    status: Pick<WorkspaceWatchStatus, 'connected' | 'needsReauth'> & {
        error: WatchFetchError | null;
        missingCapabilities?: GithubCapabilityKey[];
    };
    /**
     * The CLIENT's live GitHub capabilities (`useGithubCapabilities`). Drives
     * the capability gate in a LOCAL window; IGNORED in a remote one (there the
     * gate uses `status.missingCapabilities` from the host).
     */
    localCaps: Pick<GithubCapabilities, 'connected' | 'missing'>;
}

/**
 * Decide the Issue Watch flyout's GitHub-auth gate. The SINGLE source of truth
 * for "reconnect vs connect vs feed" and which capabilities are gated, so the
 * component just renders the result and the decision is unit-testable off-DOM.
 *
 * REMOTE window: every signal comes from the HOST — `status` is host-sourced
 * (connected / dead-session / missing capabilities), and the auth `scope` is
 * `'host'` so the flyout points the user at the host machine and NEVER runs the
 * client's device-flow reconnect (which would pointlessly auth the client).
 *
 * LOCAL window: byte-for-byte the prior behavior — the auth state comes from the
 * client's own status and the capability gate from the client's `localCaps`,
 * scope `'local'` (the device-flow Reconnect / Settings copy).
 */
export function issueWatchGate(input: IwGateInput): IwGateView {
    const { remote, status, localCaps } = input;
    const scope: 'local' | 'host' = remote ? 'host' : 'local';
    // A dead session (flagged reauth, or a live 401 read) takes priority — the
    // App permissions are fine; the fix is a re-mint (on whichever machine).
    const authFailed = status.needsReauth || status.error === 'unauthenticated';
    if (authFailed) return { view: 'reconnect', scope };
    if (!status.connected) return { view: 'connect', scope };
    // Connected & authed → the feed, minus any capabilities the App can't grant.
    // Remote gates on the HOST's missing set; local on the client's own caps
    // (unchanged: an unconnected client caps snapshot leaves the gate inert).
    const gatedCaps = remote
        ? IW_CAPABILITY_KEYS.filter((k) => (status.missingCapabilities ?? []).includes(k))
        : localCaps.connected
          ? IW_CAPABILITY_KEYS.filter((k) => localCaps.missing.includes(k))
          : [];
    return { view: 'feed', gatedCaps };
}
