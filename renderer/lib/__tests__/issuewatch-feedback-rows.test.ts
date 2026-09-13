import { describe, expect, it } from 'vitest';
import { feedbackRows, type TynnFeedbackItem } from '../issuewatch';

/**
 * The IssueWatch panel's feedback block: the open issues BY NAME, not a number.
 *
 * The owner: "Issue titles are supposed to be piped in with the IssueWatch stream,
 * not just a thing saying I have x amount of feedbacks." Tynn now sends the most
 * recently moved open issues (bounded) beside the full count. This is what the
 * panel makes of the two: a row per titled issue, and an honest "N more" for the
 * rest, so a bounded list never reads as the whole queue.
 */

const item = (over: Partial<TynnFeedbackItem> = {}): TynnFeedbackItem => ({
    key: 'tynn-issue:01',
    number: 12,
    title: 'The billing screen loses my filter',
    source: 'feedback',
    url: 'https://tynn.ai/p/PRJ/issues?issue=01',
    createdAt: '2026-09-01T10:00:00+00:00',
    updatedAt: '2026-09-02T10:00:00+00:00',
    ...over,
});

describe('feedbackRows', () => {
    it('names each issue by number and title, with where it came from', () => {
        const view = feedbackRows([item()], 1);
        expect(view.rows).toEqual([
            {
                key: 'tynn-issue:01',
                number: '#12',
                title: 'The billing screen loses my filter',
                origin: 'Feedback',
                url: 'https://tynn.ai/p/PRJ/issues?issue=01',
                updatedAt: '2026-09-02T10:00:00+00:00',
            },
        ]);
        expect(view.more).toBe(0);
    });

    it('says how many more wait in Tynn beyond the ones listed', () => {
        const view = feedbackRows([item({ key: 'a' }), item({ key: 'b' })], 14);
        expect(view.rows).toHaveLength(2);
        expect(view.more).toBe(12);
    });

    it('never reports a negative remainder when the count lags the list', () => {
        // The count and the list arrive together, but a stale count must not
        // produce "-1 more".
        expect(feedbackRows([item({ key: 'a' }), item({ key: 'b' })], 1).more).toBe(0);
    });

    it('names every origin Tynn records, and leaves an unknown one unlabelled', () => {
        const origins = ['feedback', 'wish', 'issue', 'github', 'something-new', null].map(
            (source) => feedbackRows([item({ source })], 1).rows[0]!.origin,
        );
        expect(origins).toEqual(['Feedback', 'Wish', 'Issue', 'GitHub', null, null]);
    });

    it('omits the number rather than printing "#null"', () => {
        expect(feedbackRows([item({ number: null })], 1).rows[0]!.number).toBeNull();
    });

    it('has nothing to list, and nothing more, for a workspace with no open issues', () => {
        expect(feedbackRows([], 0)).toEqual({ rows: [], more: 0 });
    });

    it('still reports the waiting count when a Tynn too old to send titles sent none', () => {
        expect(feedbackRows([], 5)).toEqual({ rows: [], more: 5 });
    });
});
