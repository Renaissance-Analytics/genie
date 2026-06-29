import type { WatchFeedItem, WatchRepoView } from './genie';

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
