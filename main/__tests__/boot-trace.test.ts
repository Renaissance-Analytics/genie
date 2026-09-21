import { describe, expect, it } from 'vitest';
import {
    BOOT_DONE,
    formatPhase,
    phaseOf,
    rotate,
    whereBootStopped,
} from '../boot-trace';

/**
 * The boot trace exists to answer ONE question after the fact: where did it
 * stop? (the owner's crash + 30-second spinner, neither of which left any
 * evidence at all — no crash dump, no main-process log, and zero boot logging).
 *
 * So the assertions that matter are about a boot that did NOT finish. A trace
 * that only reads correctly when everything worked would be useless for the
 * case it was built for.
 */

const line = (phase: string, ms = 10) => formatPhase(phase, ms, new Date('2026-09-21T02:40:39.000Z'));

describe('whereBootStopped', () => {
    it('names the phase a hung boot was in', () => {
        // THE CASE. The process never reached `ready`, so the last phase it
        // wrote is what it was waiting on — the answer to "what was the spinner
        // doing".
        const trace = [line('start'), line('db'), line('workspaces', 30_000)].join('\n');
        expect(whereBootStopped(trace)).toBe('workspaces');
    });

    it('says nothing when the boot completed', () => {
        // POSITIVE CONTROL: a completed boot must NOT look like a stall, or
        // every healthy boot would report a phantom failure and the signal would
        // be worthless.
        const trace = [line('start'), line('db'), line(BOOT_DONE)].join('\n');
        expect(whereBootStopped(trace)).toBeNull();
    });

    it('reports the LAST boot, not an earlier stall', () => {
        // A machine that hung once and has booted fine since is healthy now.
        const trace = [
            line('start'), line('workspaces'),          // stalled boot
            line('start'), line('db'), line(BOOT_DONE), // then a good one
        ].join('\n');
        expect(whereBootStopped(trace)).toBeNull();
    });

    it('is empty-safe', () => {
        expect(whereBootStopped('')).toBeNull();
    });
});

describe('formatPhase / phaseOf', () => {
    it('round-trips the phase name', () => {
        expect(phaseOf(formatPhase('host services', 1234, new Date()))).toBe('host services');
    });

    it('carries the elapsed time, which is how long it had been waiting', () => {
        expect(formatPhase('workspaces', 30_412, new Date('2026-09-21T02:41:09.412Z'))).toContain(
            '+ 30412ms workspaces',
        );
    });

    it('ignores a line that is not a trace line', () => {
        expect(phaseOf('some stray text')).toBeNull();
    });
});

describe('rotate', () => {
    it('keeps whole boots, never a fragment', () => {
        // A trimmed-in-the-middle boot would read as one that stopped early —
        // the exact false positive this file exists to avoid.
        const trace = [
            line('start'), line('a'), line(BOOT_DONE),
            line('start'), line('b'), line(BOOT_DONE),
            line('start'), line('c'), line(BOOT_DONE),
        ].join('\n');

        const kept = rotate(trace, 2);

        expect(kept.split('\n').filter(Boolean)).toHaveLength(6);
        expect(kept).toContain('b');
        expect(kept).toContain('c');
        expect(kept).not.toContain(' a');
    });

    it('keeps an UNFINISHED trailing boot intact', () => {
        // The most important one to preserve is the boot that never ended.
        const trace = [
            line('start'), line('a'), line(BOOT_DONE),
            line('start'), line('stuck-here'),
        ].join('\n');

        expect(rotate(trace, 1)).toContain('stuck-here');
    });

    it('leaves a short trace alone', () => {
        const trace = [line('start'), line(BOOT_DONE)].join('\n');
        expect(rotate(trace, 20).split('\n').filter(Boolean)).toHaveLength(2);
    });
});
