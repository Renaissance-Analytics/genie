import { describe, expect, it } from 'vitest';
import { QUIT_ARG, QUIT_DATA, answerSecondInstance } from '../src/core/quit-flag.js';

/**
 * `Genie --quit` while an agent runs: the quit question must not be asked INSIDE the second-instance notification.
 *
 * The quit asks "Quit Genie?" whenever an agent session is running (core/quit.ts `quitPlan`), and the dialog is
 * synchronous (main.ts before-quit `dialog.showMessageBoxSync`). Run from the `second-instance` handler, it held the
 * asking launch's single-instance notification unanswered for as long as the question was open; the asking launch then
 * judged Genie hung and Chromium's ProcessSingleton terminated it with RESULT_CODE_HUNG. Installed-app acceptance,
 * Windows VM, 2026-10-15: every `Genie.exe --quit` with an agent running ended Genie with exit code 2 (0 with none),
 * no before-quit ran, and the agent's provider outlived Genie (sites 4b2/4f, browser 5b, processes 6c).
 *
 * The contract: the handler RETURNS before the quit starts (the quit is deferred past it); revealing a window, which
 * asks nothing, stays immediate.
 */

const SECOND = ['C:\\Users\\example\\AppData\\Local\\Programs\\Genie\\Genie.exe', '--original-process-start-time=13370000000000000'];

function harness() {
    const calls: string[] = [];
    const deferred: Array<() => void> = [];
    const act = {
        quit: () => { calls.push('quit'); },
        reveal: () => { calls.push('reveal'); },
        defer: (run: () => void) => { calls.push('defer'); deferred.push(run); },
    };
    return { calls, deferred, act };
}

describe('answerSecondInstance — the quit waits until the notification is answered', () => {
    it('a --quit (by additionalData) does NOT quit inside the handler: it is deferred, and quits when the deferral runs', () => {
        const h = harness();
        const action = answerSecondInstance(SECOND, { ...QUIT_DATA }, h.act);
        expect(action).toBe('quit');
        // Inside the handler: deferred, not run. A quit run here is the question asked inside the notification.
        expect(h.calls).toEqual(['defer']);
        expect(h.deferred).toHaveLength(1);
        h.deferred[0]!();
        expect(h.calls).toEqual(['defer', 'quit']);
    });

    it('a --quit carried only in argv is deferred the same way', () => {
        const h = harness();
        expect(answerSecondInstance([...SECOND, QUIT_ARG], undefined, h.act)).toBe('quit');
        expect(h.calls).toEqual(['defer']);
        h.deferred[0]!();
        expect(h.calls).toEqual(['defer', 'quit']);
    });

    it('CONTROL: a plain second launch reveals at once, and defers and quits nothing', () => {
        const h = harness();
        expect(answerSecondInstance(SECOND, undefined, h.act)).toBe('reveal');
        expect(h.calls).toEqual(['reveal']);
        expect(h.deferred).toHaveLength(0);
    });
});

/**
 * THE SIGN-IN COMING BACK (the owner, 2026-10-19: Tynn sign-in the way Genie 1 did). On Windows and Linux the browser's
 * genie://oauth/callback?token=… arrives as a SECOND LAUNCH whose argv carries the URL. The first instance shows its
 * window and hands the URL on — after the handler returns, like the quit: the sign-in makes a network call.
 */
describe('answerSecondInstance — a genie:// URL is handed on', () => {
    const URL = `genie://oauth/callback?token=${'aB3'.repeat(21)}x`;

    it('reveals at once and opens the URL once the handler has returned', () => {
        const h = harness();
        const opened: string[] = [];
        expect(answerSecondInstance([...SECOND, URL], undefined, { ...h.act, open: (u) => { opened.push(u); } })).toBe('reveal');
        expect(h.calls).toEqual(['reveal', 'defer']);
        expect(opened).toEqual([]);
        h.deferred[0]!();
        expect(opened).toEqual([URL]);
    });

    it('CONTROL: a plain second launch opens nothing', () => {
        const h = harness();
        const opened: string[] = [];
        answerSecondInstance(SECOND, undefined, { ...h.act, open: (u) => { opened.push(u); } });
        expect(h.calls).toEqual(['reveal']);
        expect(opened).toEqual([]);
    });
});
