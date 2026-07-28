import { describe, expect, it } from 'vitest';
import { formatQuestionAge } from '../question-age';

/**
 * "When did this question come in?" (genie #60). The inbox lists questions that
 * may have been waiting minutes or hours; a relative age is what tells the owner
 * whether an agent is freshly blocked or has been stuck all afternoon.
 *
 * Degrades to null (render nothing) when there's no stamp — a question forwarded
 * from a host running an older build carries none, and a missing timestamp must
 * never show up as "56 years ago" (epoch 0) in the flyout.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatQuestionAge', () => {
    it('renders nothing without a usable stamp (older host, or garbage)', () => {
        expect(formatQuestionAge(undefined, 1_000)).toBeNull();
        expect(formatQuestionAge(0, 1_000)).toBeNull();
        expect(formatQuestionAge(Number.NaN, 1_000)).toBeNull();
    });

    it('collapses the first minute to "just now"', () => {
        expect(formatQuestionAge(1_000_000, 1_000_000)).toBe('just now');
        expect(formatQuestionAge(1_000_000, 1_000_000 + 59_000)).toBe('just now');
    });

    it('counts minutes, then hours, then days', () => {
        const t = 1_000_000_000;
        expect(formatQuestionAge(t, t + MIN)).toBe('1m ago');
        expect(formatQuestionAge(t, t + 5 * MIN)).toBe('5m ago');
        expect(formatQuestionAge(t, t + 59 * MIN)).toBe('59m ago');
        expect(formatQuestionAge(t, t + HOUR)).toBe('1h ago');
        expect(formatQuestionAge(t, t + 23 * HOUR)).toBe('23h ago');
        expect(formatQuestionAge(t, t + DAY)).toBe('1d ago');
        expect(formatQuestionAge(t, t + 9 * DAY)).toBe('9d ago');
    });

    it('treats a stamp from the future as just now (clock skew between host and client)', () => {
        const t = 1_000_000_000;
        expect(formatQuestionAge(t + 5 * MIN, t)).toBe('just now');
    });
});
