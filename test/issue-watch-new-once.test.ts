import { describe, expect, it } from 'vitest';
import { IssueWatchFeed, parseIssueWatchEntry, type IwEvent } from '../src/core/issue-watch.js';

/**
 * AN ITEM IS ANNOUNCED AS NEW ONCE (genie#1531; fancy: "a real new client report would look just like these"). Each repeat
 * wakes an agent for a turn.
 *
 * `feedbackItems` IS A WINDOW, NOT THE LIST: Tynn sends the 10 most recently moved open issues (IssueWatchService::
 * FEEDBACK_ITEMS_LIMIT), with the whole number in `counts.feedback`. Measured on the tynn project, 2026-11-04: over 30 open
 * issues, many sharing one `updated_at` second from a bulk touch, so which 10 are sent changes with nothing changing on any
 * of them. The shapes below are what feedbackItemsFor sends, with those issue numbers and times.
 */
const issue = (number: number, createdAt: string, updatedAt: string = createdAt) => ({
    key: `tynn-issue:01m6${number}`, number, title: `Report ${number}`, source: 'mcp',
    url: `https://tynn.ai/p/w1/issues?issue=01m6${number}`, createdAt, updatedAt,
});
const entry = (feedbackItems: unknown[], total: number, items: unknown[] = []) => parseIssueWatchEntry({
    workspaceId: 'w1', projectId: 'w1', counts: { issue: 0, pr: 0, security: 0, feedback: total }, items, feedbackItems, tracking: { tracked: true },
})!;
const kinds = (events: readonly IwEvent[]) => events.map((e) => (e.item ? `${e.kind} #${e.item.number}` : `${e.kind} ${e.count}`));

const TOUCHED = '2026-11-04T16:42:51+00:00';
const i633 = issue(633, '2026-11-04T05:42:39+00:00', TOUCHED);
const i632 = issue(632, '2026-11-04T05:27:11+00:00', TOUCHED);
const i623 = issue(623, '2026-11-03T20:17:32+00:00', TOUCHED);
const i622 = issue(622, '2026-11-03T20:17:31+00:00', TOUCHED);
const i606 = issue(606, '2026-11-01T10:00:00+00:00', '2026-11-03T12:00:00+00:00');
const i601 = issue(601, '2026-10-31T10:00:00+00:00', '2026-11-03T11:00:00+00:00');
const OPEN = 34;

describe('a window that rolls', () => {
    it('an issue going out and coming back is never new, however many times (COUNTED)', () => {
        const feed = new IssueWatchFeed();
        expect(feed.apply(entry([i633, i632, i623], OPEN))).toEqual([]);
        for (let round = 0; round < 3; round += 1) {
            expect(kinds(feed.apply(entry([i633, i622, i623], OPEN)))).toEqual([]);
            expect(kinds(feed.apply(entry([i632, i622, i606], OPEN)))).toEqual([]);
            expect(kinds(feed.apply(entry([i633, i632, i623], OPEN)))).toEqual([]);
        }
    });

    it('a new report is told once: when it arrives, not again when it leaves and comes back', () => {
        const feed = new IssueWatchFeed();
        feed.apply(entry([i633, i632], OPEN));
        const fresh = issue(636, '2026-11-04T17:00:00+00:00');
        expect(kinds(feed.apply(entry([fresh, i633], OPEN + 1)))).toEqual(['feedback.new #636']);
        expect(kinds(feed.apply(entry([i633, i632], OPEN + 1)))).toEqual([]);
        expect(kinds(feed.apply(entry([fresh, i633], OPEN + 1)))).toEqual([]);
    });

    it('a report that only reaches the window later, because others moved first, is still told, once', () => {
        const feed = new IssueWatchFeed();
        feed.apply(entry([i633, i632], OPEN));
        const later = issue(637, '2026-11-04T17:00:00+00:00', '2026-11-04T17:30:00+00:00');
        const moved = issue(601, i601.createdAt, '2026-11-04T17:20:00+00:00');
        expect(kinds(feed.apply(entry([moved, i633], OPEN + 1)))).toEqual([]);
        expect(kinds(feed.apply(entry([later, moved], OPEN + 1)))).toEqual(['feedback.new #637']);
        expect(kinds(feed.apply(entry([later, moved], OPEN + 1)))).toEqual([]);
    });
});

