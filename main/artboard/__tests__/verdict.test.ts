import { describe, expect, it } from 'vitest';
import { applyVerdict, verdictMessage, type BoardPost } from '../board';

/**
 * THE REVIEW LOOP — the half that makes this a review tool rather than a gallery.
 *
 * The owner's choice: "approve / reject, and the agent hears it", with optional
 * comments. That second half is the point. An agent that has posted a mockup is
 * BLOCKED: without a verdict reaching it, the board is a place where work goes
 * to be looked at and nothing happens, and the agent is back to guessing or
 * interrupting with a modal that describes the mockup in words.
 *
 * A verdict is recorded on the POST (so the board shows its own history) and
 * delivered as a MESSAGE (so the agent hears it without polling). Both, not one:
 * a verdict only on the post is invisible to the agent, and a verdict only in a
 * message leaves the board unable to say what was already decided.
 */
const post = (over: Partial<BoardPost> = {}): BoardPost => ({
    id: 'p1',
    title: 'Login screen',
    kind: 'html',
    file: 'p1.html',
    createdAt: '2026-08-26T10:00:00.000Z',
    ...over,
});

describe('applyVerdict', () => {
    it('records the verdict and the comment on the post', () => {
        const got = applyVerdict([post()], 'p1', {
            verdict: 'approved',
            comment: 'ship it',
            at: '2026-08-26T12:00:00.000Z',
        });

        expect(got[0]!.review).toEqual({
            verdict: 'approved',
            comment: 'ship it',
            at: '2026-08-26T12:00:00.000Z',
        });
    });

    it('accepts a verdict with NO comment — the comment is optional', () => {
        const got = applyVerdict([post()], 'p1', {
            verdict: 'rejected',
            at: '2026-08-26T12:00:00.000Z',
        });

        expect(got[0]!.review?.verdict).toBe('rejected');
        expect(got[0]!.review?.comment).toBeUndefined();
    });

    it('leaves other posts alone', () => {
        // Positive control: without this, "the verdict landed" would pass against
        // an implementation that stamped every post on the board.
        const got = applyVerdict([post(), post({ id: 'p2' })], 'p1', {
            verdict: 'approved',
            at: '2026-08-26T12:00:00.000Z',
        });

        expect(got.find((p) => p.id === 'p2')!.review).toBeUndefined();
    });

    it('is a no-op for a post that is not on the board', () => {
        const board = [post()];

        expect(applyVerdict(board, 'gone', { verdict: 'approved', at: 'now' })).toEqual(board);
    });

    it('REPLACES an earlier verdict, because a reviewer may change their mind', () => {
        // Not appended: the board answers "what was decided", and two verdicts on
        // one post cannot answer it.
        const once = applyVerdict([post()], 'p1', { verdict: 'rejected', at: 't1' });
        const twice = applyVerdict(once, 'p1', { verdict: 'approved', comment: 'fixed', at: 't2' });

        expect(twice[0]!.review).toEqual({ verdict: 'approved', comment: 'fixed', at: 't2' });
    });
});

describe('verdictMessage', () => {
    it('names the post, the verdict AND the comment', () => {
        const text = verdictMessage(post(), { verdict: 'rejected', comment: 'nav is wrong', at: 't' });

        expect(text).toContain('Login screen');
        expect(text.toLowerCase()).toContain('rejected');
        expect(text).toContain('nav is wrong');
    });

    it('says plainly that there was no comment, rather than trailing off', () => {
        // An approval with no note is the common case. "Approved." followed by
        // nothing reads as truncated; saying no comment was left is a fact.
        const text = verdictMessage(post(), { verdict: 'approved', at: 't' });

        expect(text).toContain('Login screen');
        expect(text.toLowerCase()).toContain('approved');
        expect(text.toLowerCase()).toContain('no comment');
    });

    it('tells a REJECTED agent what to do next, since that is the blocking case', () => {
        // An agent reading "rejected" and nothing else will either guess at the
        // fix or ask — both of which the board exists to prevent.
        const text = verdictMessage(post(), { verdict: 'rejected', at: 't' });

        expect(text.toLowerCase()).toMatch(/revise|post again|update/);
    });
});
