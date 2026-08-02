import { describe, expect, it } from 'vitest';
import { feedItemByline, relativeAge } from '../issuewatch';
import type { WatchFeedItem } from '../genie';

/**
 * An Issue Watch row showed a title, a repo and a number — never WHO raised the
 * thing or WHEN. Both are what decide whether a row is worth opening: an issue
 * opened by a stranger an hour ago and one you filed six months ago read
 * identically without them.
 *
 * The byline is a pure function so it can be pinned here rather than asserted
 * through a rendered component, matching how the badge/feed consistency helpers
 * in this module are tested.
 */
function item(overrides: Partial<WatchFeedItem> = {}): WatchFeedItem {
    return {
        kind: 'issue',
        key: 'o/r:issue:1',
        number: 1,
        title: 'A bug',
        url: 'https://github.com/o/r/issues/1',
        createdAt: '2026-07-01T10:00:00+00:00',
        updatedAt: '2026-07-09T00:00:00+00:00',
        author: 'alice',
        owner: 'o',
        repo: 'r',
        source: 'own',
        unread: false,
        ...overrides,
    };
}

const NOW = new Date('2026-07-09T12:00:00Z').getTime();

describe('relativeAge', () => {
    it('reads in the largest unit that stays honest', () => {
        expect(relativeAge('2026-07-09T11:59:30+00:00', NOW)).toBe('just now');
        expect(relativeAge('2026-07-09T09:00:00+00:00', NOW)).toBe('3h ago');
        expect(relativeAge('2026-07-01T12:00:00+00:00', NOW)).toBe('8d ago');
    });

    it('is empty for a missing date rather than printing a fake one', () => {
        // Rows polled before Tynn stored the opened date carry no createdAt.
        expect(relativeAge(undefined, NOW)).toBe('');
        expect(relativeAge('not-a-date', NOW)).toBe('');
    });
});

describe('feedItemByline', () => {
    it('names who opened it and how long ago', () => {
        expect(feedItemByline(item(), NOW)).toBe('alice · opened 8d ago');
    });

    it('falls back to the updated date when the opened date is unknown', () => {
        // Pre-existing cached rows have only updatedAt — say when it last MOVED
        // rather than saying nothing, and never label it "opened".
        expect(feedItemByline(item({ createdAt: undefined }), NOW)).toBe(
            'alice · updated 12h ago',
        );
    });

    it('omits the author for a security alert instead of inventing one', () => {
        // GitHub reports no `user` on an alert; Tynn sends null through.
        expect(feedItemByline(item({ kind: 'dependabot', author: undefined }), NOW)).toBe(
            'opened 8d ago',
        );
    });

    it('is empty when neither fact is known, so the row renders no stray separator', () => {
        expect(
            feedItemByline(item({ author: undefined, createdAt: undefined, updatedAt: '' }), NOW),
        ).toBe('');
    });
});
