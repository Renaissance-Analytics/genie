import { describe, expect, it } from 'vitest';
import { windowWaitNote, WINDOW_WAIT_BUDGET_MS } from '../launch';

/**
 * HOW LONG DOES A SECOND WINDOW ACTUALLY TAKE? — the measurement genie#826 needs before anybody
 * touches the timeout.
 *
 * The failure: `electronApplication.waitForEvent: Timeout 30000ms exceeded while waiting for event
 * "window"`, macOS only, killing whichever test was waiting. The two obvious responses are both
 * guesses:
 *
 *  - **raise the budget** — which hides the bug if something is intermittently blocking the open, and
 *  - **call it infrastructure** — which the issue itself warns is what a timeout always looks like
 *    and usually is not.
 *
 * The discriminating fact is the time a *successful* open takes on that runner. If healthy is already
 * 20s on macOS, the budget is genuinely wrong and raising it is a one-line change with evidence
 * behind it. If healthy is 2s, the budget is innocent and something blocks the open intermittently.
 * Nobody has that number, because the rig only ever reported the failure.
 *
 * So the elapsed time is logged on SUCCESS, which is the case that carries the information — and
 * flagged when a passing run comes close to the limit, so the next failure is predicted rather than
 * discovered. A run at 24s passes today and is the warning that it will not tomorrow.
 *
 * Pure, so the thresholds are asserted without opening a window — and because the desktop rule
 * forbids opening one here at all.
 */

describe('windowWaitNote', () => {
    const budget = WINDOW_WAIT_BUDGET_MS;

    it('reports the elapsed time and what was being opened', () => {
        const note = windowWaitNote({ ms: 1_240, label: 'flow editor' });
        expect(note.message).toContain('1240');
        expect(note.message).toContain('flow editor');
    });

    it('names the BUDGET, so a reader can judge the number without knowing the rig', () => {
        // "the window took 24000ms" means nothing on its own. "24000ms of a 30000ms budget" is a
        // sentence someone can act on.
        expect(windowWaitNote({ ms: 100, label: 'x' }).message).toContain(String(budget));
    });

    it('is NOT near the limit for a fast open', () => {
        expect(windowWaitNote({ ms: 500, label: 'x' }).nearLimit).toBe(false);
    });

    it('IS near the limit for an open that passed but only just', () => {
        // The whole point: a run at 24s of 30s passes, and is the only warning available before the
        // same spec fails on a slightly slower runner.
        expect(windowWaitNote({ ms: Math.round(budget * 0.9), label: 'x' }).nearLimit).toBe(true);
    });

    it('says so IN THE MESSAGE when it is near the limit, not only in the flag', () => {
        // The flag is for a caller; the message is what a human greps a 10-minute log for.
        const note = windowWaitNote({ ms: Math.round(budget * 0.9), label: 'flow editor' });
        expect(note.message.toLowerCase()).toMatch(/near|close to|budget/);
        expect(note.message).toContain('genie#826');
    });

    it('is deterministic exactly AT the threshold rather than flapping', () => {
        // A boundary that depends on rounding would make the warning itself intermittent, which is
        // the thing being investigated.
        const at = Math.ceil(budget * 0.7);
        const below = windowWaitNote({ ms: at - 1, label: 'x' }).nearLimit;
        const atOrAbove = windowWaitNote({ ms: at, label: 'x' }).nearLimit;
        expect(below).toBe(false);
        expect(atOrAbove).toBe(true);
    });

    it('handles a zero or negative elapsed time without claiming a problem', () => {
        // A clock that goes backwards is not a slow window. Reporting it as "near the limit" would
        // send someone after the wrong thing.
        for (const ms of [0, -5]) {
            expect(windowWaitNote({ ms, label: 'x' }).nearLimit, String(ms)).toBe(false);
        }
    });
});

describe('WINDOW_WAIT_BUDGET_MS', () => {
    it('matches the 30s Playwright actually enforces', () => {
        // If these drift, the warning fires at the wrong point and the logged ratio is a lie. 30000
        // is Playwright's default `waitForEvent` timeout, which is what the failure reported.
        expect(WINDOW_WAIT_BUDGET_MS).toBe(30_000);
    });
});

describe('the flow-editor helper uses it', () => {
    const src = require('node:fs')
        .readFileSync(require('node:path').resolve(__dirname, '../../master-window.spec.ts'), 'utf8')
        .replace(/\r\n/g, '\n');

    it('times the wait and logs the note', () => {
        // Built-and-unwired is this phase's signature defect, and a measurement nobody takes is the
        // cheapest possible instance of it.
        expect(src).toContain('windowWaitNote(');
    });

    it('positive control: the guard reads the real spec', () => {
        expect(src).toContain('async function openFlowEditor');
        expect(src).not.toContain('windowWaitNoteThatDoesNotExist');
    });
});
