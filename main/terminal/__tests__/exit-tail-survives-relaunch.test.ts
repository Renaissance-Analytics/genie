import { describe, expect, it } from 'vitest';
import { rememberExitTail, takeExitTail, forgetExitTail } from '../exit-tail';

/**
 * THE EXIT TAIL MUST SURVIVE THE NEXT PTY (genie#733).
 *
 * `runAgent diagnose` tells you the exit tail is the only evidence of why an
 * agent died. It was not retained across a relaunch, so — in claude:fancy's
 * words — **the advice cannot be followed at the moment it is given.**
 *
 * Genie already trimmed the buffer to a bounded tail on exit (genie#217), for
 * exactly this reason. The gap is that it trims THE SAME buffer: when a new pty
 * takes that terminal id, its first bytes push the dead process's last words
 * out. Anyone who restarts before reading — which is what `diagnose` tells them
 * to do — gets a bare prompt.
 *
 * Measured by fancy: 166 bytes of fresh prompt after a pty-exit, and the real
 * error (`failed to connect to remote app server … 401`) only became visible
 * because a LATER action happened to reprint it. Had the reattach also exited
 * silently, the cause would have been unavailable entirely.
 *
 * This is a small separate store, deliberately: the live buffer belongs to the
 * running pty and must stay that way.
 */
describe('exit tail', () => {
    it('survives the next pty writing to the same terminal id', () => {
        rememberExitTail('t1', 'Error: failed to connect to remote app server', 1);
        // The relaunch happens — new pty, same id, and in the live buffer this
        // is what overwrites the evidence.
        const kept = takeExitTail('t1');
        expect(kept?.tail).toContain('failed to connect');
        expect(kept?.exitCode).toBe(1);
    });

    it('is bounded, keeping the END where the error is', () => {
        // A dying process can print a lot. What matters is the last thing it
        // said, not the first — so a cap trims the HEAD.
        const huge = 'x'.repeat(40_000) + 'THE ACTUAL ERROR';
        rememberExitTail('t2', huge, 1);
        const kept = takeExitTail('t2');
        expect(kept!.tail.length).toBeLessThanOrEqual(16 * 1024);
        expect(kept!.tail).toContain('THE ACTUAL ERROR');
    });

    it('returns nothing for a terminal that never exited', () => {
        // POSITIVE CONTROL for the assertions above: an empty answer has to be
        // reachable, or "it kept the tail" proves nothing.
        expect(takeExitTail('never-ran')).toBeUndefined();
    });

    it('is dropped when the terminal is really gone', () => {
        // A killed terminal takes its spec with it; keeping its last words
        // forever would be a leak, and there is nothing left to diagnose.
        rememberExitTail('t3', 'bye', 0);
        forgetExitTail('t3');
        expect(takeExitTail('t3')).toBeUndefined();
    });

    it('keeps only the most recent death', () => {
        // An agent that crash-loops should report why it died THIS time.
        rememberExitTail('t4', 'first death', 1);
        rememberExitTail('t4', 'second death', 2);
        const kept = takeExitTail('t4');
        expect(kept?.tail).toBe('second death');
        expect(kept?.exitCode).toBe(2);
    });
});
