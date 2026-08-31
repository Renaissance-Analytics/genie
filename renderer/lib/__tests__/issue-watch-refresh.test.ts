import { describe, expect, it } from 'vitest';
import { refreshControlState } from '../issue-watch-refresh';

/**
 * The FORCE-REFRESH control — make Tynn re-read GitHub now, rather than waiting
 * for the next server poll.
 *
 * The whole backend for this already existed: `requestIssueWatchRefresh`, the
 * Tynn endpoint, the three outcomes, the cooldown passed through untouched. Its
 * own header says "the entry point `checkIssues(refresh)` and the UI button both
 * call" it — but there was no IPC handler, so the renderer could not reach it
 * and the button was never built. An agent could force a refresh and the owner
 * could not.
 *
 * TYNN OWNS THE RATE LIMIT — one window per workspace, shared by every agent and
 * the human. This state model therefore never invents a wait: it renders what
 * came back. A second countdown computed here would disagree with the server's
 * the moment another Genie window spent the window first, and the disagreement
 * would show as a button that looks ready and is refused.
 */

describe('refreshControlState', () => {
    it('is ready before anything has been asked', () => {
        const s = refreshControlState({ busy: false, last: null });
        expect(s.disabled).toBe(false);
        expect(s.label).toBe('Refresh now');
    });

    it('is busy while the request is in flight', () => {
        const s = refreshControlState({ busy: true, last: null });
        expect(s.disabled).toBe(true);
        expect(s.label).toMatch(/refreshing/i);
    });

    it('reports a refusal as a WAIT, not as an error', () => {
        // A cooldown is the system working. Rendering it as a failure would
        // train the owner to ignore real failures.
        const s = refreshControlState({
            busy: false,
            last: { refreshed: false, reason: 'cooldown', cooldown: { seconds: 154, nextAllowedAt: null, label: '2m 34s' } },
        });
        expect(s.disabled).toBe(true);
        expect(s.tone).toBe('wait');
        // The SERVER's label, verbatim — not a countdown computed here.
        expect(s.label).toContain('2m 34s');
    });

    it('re-enables once the server says the window is open', () => {
        const s = refreshControlState({
            busy: false,
            last: { refreshed: false, reason: 'cooldown', cooldown: { seconds: 0, nextAllowedAt: null, label: 'now' } },
        });
        expect(s.disabled).toBe(false);
    });

    it('shows a real failure AS a failure, and stays clickable', () => {
        // Tynn never charged the window for a request it did not serve, so
        // there is nothing to wait for and retrying immediately is correct.
        const s = refreshControlState({
            busy: false,
            last: { refreshed: false, reason: 'failed', error: 'Tynn POST … -> 500', cooldown: { seconds: 0, nextAllowedAt: null, label: 'now' } },
        });
        expect(s.disabled).toBe(false);
        expect(s.tone).toBe('error');
        expect(s.detail).toContain('500');
    });

    it('confirms a refresh that actually happened', () => {
        const s = refreshControlState({
            busy: false,
            last: { refreshed: true, reason: 'refreshed', cooldown: { seconds: 180, nextAllowedAt: null, label: '3m' } },
        });
        expect(s.tone).toBe('ok');
        // Refreshing SPENDS the window, so the control is now waiting.
        expect(s.disabled).toBe(true);
        expect(s.label).toContain('3m');
    });

    it('says why it cannot refresh when Tynn is unreachable', () => {
        const s = refreshControlState({
            busy: false,
            last: { refreshed: false, reason: 'unavailable', error: 'not signed in to Tynn', cooldown: { seconds: 0, nextAllowedAt: null, label: 'now' } },
        });
        expect(s.tone).toBe('error');
        expect(s.detail).toMatch(/signed in/i);
    });
});
