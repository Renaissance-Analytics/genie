import { describe, expect, it } from 'vitest';
import { toIssueWatchDelta } from '../pusher-protocol';

/**
 * The open issues' TITLES arrive with the IssueWatch delta (`feedbackItems`).
 *
 * Tynn now sends, beside `counts.feedback`, the most recently moved open issues —
 * key, number, title, source, link and dates. `toIssueWatchDelta` rebuilds the
 * delta field by field, so a field it does not name is dropped HERE with no error:
 * the server keeps sending titles and the panel keeps saying "N pieces of
 * feedback". That is exactly how the bucket itself was once lost, so the field is
 * pinned the same way.
 *
 * Each item's link is later handed to the system browser, so only an http(s) URL
 * is accepted — a payload is Tynn's, but a coercion is where a bad value stops.
 */

const item = (over: Record<string, unknown> = {}) => ({
    key: 'tynn-issue:01',
    number: 12,
    title: 'The billing screen loses my filter',
    source: 'feedback',
    url: 'https://tynn.ai/p/PRJ/issues?issue=01',
    createdAt: '2026-09-01T10:00:00+00:00',
    updatedAt: '2026-09-02T10:00:00+00:00',
    ...over,
});

describe('toIssueWatchDelta — feedbackItems', () => {
    it('carries the titled issues through', () => {
        const delta = toIssueWatchDelta({ workspaceId: 'p1', counts: { feedback: 1 }, feedbackItems: [item()] });
        expect(delta!.feedbackItems).toEqual([item()]);
    });

    it('reads an older Tynn that sends no titles as an empty list, not undefined', () => {
        expect(toIssueWatchDelta({ workspaceId: 'p1', counts: { feedback: 3 } })!.feedbackItems).toEqual([]);
    });

    it('drops an entry it cannot show or open, and keeps the rest', () => {
        const delta = toIssueWatchDelta({
            workspaceId: 'p1',
            feedbackItems: [
                item({ key: 'good' }),
                item({ title: '' }),
                item({ key: 42 }),
                'not an object',
                item({ url: undefined }),
                null,
            ],
        });
        expect(delta!.feedbackItems.map((i) => i.key)).toEqual(['good']);
    });

    it('refuses a link that is not http(s), since it is opened in the system browser', () => {
        const delta = toIssueWatchDelta({
            workspaceId: 'p1',
            feedbackItems: [item({ key: 'js', url: 'javascript:alert(1)' }), item({ key: 'file', url: 'file:///etc/passwd' }), item({ key: 'ok' })],
        });
        expect(delta!.feedbackItems.map((i) => i.key)).toEqual(['ok']);
    });

    it('keeps an item whose optional fields are missing, rather than dropping it', () => {
        const delta = toIssueWatchDelta({
            workspaceId: 'p1',
            feedbackItems: [{ key: 'k', title: 'Just a title', url: 'https://tynn.ai/x' }],
        });
        expect(delta!.feedbackItems).toEqual([
            { key: 'k', number: null, title: 'Just a title', source: null, url: 'https://tynn.ai/x', createdAt: null, updatedAt: null },
        ]);
    });
});
