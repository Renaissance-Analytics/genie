import { describe, expect, it } from 'vitest';
import { clockAmPm, shortDateTime } from '../src/core/clock-words.js';
import { limitWords } from '../src/core/limit-words.js';

/**
 * A WEEK IS NOT TWO MINUTES (Tynn #1089). A held agent's line said "rate limit · resumes 7:15 PM" for a weekly limit that
 * resets six days later: the time of day alone reads as today, minutes away. A resume on another day says the day.
 */

const NOW = new Date(2026, 10, 27, 19, 13).getTime();
const paused = (resumeAtMs: number) => ({ state: 'paused' as const, window: 'seven_day', resetsAtMs: resumeAtMs - 120_000, resumeAtMs, message: null });

describe('the held line says WHEN it resumes, with the day when it is not today', () => {
    it('six days away: the day and the time', () => {
        const at = new Date(2026, 11, 3, 19, 15).getTime();
        expect(limitWords(paused(at), NOW)).toBe(`rate limit · resumes ${shortDateTime(at)}`);
    });

    it('CONTROL: later today, the time alone, as before', () => {
        const at = new Date(2026, 10, 27, 21, 0).getTime();
        expect(limitWords(paused(at), NOW)).toBe(`rate limit · resumes ${clockAmPm(at)}`);
    });

    it('a retry tomorrow says the day too', () => {
        const at = new Date(2026, 10, 28, 1, 0).getTime();
        expect(limitWords({ state: 'retrying', nextTryAtMs: at, attempt: 1, message: null }, NOW)).toBe(`rate limit · next try ${shortDateTime(at)}`);
    });
});

describe('the Agent view\'s pill says the day too', () => {
    it('a weekly hold: "Paused · rate limit · resumes <day>, <time>"', async () => {
        const { statePill } = await import('../src/core/agent-view.js');
        const at = new Date(2026, 11, 3, 19, 15).getTime();
        const session = { running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, limit: paused(at) } as never;
        expect(statePill(session, () => NOW).word).toBe(`Paused · rate limit · resumes ${shortDateTime(at)}`);
    });
});
