import { describe, expect, it } from 'vitest';
import { retry } from '../src/core/retry.js';

/**
 * RETRY — for a download the build cannot do without. A network reset in CI (`fetch failed … read
 * ECONNRESET`, PR #52) failed a packaging job that would have passed a second later. A few attempts
 * with backoff is the honest fix; the LAST error is what surfaces when every attempt fails, and every
 * retry is reported (never silent), so a build that limped through says so in its log.
 */

describe('retry', () => {
    it('returns the first success; retries with doubling waits; reports each retry with the error', async () => {
        const waits: number[] = [];
        const notes: string[] = [];
        let calls = 0;
        const value = await retry(async () => { calls += 1; if (calls < 3) throw new Error(`ECONNRESET #${calls}`); return 'ok'; }, {
            attempts: 4,
            delayMs: 100,
            sleep: async (ms) => { waits.push(ms); },
            onRetry: (error, attempt) => notes.push(`${attempt}: ${(error as Error).message}`),
        });
        expect(value).toBe('ok');
        expect(calls).toBe(3);
        expect(waits).toEqual([100, 200]);
        expect(notes).toEqual(['1: ECONNRESET #1', '2: ECONNRESET #2']);
    });

    it('after the last attempt the last error is thrown, unchanged', async () => {
        let calls = 0;
        await expect(retry(async () => { calls += 1; throw new Error(`boom ${calls}`); }, { attempts: 3, delayMs: 1, sleep: async () => {} })).rejects.toThrow('boom 3');
        expect(calls).toBe(3);
    });

    it('attempts below 1 is a programming error, said as one', async () => {
        await expect(retry(async () => 1, { attempts: 0, delayMs: 1, sleep: async () => {} })).rejects.toThrow(/attempts/);
    });
});
