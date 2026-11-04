import { describe, expect, it } from 'vitest';
import { IssueWatchFeed, parseIssueWatchEntry, type IwEvent } from '../src/core/issue-watch.js';

/**
 * AN ITEM IS ANNOUNCED AS NEW ONCE (genie#1531; fancy: "a real new client report would look just like these"). Each repeat
 * wakes an agent for a turn.
 *
 * `feedbackItems` IS A WINDOW, NOT THE LIST: Tynn sends the 10 most recently moved open issues (IssueWatchService::
 * FEEDBACK_ITEMS_LIMIT), with the whole number in `counts.feedback`. Measured on the tynn project, 2026-11-04: over 30 open
 * issues, many sharing one `updated_at` second from a bulk touch, so which 10 are sent changes with nothing changing on any
 * of them. The shapes below are what feedbackItemsFor sends. The times of #633, #632, #623 and #622 are the measured ones;
 * #606 and #601 did not appear in that listing, so theirs are stand-ins of the same age order.
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

/**
 * GITHUB'S LISTS ARE WINDOWS TOO. Tynn's poller reads one page of each stream, `per_page=50` (IssueWatchPoller::STREAMS), and
 * GitHub's `/issues` counts pull requests in that 50 before Tynn filters them out. Measured on Renaissance-Analytics/genie,
 * 2026-11-04: 27 open issues and 29 open PRs, so the page held 21 issues, and the last four were #1359, #1343, #1339 and #1295.
 * A merged PR frees a place and lets the next older issue in: those four were announced as new, unchanged for days.
 * `/pulls` and the three security streams are capped at 50 the same way. Those four issues' times are the real ones.
 */
describe('GitHub lists that roll', () => {
    const REPO = { owner: 'Renaissance-Analytics', repo: 'genie' };
    const gh = (kind: string, number: number, createdAt: string | null, updatedAt: string | null = createdAt) => ({
        kind, key: `Renaissance-Analytics/genie:${kind}:${number}`, number, title: `Item ${number}`, url: `https://github.com/Renaissance-Analytics/genie/issues/${number}`,
        createdAt, updatedAt, author: 'wishborn', severity: null, ...REPO, source: 'own', unread: false,
    });
    const i1535 = gh('issue', 1535, '2026-11-04T14:00:00Z');
    const i1508 = gh('issue', 1508, '2026-11-02T10:00:00Z', '2026-11-03T10:00:00Z');
    const i1359 = gh('issue', 1359, '2026-10-31T00:58:43Z');
    const i1343 = gh('issue', 1343, '2026-10-30T04:07:16Z');
    const i1339 = gh('issue', 1339, '2026-10-29T17:52:34Z');
    const i1295 = gh('issue', 1295, '2026-10-27T20:37:52Z', '2026-10-27T21:06:41Z');
    const AFTER = '2026-11-04T18:00:00Z';

    it('the four from the report: older issues entering the list, unchanged, are not new (COUNTED)', () => {
        const feed = new IssueWatchFeed();
        expect(feed.apply(entry([], 0, [i1535, i1508]))).toEqual([]);
        expect(kinds(feed.apply(entry([], 0, [i1535, i1508, i1359, i1343, i1339, i1295])))).toEqual([]);
    });

    it('an issue going out and coming back, unchanged, is never new (COUNTED)', () => {
        const feed = new IssueWatchFeed();
        feed.apply(entry([], 0, [i1535, i1359]));
        for (let round = 0; round < 3; round += 1) {
            feed.apply(entry([], 0, [i1535]));
            expect(kinds(feed.apply(entry([], 0, [i1535, i1359])))).toEqual([]);
        }
    });

    it('one that moved while it was out, or that was outside the first list and moved since, is a change, not new', () => {
        const feed = new IssueWatchFeed();
        feed.apply(entry([], 0, [i1535, i1359]));
        feed.apply(entry([], 0, [i1535]));
        expect(kinds(feed.apply(entry([], 0, [i1535, { ...i1359, updatedAt: AFTER }])))).toEqual(['issue.updated #1359']);
        expect(kinds(feed.apply(entry([], 0, [i1535, { ...i1359, updatedAt: AFTER }, { ...i1295, updatedAt: AFTER }])))).toEqual(['issue.updated #1295']);
    });

    it('POSITIVE CONTROL: an issue, a PR and an alert created since the first list are new, once, in the same second too', () => {
        const feed = new IssueWatchFeed();
        feed.apply(entry([], 0, [i1535]));
        const fresh = [gh('issue', 1540, AFTER), gh('pr', 1541, AFTER), gh('dependabot', 92, i1535.updatedAt)];
        expect(kinds(feed.apply(entry([], 0, [i1535, ...fresh])))).toEqual(['issue.new #1540', 'pr.new #1541', 'security.new #92']);
        feed.apply(entry([], 0, [i1535]));
        expect(kinds(feed.apply(entry([], 0, [i1535, ...fresh])))).toEqual([]);
    });

    it('PRs and security alerts roll the same way', () => {
        const feed = new IssueWatchFeed();
        feed.apply(entry([], 0, [i1535]));
        const OLD = '2026-10-20T00:00:00Z';
        expect(kinds(feed.apply(entry([], 0, [i1535, gh('pr', 1200, OLD), gh('dependabot', 70, OLD), gh('code-scanning', 5, OLD), gh('secret-scanning', 2, OLD)])))).toEqual([]);
    });

    it('a row from before Tynn kept createdAt is judged by when it last moved; with no time at all it is told, once', () => {
        const feed = new IssueWatchFeed();
        feed.apply(entry([], 0, [i1535]));
        expect(kinds(feed.apply(entry([], 0, [i1535, gh('issue', 1100, null, '2026-10-20T00:00:00Z')])))).toEqual([]);
        expect(kinds(feed.apply(entry([], 0, [i1535, gh('issue', 1101, null, null)])))).toEqual(['issue.new #1101']);
        expect(kinds(feed.apply(entry([], 0, [i1535, gh('issue', 1101, null, null)])))).toEqual([]);
    });

    it('each source has its own baseline: GitHub moving later rules out no Tynn report', () => {
        const feed = new IssueWatchFeed();
        feed.apply(entry([i601], OPEN, [i1535]));
        const report = issue(650, '2026-11-02T00:00:00+00:00');
        expect(kinds(feed.apply(entry([report], OPEN, [i1535])))).toEqual(['feedback.new #650']);
    });
});

describe('CONTROL: GitHub items, new, moved and closed, beside a rolling feedback window', () => {
    const gh = (key: string, number: number, updatedAt: string) => ({ kind: 'issue', key, number, title: 't', url: 'u', createdAt: updatedAt, updatedAt, author: 'octo', severity: null, owner: 'acme', repo: 'app', source: 'github', unread: true });

    it('a gone item is still counted closed: nothing in the entry can tell a close from leaving the page (a named limit)', () => {
        const feed = new IssueWatchFeed();
        const a = gh('acme/app:issue:1', 1, '2026-11-04T10:00:00Z');
        const b = gh('acme/app:issue:2', 2, '2026-11-04T10:00:00Z');
        feed.apply(entry([i633], OPEN, [a, b]));
        const moved = { ...a, updatedAt: '2026-11-04T11:00:00Z' };
        const c = gh('acme/app:issue:3', 3, '2026-11-04T12:00:00Z');
        expect(kinds(feed.apply(entry([i632], OPEN, [moved, c])))).toEqual(['issue.updated #1', 'issue.new #3', 'closed 1']);
    });
});
