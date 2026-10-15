import { describe, expect, it, vi } from 'vitest';
import { quitSequence, type QuitPlan, type QuitStep } from '../src/core/quit.js';

/**
 * ONE QUIT, IN ORDER. Electron emits `before-quit` once per `app.quit()`, and Genie calls it more than
 * once in one quit (the running set is written, then the quit resumes); the OS can also end the
 * session mid-way. Whatever the sequence: asked at most once, recorded at most once, the shutdown run
 * EXACTLY once. `quitting` is what turns the main window's close from a hide into a real close — so a
 * cancelled question must leave it false.
 */

const asking: QuitPlan = { confirm: true, defaultChoice: 'cancel', title: 'Quit Genie?', message: '1 agent is running (kit). Quitting ends its session.', buttons: ['Cancel', 'Quit'] };

/** Drives one quit the way main.ts does: a 'record' step re-enters before-quit once the write lands. */
function drive(seq: ReturnType<typeof quitSequence>, answer: boolean, plan: QuitPlan = asking) {
    const ask = vi.fn(() => answer);
    const steps: QuitStep[] = [];
    let step = seq.beforeQuit({ ready: true, plan: () => plan, ask });
    steps.push(step);
    while (step === 'record') {
        step = seq.beforeQuit({ ready: true, plan: () => plan, ask });
        steps.push(step);
    }
    return { ask, steps };
}

describe('quitSequence', () => {
    it('a confirmed quit: asked once, recorded once, shut down once — and quitting from the answer on', () => {
        const seq = quitSequence();
        expect(seq.quitting).toBe(false);
        const { ask, steps } = drive(seq, true);
        expect(ask).toHaveBeenCalledTimes(1);
        expect(steps).toEqual(['record', 'shut-down']);
        expect(seq.quitting).toBe(true);
    });

    it('CANCEL changes nothing: not quitting (the window keeps hiding), and the next quit asks again', () => {
        const seq = quitSequence();
        expect(drive(seq, false).steps).toEqual(['cancel']);
        expect(seq.quitting).toBe(false);
        const again = drive(seq, true);
        expect(again.ask).toHaveBeenCalledTimes(1);
        expect(again.steps).toEqual(['record', 'shut-down']);
    });

    it('nothing running → no question, straight to record and shut down', () => {
        const seq = quitSequence();
        const { ask, steps } = drive(seq, false, { confirm: false });
        expect(ask).not.toHaveBeenCalled();
        expect(steps).toEqual(['record', 'shut-down']);
    });

    it('a SECOND quit request while the running set is being written: the shutdown runs once, the late re-entry passes', () => {
        const seq = quitSequence();
        const ask = vi.fn(() => true);
        const at = () => seq.beforeQuit({ ready: true, plan: () => asking, ask });
        const steps = [at(), /* the OS ends the session mid-write */ at(), /* the write lands and quits again */ at()];
        expect(steps).toEqual(['record', 'shut-down', 'pass']);
        expect(steps.filter((s) => s === 'shut-down')).toHaveLength(1);
        expect(ask).toHaveBeenCalledTimes(1);
    });

    it('the OS ending the session forces it: no question nothing could answer, quitting at once', () => {
        const seq = quitSequence();
        seq.force();
        expect(seq.quitting).toBe(true);
        const { ask, steps } = drive(seq, false);
        expect(ask).not.toHaveBeenCalled();
        expect(steps).toEqual(['record', 'shut-down']);
    });

    it('an upgrade’s drain recorded the running set itself: the quit does not record over it', () => {
        const seq = quitSequence();
        seq.markRecorded();
        expect(drive(seq, true).steps).toEqual(['shut-down']);
    });

    it('before boot finished (no host yet): no question, no record, the shutdown still runs once', () => {
        const seq = quitSequence();
        const ask = vi.fn(() => false);
        expect(seq.beforeQuit({ ready: false, plan: () => asking, ask })).toBe('shut-down');
        expect(seq.beforeQuit({ ready: false, plan: () => asking, ask })).toBe('pass');
        expect(ask).not.toHaveBeenCalled();
    });
});
