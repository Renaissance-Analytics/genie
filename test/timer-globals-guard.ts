/**
 * Fail the test file that LEAVES a global timer function replaced.
 *
 * The suite runs every file in ONE fork (`pool: 'forks'`, `singleFork: true`),
 * so `globalThis.setTimeout` / `setInterval` are shared by all 211 files. A file
 * that swaps one and doesn't put the original back doesn't fail itself — it
 * breaks whichever unrelated file the sequencer happens to run next, with an
 * assertion that names the innocent file. That is exactly how genie#76 read as a
 * "CI load flake": `vi.spyOn(globalThis, 'setInterval')` taken while fake timers
 * were installed left a DEAD sinon clock shim on the global, so every later
 * `setInterval` in the process silently never fired — and the MCP server's SSE
 * heartbeat (an interval) stopped beating while its `setTimeout`s kept working.
 *
 * This guard captures the pristine functions ONCE for the whole fork, then after
 * each file asserts they're still installed. The leak is reported against the
 * file that caused it, and the globals are put back so the rest of the run
 * reports its own truth instead of a cascade.
 */
import { afterAll, vi } from 'vitest';

/** The timer globals a test can plausibly swap (fake timers, spies, stubs). */
const TIMER_GLOBALS = [
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'setImmediate',
    'clearImmediate',
    'queueMicrotask',
] as const;

type TimerGlobal = (typeof TIMER_GLOBALS)[number];

/**
 * Stash the originals on the fork's global object, not in module scope: vitest
 * resets the module registry between files, so a module-level snapshot would be
 * retaken per file and would capture an ALREADY-POLLUTED value as "pristine".
 */
const PRISTINE = Symbol.for('genie.test.pristineTimerGlobals');

type Holder = Record<symbol, Partial<Record<TimerGlobal, unknown>> | undefined>;

const holder = globalThis as unknown as Holder;
if (!holder[PRISTINE]) {
    const snapshot: Partial<Record<TimerGlobal, unknown>> = {};
    for (const name of TIMER_GLOBALS) {
        snapshot[name] = (globalThis as unknown as Record<TimerGlobal, unknown>)[name];
    }
    holder[PRISTINE] = snapshot;
}
const pristine = holder[PRISTINE]!;

afterAll(() => {
    // Vitest restores spies when it tears the FILE down — after this hook. A
    // spy taken while fake timers were installed recorded the clock shim as its
    // "original", so that teardown is what re-installs the dead shim, silently,
    // once this file is already reported green. Bring the restore forward: the
    // file's tests are finished either way, and now the damage lands HERE where
    // it can be attributed to the file that caused it.
    vi.restoreAllMocks();

    const leaked: TimerGlobal[] = [];
    for (const name of TIMER_GLOBALS) {
        const current = (globalThis as unknown as Record<TimerGlobal, unknown>)[name];
        if (current === pristine[name]) continue;
        leaked.push(name);
        // Put the real one back so the NEXT file is judged on its own behaviour.
        (globalThis as unknown as Record<TimerGlobal, unknown>)[name] = pristine[name];
    }
    if (leaked.length > 0) {
        throw new Error(
            `This test file leaked replaced timer global(s): ${leaked.join(', ')}. ` +
                'Every test file shares one fork, so the next file would silently get ' +
                'the replacement (a dead fake-timer clock never fires) and fail instead. ' +
                'Restore any vi.spyOn/stub of a timer global BEFORE vi.useRealTimers() — ' +
                'a spy taken while fake timers are installed captures the CLOCK SHIM as ' +
                'its original and reinstalls it on restore. See genie#76.',
        );
    }
});
