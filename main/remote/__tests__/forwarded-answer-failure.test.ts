import { describe, expect, it } from 'vitest';
import { forwardedAnswerFailureMessage } from '../index';

/**
 * A forwarded ForceTheQuestion answer that never reaches the host used to fail
 * SILENTLY: the POST was fire-and-forget under a swallowing `.catch(() => {})`,
 * so the driver's modal closed exactly as it does on success while the host sat
 * waiting with its own modal open and the agent blocked. Nothing distinguished
 * a delivered answer from a lost one.
 *
 * The failure is now surfaced. These pin the wording, because WHICH failure it
 * was is the whole diagnostic value — a 423 means the host's kill-switch refused
 * it and the user must act on the host, which is entirely different from a
 * transport blip.
 */
describe('forwardedAnswerFailureMessage', () => {
    it('names the kill-switch on 423, with what to do about it', () => {
        const msg = forwardedAnswerFailureMessage(new Error('HTTP 423'));
        expect(msg).toContain('kill-switch');
        expect(msg).toContain('Answer on the host');
    });

    it('tells the driver to reconnect on an auth rejection', () => {
        expect(forwardedAnswerFailureMessage(new Error('HTTP 401'))).toContain('Reconnect');
        expect(forwardedAnswerFailureMessage(new Error('HTTP 403'))).toContain('Reconnect');
    });

    it('falls back to the raw reason, and promises the question comes back', () => {
        const msg = forwardedAnswerFailureMessage(new Error('HTTP 500'));
        expect(msg).toContain('HTTP 500');
        // The recovery contract: the answer is not dropped, the modal re-raises.
        expect(msg).toContain('still waiting');
    });

    it('handles a non-Error rejection without throwing', () => {
        expect(() => forwardedAnswerFailureMessage('socket hang up')).not.toThrow();
        expect(forwardedAnswerFailureMessage('socket hang up')).toContain('socket hang up');
    });
});
