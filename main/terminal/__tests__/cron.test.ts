import { describe, expect, it } from 'vitest';

import {
    describeCron,
    isValidCron,
    nextFireAfter,
    parseCron,
} from '../cron';

/**
 * The hand-rolled 5-field cron evaluator (min hour day-of-month month
 * day-of-week). No 3rd-party cron dependency — this file IS the contract.
 *
 * Everything is LOCAL time: a scheduled task fires at the wall-clock time the
 * user configured on the Host, so every fixture builds its dates with the local
 * `new Date(y, m, d, …)` constructor (never a UTC/ISO string, which would drift
 * the assertions by the runner's offset).
 */

/** Local-time date literal — month is 1-based here for readable fixtures. */
function local(y: number, mo: number, d: number, h = 0, mi = 0): Date {
    return new Date(y, mo - 1, d, h, mi, 0, 0);
}

describe('parseCron / isValidCron', () => {
    it('accepts the standard shapes', () => {
        for (const expr of [
            '* * * * *',
            '*/5 * * * *',
            '0 9 * * *',
            '30 2 1 * *',
            '0 0 * * 0',
            '15,45 * * * *',
            '0 9-17 * * 1-5',
            '0 */2 * * *',
            '0 0 1 1 *',
            '5 4 * * 7', // 7 is Sunday too
        ]) {
            expect(isValidCron(expr), expr).toBe(true);
            expect(parseCron(expr), expr).not.toBeNull();
        }
    });

    it('rejects malformed expressions', () => {
        for (const expr of [
            '',
            '   ',
            '* * * *', // 4 fields
            '* * * * * *', // 6 fields
            '60 * * * *', // minute out of range
            '* 24 * * *', // hour out of range
            '* * 0 * *', // day-of-month is 1-based
            '* * 32 * *',
            '* * * 13 *',
            '* * * * 8',
            'x * * * *',
            '*/0 * * * *', // zero step
            '*/-1 * * * *',
            '5-1 * * * *', // inverted range
            '1,,2 * * * *',
        ]) {
            expect(isValidCron(expr), expr).toBe(false);
            expect(parseCron(expr), expr).toBeNull();
        }
    });

    it('expands *, steps, ranges and lists into the matching value sets', () => {
        const p = parseCron('0,30 */6 * * *');
        expect(p).not.toBeNull();
        expect([...p!.minutes]).toEqual([0, 30]);
        expect([...p!.hours]).toEqual([0, 6, 12, 18]);
        expect(p!.domRestricted).toBe(false);
        expect(p!.dowRestricted).toBe(false);

        const r = parseCron('0 9 * * 1-5');
        expect([...r!.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
        expect(r!.dowRestricted).toBe(true);

        // 7 normalizes onto 0 (Sunday) rather than sitting outside the week.
        expect([...parseCron('0 0 * * 7')!.daysOfWeek]).toEqual([0]);
    });
});

describe('nextFireAfter — invalid input', () => {
    it('returns null for an unparseable expression', () => {
        expect(nextFireAfter('not a cron', local(2026, 7, 24, 10, 0))).toBeNull();
        expect(nextFireAfter('* * * *', local(2026, 7, 24, 10, 0))).toBeNull();
    });

    it('returns null for a date that can never occur (Feb 30)', () => {
        expect(nextFireAfter('0 0 30 2 *', local(2026, 7, 24, 10, 0))).toBeNull();
    });
});

describe('nextFireAfter — every minute', () => {
    it('advances to the NEXT minute, never returns `from` itself', () => {
        const from = local(2026, 7, 24, 10, 15);
        expect(nextFireAfter('* * * * *', from)).toEqual(local(2026, 7, 24, 10, 16));
    });

    it('ignores the seconds of `from` (fires on the next whole minute)', () => {
        const from = new Date(2026, 6, 24, 10, 15, 42, 500);
        expect(nextFireAfter('* * * * *', from)).toEqual(local(2026, 7, 24, 10, 16));
    });
});

describe('nextFireAfter — specific time daily', () => {
    it('finds today when the time is still ahead', () => {
        expect(nextFireAfter('30 9 * * *', local(2026, 7, 24, 8, 0))).toEqual(
            local(2026, 7, 24, 9, 30),
        );
    });

    it('rolls to tomorrow once the time has passed', () => {
        expect(nextFireAfter('30 9 * * *', local(2026, 7, 24, 9, 30))).toEqual(
            local(2026, 7, 25, 9, 30),
        );
    });
});

describe('nextFireAfter — steps, ranges and lists', () => {
    it('step: */15 lands on the next quarter hour', () => {
        expect(nextFireAfter('*/15 * * * *', local(2026, 7, 24, 10, 16))).toEqual(
            local(2026, 7, 24, 10, 30),
        );
        // …and wraps into the next hour past the last step of this one.
        expect(nextFireAfter('*/15 * * * *', local(2026, 7, 24, 10, 46))).toEqual(
            local(2026, 7, 24, 11, 0),
        );
    });

    it('range: business hours only', () => {
        // 18:00 is past the 9-17 window → tomorrow 09:00.
        expect(nextFireAfter('0 9-17 * * *', local(2026, 7, 24, 18, 5))).toEqual(
            local(2026, 7, 25, 9, 0),
        );
        expect(nextFireAfter('0 9-17 * * *', local(2026, 7, 24, 12, 30))).toEqual(
            local(2026, 7, 24, 13, 0),
        );
    });

    it('list: picks the next listed minute', () => {
        expect(nextFireAfter('0,15,45 * * * *', local(2026, 7, 24, 10, 20))).toEqual(
            local(2026, 7, 24, 10, 45),
        );
    });

    it('combination: list of ranges with a step', () => {
        // 2026-07-24 is a Friday; 1-5/2 = Mon, Wed, Fri.
        expect(nextFireAfter('0 8 * * 1-5/2', local(2026, 7, 24, 9, 0))).toEqual(
            local(2026, 7, 27, 8, 0), // Monday
        );
    });
});

describe('nextFireAfter — day-of-week', () => {
    it('finds the next Monday', () => {
        // 2026-07-24 is a Friday.
        expect(nextFireAfter('0 6 * * 1', local(2026, 7, 24, 12, 0))).toEqual(
            local(2026, 7, 27, 6, 0),
        );
    });

    it('accepts 7 as Sunday', () => {
        expect(nextFireAfter('0 6 * * 7', local(2026, 7, 24, 12, 0))).toEqual(
            local(2026, 7, 26, 6, 0),
        );
    });

    it('when BOTH day-of-month and day-of-week are restricted the match is a UNION (standard cron)', () => {
        // "0 0 1 * 1" = the 1st of the month OR any Monday, whichever comes first.
        // From Fri 2026-07-24 the next Monday (07-27) beats the 1st (08-01).
        expect(nextFireAfter('0 0 1 * 1', local(2026, 7, 24, 12, 0))).toEqual(
            local(2026, 7, 27, 0, 0),
        );
        // From Mon 2026-07-27 00:00 the next hit is the following Monday? No —
        // the 1st of August (Saturday) comes first.
        expect(nextFireAfter('0 0 1 * 1', local(2026, 7, 27, 0, 0))).toEqual(
            local(2026, 8, 1, 0, 0),
        );
    });
});

describe('nextFireAfter — boundary crossings', () => {
    it('crosses midnight', () => {
        expect(nextFireAfter('5 0 * * *', local(2026, 7, 24, 23, 59))).toEqual(
            local(2026, 7, 25, 0, 5),
        );
    });

    it('crosses a month boundary', () => {
        expect(nextFireAfter('0 3 1 * *', local(2026, 7, 24, 12, 0))).toEqual(
            local(2026, 8, 1, 3, 0),
        );
    });

    it('crosses a year boundary', () => {
        expect(nextFireAfter('0 0 1 1 *', local(2026, 7, 24, 12, 0))).toEqual(
            local(2027, 1, 1, 0, 0),
        );
    });

    it('handles the 31st — skipping the months that do not have one', () => {
        // 2026-02 has no 31st; from Jan 31 12:00 the next is March 31.
        expect(nextFireAfter('0 0 31 * *', local(2026, 1, 31, 12, 0))).toEqual(
            local(2026, 3, 31, 0, 0),
        );
    });

    it('finds Feb 29 in a leap year', () => {
        expect(nextFireAfter('0 0 29 2 *', local(2026, 7, 24, 12, 0))).toEqual(
            local(2028, 2, 29, 0, 0),
        );
    });
});

describe('describeCron — human-readable schedule for the UI', () => {
    it('names the common shapes', () => {
        expect(describeCron('* * * * *')).toBe('Every minute');
        expect(describeCron('*/5 * * * *')).toBe('Every 5 minutes');
        expect(describeCron('0 * * * *')).toBe('Hourly, on the hour');
        expect(describeCron('0 9 * * *')).toBe('Daily at 09:00');
        expect(describeCron('30 6 * * 1')).toBe('Weekly on Mon at 06:30');
        expect(describeCron('0 3 1 * *')).toBe('Monthly on day 1 at 03:00');
    });

    it('falls back to the raw expression for anything exotic or invalid', () => {
        expect(describeCron('0 9,17 * * 1-5')).toBe('0 9,17 * * 1-5');
        expect(describeCron('nope')).toBe('nope');
    });
});
