import { describe, expect, it, vi } from 'vitest';
import { quitSequence, runQuit, type QuitAnswer, type QuitPlan, type QuitPorts, type QuitStep } from '../src/core/quit.js';

/**
 * ONE QUIT, IN ORDER. Electron emits `before-quit` once per `app.quit()`, and Genie calls it more than
 * once in one quit (the running set is written, then the quit resumes); the OS can also end the
 * session mid-way. Whatever the sequence: asked at most once, recorded at most once, the shutdown run
 * EXACTLY once. `quitting` is what turns the main window's close from a hide into a real close — so a
 * cancelled question must leave it false.
 */

const asking: QuitPlan = { confirm: true, defaultChoice: 'cancel', title: 'Quit Genie?', message: '1 agent is running (kit). Quitting ends its session.', buttons: ['Cancel', 'Quit'] };

/** Drives one quit the way main.ts does: a 'record' step re-enters before-quit once the write lands. */
function drive(seq: ReturnType<typeof quitSequence>, answer: QuitAnswer, plan: QuitPlan = asking) {
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
        const { ask, steps } = drive(seq, 'shut-down');
        expect(ask).toHaveBeenCalledTimes(1);
        expect(steps).toEqual(['record', 'shut-down']);
        expect(seq.quitting).toBe(true);
    });

    it('CANCEL changes nothing: not quitting (the window keeps hiding), and the next quit asks again', () => {
        const seq = quitSequence();
        expect(drive(seq, 'cancel').steps).toEqual(['cancel']);
        expect(seq.quitting).toBe(false);
        const again = drive(seq, 'shut-down');
        expect(again.ask).toHaveBeenCalledTimes(1);
        expect(again.steps).toEqual(['record', 'shut-down']);
    });

    it('nothing running → no question, straight to record and shut down', () => {
        const seq = quitSequence();
        const { ask, steps } = drive(seq, 'cancel', { confirm: false });
        expect(ask).not.toHaveBeenCalled();
        expect(steps).toEqual(['record', 'shut-down']);
    });

    it('a SECOND quit request while the running set is being written: the shutdown runs once, the late re-entry passes', () => {
        const seq = quitSequence();
        const ask = vi.fn((): QuitAnswer => 'shut-down');
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
        const { ask, steps } = drive(seq, 'cancel');
        expect(ask).not.toHaveBeenCalled();
        expect(steps).toEqual(['record', 'shut-down']);
    });

    it('an upgrade’s drain recorded the running set itself: the quit does not record over it', () => {
        const seq = quitSequence();
        seq.markRecorded();
        expect(drive(seq, 'shut-down').steps).toEqual(['shut-down']);
    });

    it('before boot finished (no host yet): no question, no record, the shutdown still runs once', () => {
        const seq = quitSequence();
        const ask = vi.fn((): QuitAnswer => 'cancel');
        expect(seq.beforeQuit({ ready: false, plan: () => asking, ask })).toBe('shut-down');
        expect(seq.beforeQuit({ ready: false, plan: () => asking, ask })).toBe('pass');
        expect(ask).not.toHaveBeenCalled();
    });

    it('JUST CLOSE THE UI: nothing recorded (the agents go on running), one close-ui step, quitting from the answer on', () => {
        const seq = quitSequence();
        const { ask, steps } = drive(seq, 'close-ui');
        expect(ask).toHaveBeenCalledTimes(1);
        expect(steps).toEqual(['close-ui']);
        expect(seq.quitting).toBe(true);
        // The quit resumes once the window let go of the host: it passes, the host is not shut down after all.
        expect(seq.beforeQuit({ ready: true, plan: () => asking, ask })).toBe('pass');
    });

    it('the tray’s answers are chosen up front: no question, the chosen step', () => {
        const ui = quitSequence();
        ui.choose('close-ui');
        expect(ui.quitting).toBe(true);
        expect(drive(ui, 'cancel').steps).toEqual(['close-ui']);
        const all = quitSequence();
        all.choose('shut-down');
        const { ask, steps } = drive(all, 'cancel');
        expect(ask).not.toHaveBeenCalled();
        expect(steps).toEqual(['record', 'shut-down']);
    });

    it('the OS ending the session always shuts down, even mid-way through a question nobody answered', () => {
        const seq = quitSequence();
        seq.force();
        expect(drive(seq, 'close-ui').steps).toEqual(['record', 'shut-down']);
    });
});

/**
 * WHAT EACH ANSWER DOES (P1b's red). "Just close the UI" ends this window's own work and lets go of the host: no agent is
 * stopped and the host is never told to shut down. "Shut down everything" is the graceful stop it always was: the agents
 * stopped, the window's work and the terminals closed, the stops drained, and only then the host ended.
 */
describe('runQuit', () => {
    function ports() {
        const calls: string[] = [];
        const p: QuitPorts = {
            stopAgents: () => { calls.push('stopAll'); },
            closeWindow: (how) => { calls.push(`window:${how}`); },
            closeTerminals: () => { calls.push('terminals'); },
            drained: async () => { calls.push('drained'); },
            shutDownHost: async () => { calls.push('engine.shutdown'); },
            leaveHostRunning: async () => { calls.push('leave'); },
        };
        return { calls, p };
    }

    it('"Just close the UI" calls no stopAll and no engine.shutdown: the window closes and leaves the host running', async () => {
        const { calls, p } = ports();
        await runQuit('close-ui', p);
        expect(calls).toEqual(['window:window', 'leave']);
        expect(calls).not.toContain('stopAll');
        expect(calls).not.toContain('engine.shutdown');
        expect(calls).not.toContain('terminals');
    });

    it('"Shut down everything" calls stopAll and then engine.shutdown, in order, after the drain', async () => {
        const { calls, p } = ports();
        await runQuit('shut-down', p);
        expect(calls).toEqual(['stopAll', 'window:everything', 'terminals', 'drained', 'engine.shutdown']);
        expect(calls).not.toContain('leave');
    });

    it('a drain that fails still ends the host: a quit is never left half done', async () => {
        const { calls, p } = ports();
        await runQuit('shut-down', { ...p, drained: async () => { calls.push('drained'); throw new Error('lost'); } });
        expect(calls.at(-1)).toBe('engine.shutdown');
    });
});
