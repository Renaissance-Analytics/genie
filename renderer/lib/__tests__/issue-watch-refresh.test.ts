import { describe, expect, it } from 'vitest';
import { refreshControlState, type RefreshOutcome } from '../issue-watch-refresh';

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

/**
 * A FAILURE MUST NOT INVENT A CAUSE, and must not hide.
 *
 * The owner: "the issue watch refresh button doesn't do anything at all." It
 * had run and failed — the button in the screenshot is already rose-toned. The
 * entire report of the failure was a CSS colour and a `title` tooltip, which is
 * indistinguishable from an untouched button unless you happen to hover it.
 *
 * The fallback sentence made it worse: any outcome without an `error` was
 * described as "Could not reach Tynn", which is a specific and often wrong
 * claim — a refusal because Genie is not SIGNED IN to Tynn, or because the
 * workspace is unknown, has nothing to do with reachability. A cause invented
 * to fill a gap sends someone to check their network over a sign-in problem.
 */
describe('a failed refresh reports what actually happened', () => {
    const outcome = (over: Partial<RefreshOutcome>): RefreshOutcome => ({
        refreshed: false,
        reason: 'failed',
        cooldown: { seconds: 0, nextAllowedAt: null, label: 'now' },
        ...over,
    });

    it('passes the real reason through untouched', () => {
        const s = refreshControlState({
            busy: false,
            last: outcome({
                reason: 'unavailable',
                error: 'Genie is not signed in to Tynn, so IssueWatch cannot be refreshed.',
            }),
        });
        expect(s.detail).toBe('Genie is not signed in to Tynn, so IssueWatch cannot be refreshed.');
    });

    it('does NOT invent "could not reach Tynn" when the outcome did not say so', () => {
        const s = refreshControlState({ busy: false, last: outcome({ error: undefined }) });
        expect(s.detail ?? '').not.toMatch(/could not reach/i);
    });

    it('still says SOMETHING — silence is the bug being fixed', () => {
        // POSITIVE CONTROL for the test above: dropping the fallback entirely
        // would satisfy it while restoring the original complaint.
        const s = refreshControlState({ busy: false, last: outcome({ error: undefined }) });
        expect(s.detail).toBeTruthy();
    });

    it('marks a failure as one the UI must ANNOUNCE, not merely tint', () => {
        // The flyout rendered `detail` into `title=` only. A control that
        // reports a failure exclusively through hover has not reported it.
        const s = refreshControlState({ busy: false, last: outcome({ error: 'Tynn answered 503.' }) });
        expect(s.announce).toBe(true);
    });

    it('POSITIVE CONTROL: a COOLDOWN is not announced — the limit working is not a fault', () => {
        const s = refreshControlState({
            busy: false,
            last: outcome({
                reason: 'cooldown',
                cooldown: { seconds: 90, nextAllowedAt: null, label: '1m 30s' },
            }),
        });
        expect(s.announce).toBeFalsy();
    });
});
