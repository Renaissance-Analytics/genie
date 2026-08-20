import { describe, expect, it } from 'vitest';
import { questionBadgeCount } from '../question-badge';

/**
 * The number on the top-bar Questions icon (genie#60).
 *
 * Two things were wrong with it. The visible one: it badged the number of
 * WORKSPACES with pending questions, so three questions from one workspace showed
 * "1" — which answers a question nobody asks. `pendingCount` in `ask/inbox.ts` is
 * even documented as "the number for the top-bar badge" and returns the total; the
 * badge simply was not wired to it.
 *
 * The invisible one: every source was optional-chained, so a payload without a
 * count, or a bridge that never attached, left the badge sitting at a silent zero
 * forever — indistinguishable from "no questions", which is exactly the state the
 * user reported while the flyout showed three.
 *
 * So this resolves a count from whatever arrived, and says when it could not — the
 * caller re-fetches on `null` instead of rendering a zero it did not earn.
 */

describe('reading the count off a push payload', () => {
    it('uses the total number of QUESTIONS, not the workspace count', () => {
        // Three questions in one workspace is a badge of 3. The user is asking
        // "how many things are waiting for me", not "how many rooms are they in".
        expect(questionBadgeCount({ count: 3, workspaces: 1 })).toBe(3);
    });

    it('takes zero at face value — that is a real answer', () => {
        expect(questionBadgeCount({ count: 0, workspaces: 0 })).toBe(0);
    });
});

describe('a payload it cannot read', () => {
    it('returns null so the caller FETCHES, rather than showing a zero', () => {
        // The bug this exists to close. Several emitters send `questions:changed`
        // with no payload at all, and treating that as "none" is how a badge gets
        // stuck empty while the panel behind it lists three.
        for (const payload of [undefined, null, {}, { workspaces: 2 }, 'nope', 7]) {
            expect(questionBadgeCount(payload as never), JSON.stringify(payload)).toBeNull();
        }
    });

    it('ignores a count that is not a real number', () => {
        for (const count of [NaN, -1, '3', null]) {
            expect(questionBadgeCount({ count } as never), String(count)).toBeNull();
        }
    });
});

describe('reading the count off a fetched list', () => {
    it('prefers the list’s own count', () => {
        expect(questionBadgeCount({ count: 3, groups: [{ count: 3 }] })).toBe(3);
    });

    it('adds up the groups when the list did not carry a total', () => {
        // An older host answers `questions:list` without a `count`. Summing the
        // groups is right where counting them is not.
        expect(questionBadgeCount({ groups: [{ count: 2 }, { count: 1 }] })).toBe(3);
    });

    it('is zero for an empty list, which is a real answer too', () => {
        expect(questionBadgeCount({ groups: [] })).toBe(0);
    });

    it('survives groups that carry no count', () => {
        expect(questionBadgeCount({ groups: [{}, { count: 2 }] } as never)).toBe(2);
    });
});
