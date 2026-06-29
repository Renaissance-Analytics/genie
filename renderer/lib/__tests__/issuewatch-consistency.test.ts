import { describe, expect, it } from 'vitest';
import { feedItemBelongsToRepo, openCountForRepo } from '../issuewatch';
import type { WatchFeedItem, WatchRepoView } from '../genie';

/**
 * The repo-list count badge and the Activity feed MUST always agree about
 * whether a repo has an open item. The badge is now derived from the SAME feed
 * the Activity list renders (openCountForRepo), so it CAN'T contradict the feed:
 *   - badge=1 over an empty feed  → impossible (badge is a count of feed items);
 *   - badge=0 over a feed listing the item (the old mark-seen bug) → impossible
 *     (presence, not seen-based unread).
 * These tests pin that invariant on the exact scenarios from the bug report.
 */

const feedItem = (
    over: Partial<WatchFeedItem> & Pick<WatchFeedItem, 'owner' | 'repo'>,
): WatchFeedItem => ({
    kind: 'issue',
    key: `${over.owner}/${over.repo}:issue:${over.number ?? 1}:${over.source ?? 'own'}`,
    number: 1,
    title: 'an item',
    url: 'https://github.com/x/y/issues/1',
    updatedAt: '2026-06-20T10:00:00.000Z',
    source: 'own',
    unread: false,
    ...over,
});

const repo = (over: Partial<WatchRepoView> & Pick<WatchRepoView, 'owner' | 'repo'>): WatchRepoView => ({
    enabled: true,
    unread: 0,
    error: null,
    detail: null,
    upstream: null,
    ...over,
});

describe('openCountForRepo — badge ↔ feed consistency', () => {
    it('badge equals the number of feed items for that repo (the bug scenario)', () => {
        const r = repo({ owner: 'Particle-Academy', repo: 'fancy-term-host' });
        const feed = [
            feedItem({ owner: 'Particle-Academy', repo: 'fancy-term-host', number: 3 }),
        ];
        // Feed lists the issue → badge MUST be 1 (no "1 badge over empty feed").
        expect(openCountForRepo(feed, r)).toBe(1);
        expect(feed.length).toBeGreaterThan(0); // → not "Nothing open"
    });

    it('badge stays 1 after the item is marked seen (presence, not unread)', () => {
        // The reopen bug: mark-seen flipped unread→false and zeroed the old badge,
        // yet the feed still listed the OPEN item. Presence-based badge stays 1.
        const r = repo({ owner: 'Particle-Academy', repo: 'fancy-term-host' });
        const seenFeed = [
            feedItem({ owner: 'Particle-Academy', repo: 'fancy-term-host', unread: false }),
        ];
        expect(openCountForRepo(seenFeed, r)).toBe(1);
    });

    it('badge is 0 exactly when the feed has no item for the repo', () => {
        const r = repo({ owner: 'Particle-Academy', repo: 'fancy-term-host' });
        expect(openCountForRepo([], r)).toBe(0);
        // An item for a DIFFERENT repo must not leak into this repo's badge.
        const other = [feedItem({ owner: 'Particle-Academy', repo: 'fancy-code' })];
        expect(openCountForRepo(other, r)).toBe(0);
    });

    it('attributes an upstream item to the fork row whose upstream matches', () => {
        const fork = repo({
            owner: 'wishborn',
            repo: 'fancy-term-host',
            upstream: { owner: 'Particle-Academy', repo: 'fancy-term-host' },
        });
        const upstreamItem = feedItem({
            owner: 'Particle-Academy',
            repo: 'fancy-term-host',
            source: 'upstream',
            number: 9,
        });
        expect(feedItemBelongsToRepo(upstreamItem, fork)).toBe(true);
        expect(openCountForRepo([upstreamItem], fork)).toBe(1);

        // A non-fork row (no upstream) must NOT claim the upstream item.
        const plain = repo({ owner: 'Particle-Academy', repo: 'fancy-term-host' });
        expect(feedItemBelongsToRepo(upstreamItem, plain)).toBe(false);
    });

    it('every feed item is attributed to exactly one repo (sum of badges === feed length)', () => {
        const repos: WatchRepoView[] = [
            repo({ owner: 'Particle-Academy', repo: 'fancy-term-host' }),
            repo({ owner: 'Particle-Academy', repo: 'fancy-code' }),
            repo({
                owner: 'wishborn',
                repo: 'fork',
                upstream: { owner: 'Particle-Academy', repo: 'upstreamed' },
            }),
        ];
        const feed: WatchFeedItem[] = [
            feedItem({ owner: 'Particle-Academy', repo: 'fancy-term-host', number: 3 }),
            feedItem({ owner: 'Particle-Academy', repo: 'fancy-term-host', kind: 'pr', number: 4 }),
            feedItem({ owner: 'Particle-Academy', repo: 'fancy-code', number: 1 }),
            feedItem({ owner: 'wishborn', repo: 'fork', number: 2 }),
            feedItem({
                owner: 'Particle-Academy',
                repo: 'upstreamed',
                source: 'upstream',
                number: 8,
            }),
        ];
        const total = repos.reduce((n, r) => n + openCountForRepo(feed, r), 0);
        expect(total).toBe(feed.length);
        // And the empty-feed ⟺ all-badges-zero equivalence holds.
        const emptyTotal = repos.reduce((n, r) => n + openCountForRepo([], r), 0);
        expect(emptyTotal).toBe(0);
    });
});
