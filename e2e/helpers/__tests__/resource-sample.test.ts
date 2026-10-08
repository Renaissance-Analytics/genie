import { describe, expect, it } from 'vitest';
import { resourceNote, readThreadCount } from '../launch';

/**
 * DOES THE THREAD COUNT CLIMB THROUGH AN E2E RUN? — the measurement that decides whether genie#667
 * is its own bug or a symptom of genie#805.
 *
 * #667's sixth occurrence finally produced a minidump (`400f4a5b` on main, ubuntu). What it
 * establishes: the **renderer** dies, `--disable-dev-shm-usage` is already set, and discardable
 * memory was 99.1 % free — so the two usual Chromium suspects are both out. What it suggests, from a
 * truncated string on the crashing stack, is a glibc fatal error of the `pthread_create`-failed
 * shape: a renderer that cannot create a thread aborts exactly like this.
 *
 * And #805 is already filed: *"pty-host leaks ~12 MB commit, 1 thread and ~11 handles per exited
 * terminal."* An E2E run kills a great many terminals across ~180 specs. If threads accumulate, the
 * crash is #805 arriving at a ceiling, and the fix is there rather than in whichever spec happened to
 * reload at the wrong moment.
 *
 * **One number, sampled once per spec file, answers it.** Monotonic growth means accumulation; a flat
 * line means the crash is something else and this hypothesis dies cheaply.
 *
 * Diagnostics only: it reads, it never changes a limit. Raising a ceiling before knowing whether the
 * count climbs would hide the leak rather than fix it — the same error that raising #826's timeout
 * would have been, which the measurement there proved.
 */

describe('readThreadCount', () => {
    it('returns a number on a system that exposes /proc, or NULL where it does not', () => {
        // Honest about what it cannot see, per this codebase's rule: `null` is "cannot see", never 0.
        // A confident 0 would read as "no threads", which is impossible and would hide the series.
        const n = readThreadCount();
        expect(n === null || (typeof n === 'number' && n > 0)).toBe(true);
    });
});

describe('resourceNote — the series', () => {
    it('reports the count, and the DELTA against the first sample', () => {
        // The delta is the whole point. An absolute count means nothing without the baseline; "+180
        // since the first spec" is the sentence that identifies a leak.
        const note = resourceNote({ threads: 240, first: 60 });
        expect(note.message).toContain('240');
        expect(note.message).toContain('180');
    });

    it('does not flag the FIRST sample, which has nothing to grow from', () => {
        const note = resourceNote({ threads: 60, first: 60 });
        expect(note.climbing).toBe(false);
    });

    it('FLAGS a count that has multiplied, which is what accumulation looks like', () => {
        // #805 is one thread per exited terminal, so a leak shows up as a multiple rather than a few
        // extra. A 4x rise over a run is not scheduling noise.
        expect(resourceNote({ threads: 240, first: 60 }).climbing).toBe(true);
    });

    it('does NOT flag ordinary variation, or the signal is worthless', () => {
        // Threads go up and down normally as pools spin up. Flagging that would produce a warning on
        // every run and teach the reader to skip the line that matters — the same failure the
        // release-notes limit exists to prevent.
        expect(resourceNote({ threads: 72, first: 60 }).climbing).toBe(false);
    });

    it('says nothing useful but does not throw when the count is unreadable', () => {
        // Windows and macOS runners have no /proc. The note must degrade to "cannot see" rather than
        // inventing a series out of nulls.
        const note = resourceNote({ threads: null, first: null });
        expect(note.climbing).toBe(false);
        expect(note.message.toLowerCase()).toMatch(/not available|cannot/);
    });

    it('handles a first sample that is unreadable while a later one is not', () => {
        // Asymmetry is possible if /proc appears late or a read fails once. No baseline means no
        // delta claim — reporting one against null would be inventing it.
        const note = resourceNote({ threads: 240, first: null });
        expect(note.message).toContain('240');
        expect(note.climbing).toBe(false);
    });
});

describe('the launch path samples it', () => {
    const src = require('node:fs')
        .readFileSync(require('node:path').resolve(__dirname, '../launch.ts'), 'utf8')
        .replace(/\r\n/g, '\n');

    it('takes a sample when an app launches', () => {
        // Once per spec FILE, not per test: ~30 lines a run is a readable series, 180 is noise.
        expect(src).toContain('resourceNote(');
    });

    it('positive control: the guard reads the real file', () => {
        expect(src).toContain('export async function launchGenieE2E');
        expect(src).not.toContain('resourceNoteThatDoesNotExist');
    });
});