describe('a restart', () => {
    it('the first entry is a baseline; an issue from before the restart entering the window later is not new', () => {
        const feed = new IssueWatchFeed();
        expect(feed.apply(entry([i633, i632], OPEN))).toEqual([]);
        expect(kinds(feed.apply(entry([i623, i606, i601], OPEN)))).toEqual([]);
    });

    it('an issue from before the restart, newer than everything in the first window, is still not new', () => {
        const feed = new IssueWatchFeed();
        feed.apply(entry([issue(600, '2026-10-30T10:00:00+00:00', TOUCHED)], OPEN));
        expect(kinds(feed.apply(entry([i633], OPEN)))).toEqual([]);
    });

    it('POSITIVE CONTROL: a report created after the restart is new, in the same second as the first window too', () => {
        const feed = new IssueWatchFeed();
        feed.apply(entry([i633], OPEN));
        expect(kinds(feed.apply(entry([issue(640, TOUCHED)], OPEN + 1)))).toEqual(['feedback.new #640']);
        expect(kinds(feed.apply(entry([issue(641, '2026-11-04T18:00:00+00:00')], OPEN + 2)))).toEqual(['feedback.new #641']);
    });

    it('a report with no time from Tynn cannot be ruled out: it is told, once', () => {
        const feed = new IssueWatchFeed();
        feed.apply(entry([i633], OPEN));
        const untimed = { ...issue(642, TOUCHED), createdAt: null, updatedAt: null };
        expect(kinds(feed.apply(entry([untimed], OPEN + 1)))).toEqual(['feedback.new #642']);
        expect(kinds(feed.apply(entry([i633], OPEN + 1)))).toEqual([]);
        expect(kinds(feed.apply(entry([untimed], OPEN + 1)))).toEqual([]);
    });

    it('a first window with no issues rules nothing out', () => {
        const feed = new IssueWatchFeed();
        feed.apply(entry([], 0));
        expect(kinds(feed.apply(entry([i601], 1)))).toEqual(['feedback.new #601']);
    });
});

describe('closed', () => {
    it('leaving a partial window is not closing: nothing can be said of an issue outside it', () => {
        const feed = new IssueWatchFeed();
        feed.apply(entry([i633, i632, i623], OPEN));
        expect(kinds(feed.apply(entry([i633, i622], OPEN)))).toEqual([]);
    });

    it('POSITIVE CONTROL: when the window holds every open issue, one gone IS closed', () => {
        const feed = new IssueWatchFeed();
        feed.apply(entry([i633, i632, i623], 3));
        expect(kinds(feed.apply(entry([i633, i632], 2)))).toEqual(['closed 1']);
    });

    it('a list that shrinks to whole: what left the last window is closed', () => {
        const feed = new IssueWatchFeed();
        feed.apply(entry([i633, i632, i623], 11));
        expect(kinds(feed.apply(entry([i633, i632], 2)))).toEqual(['closed 1']);
    });
});

describe('CONTROL: GitHub items are a whole list, and keep their rules', () => {
    const gh = (key: string, number: number, updatedAt: string) => ({ kind: 'issue', key, number, title: 't', url: 'u', createdAt: updatedAt, updatedAt, author: 'octo', severity: null, owner: 'acme', repo: 'app', source: 'github', unread: true });

    it('new, moved and closed, beside a rolling feedback window', () => {
        const feed = new IssueWatchFeed();
        const a = gh('acme/app:issue:1', 1, '2026-11-04T10:00:00Z');
        const b = gh('acme/app:issue:2', 2, '2026-11-04T10:00:00Z');
        feed.apply(entry([i633], OPEN, [a, b]));
        const moved = { ...a, updatedAt: '2026-11-04T11:00:00Z' };
        const c = gh('acme/app:issue:3', 3, '2026-11-04T09:00:00Z');
        expect(kinds(feed.apply(entry([i632], OPEN, [moved, c])))).toEqual(['issue.updated #1', 'issue.new #3', 'closed 1']);
    });
});
