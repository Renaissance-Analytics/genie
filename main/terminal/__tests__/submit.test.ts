import { describe, expect, it } from 'vitest';
import { deliverInput, SETTLE_CAP_MS, SETTLE_QUIET_MS, CONFIRM_MS } from '../submit';

/**
 * SUBMIT WHEN THE TERMINAL IS READY, AND SAY WHAT ACTUALLY HAPPENED.
 *
 * A multi-line prompt is delivered as a bracketed paste with the submitting
 * Enter as a SEPARATE write, so it cannot race the TUI leaving paste mode
 * (issue #8). That second write went out on a fixed 60ms timer, and the result
 * reported `submitted: true` whenever the BYTE reached the pty.
 *
 * Both halves were wrong in the same situation. A freshly-restarted Codex was
 * still coming up 60ms after the paste; the Enter arrived at a TUI that was not
 * listening, the prompt sat in the composer as `[Pasted Content 1270 chars]`,
 * and the call reported success. The agent never took a turn and the caller had
 * no way to know — four times in one session, each repaired by a bare Enter.
 *
 * So: WAIT for the terminal to go quiet before submitting, then CONFIRM it
 * reacted.
 *
 * ## The rule that keeps this honest
 *
 * Genie cannot see inside a TUI; it sees whether the pty produced anything. "No
 * output at all after an Enter" is strong evidence a TUI ignored it, since any
 * keypress redraws something — but it is evidence, not proof, so the
 * unobservable case is never reported as failure. With NO output history for a
 * terminal, confirmation is skipped and the old byte-level answer stands: "we
 * could not check" must not become "it failed".
 */

/**
 * A scripted terminal on a clock the test drives.
 *
 * It records WHEN each thing happened, not just how much sleeping occurred —
 * that distinction is the whole point. The first version of these tests asserted
 * `slept > SETTLE_QUIET_MS`, which the unrelated confirm delay satisfies on its
 * own: replacing the settle with a fixed timer (which IS the bug) left all eight
 * tests passing. Duration proves nothing; the ORDER of the writes against the
 * output does.
 *
 * `sleep` also refuses to run forever. Without the cap the settle loop spins
 * against a terminal that never goes quiet, and the test hangs instead of
 * failing — a hang is an unreadable signal that stalls CI rather than reporting
 * anything, so the harness turns it into a plain failure.
 */
function fake(opts: { emitsOn?: 'body' | 'submit' | 'both' | 'never'; observable?: boolean } = {}) {
    const emits = opts.emitsOn ?? 'both';
    const writes: string[] = [];
    let clock = 1_000;
    let lastOut: number | null = opts.observable === false ? null : clock;
    /** Clock reading when output last CHANGED. */
    let lastOutChangeAt = clock;
    /** Clock reading when the submit (second) write went out. */
    let submitAt: number | null = null;
    let slept = 0;
    let sleeps = 0;
    return {
        writes,
        get slept() {
            return slept;
        },
        /** How long the terminal had been quiet when the Enter was written. */
        quietBeforeSubmit(): number {
            if (submitAt === null) throw new Error('nothing was submitted');
            return submitAt - lastOutChangeAt;
        },
        ports: {
            write(_id: string, data: string): boolean {
                writes.push(data);
                const isSubmit = writes.length > 1;
                if (isSubmit) submitAt = clock;
                if (
                    emits === 'both' ||
                    (emits === 'body' && !isSubmit) ||
                    (emits === 'submit' && isSubmit)
                ) {
                    if (opts.observable !== false) {
                        lastOut = clock;
                        lastOutChangeAt = clock;
                    }
                }
                return true;
            },
            lastOutputAt(): number | null {
                return lastOut;
            },
            sleep(ms: number): Promise<void> {
                if (++sleeps > 200) {
                    throw new Error(
                        'settle never finished — the wait is unbounded against a terminal that keeps emitting',
                    );
                }
                slept += ms;
                clock += ms;
                return Promise.resolve();
            },
        },
        /** Drive output that keeps arriving until `untilClock`, then stops. */
        noisyUntil(untilClock: number) {
            return (): number => {
                if (clock < untilClock) {
                    lastOut = clock;
                    lastOutChangeAt = clock;
                }
                return lastOut ?? 0;
            };
        },
    };
}

const PASTE = { bytes: '\x1b[200~line one\nline two\x1b[201~', submitAfter: '\r' };

describe('it waits for the terminal to stop talking before submitting', () => {
    it('sends the Enter only AFTER output has been quiet for the settle window', async () => {
        // THE property, and the one the first version of this test missed. A TUI
        // still coming up keeps emitting; the Enter must land after it stops, not
        // after a fixed number of milliseconds. Asserting the GAP between the last
        // output and the submit is what a stopwatch cannot fake.
        const f = fake({ emitsOn: 'never' });
        const ports = { ...f.ports, lastOutputAt: f.noisyUntil(1_400) };

        await deliverInput('t1', PASTE, ports);

        expect(f.writes).toHaveLength(2);
        expect(f.quietBeforeSubmit()).toBeGreaterThanOrEqual(SETTLE_QUIET_MS);
    });

    it('gives up waiting rather than hanging on a terminal that never shuts up', async () => {
        // A tail -f, a spinner, a progress bar. Waiting forever is a worse failure
        // than submitting into noise, so the settle is capped — and the harness
        // turns an unbounded wait into a failure rather than a hung run.
        let t = 1_000;
        const f = fake();
        const ports = { ...f.ports, lastOutputAt: () => (t += 50) };

        await deliverInput('t1', PASTE, ports);

        expect(f.writes).toHaveLength(2);
        expect(f.slept).toBeLessThanOrEqual(SETTLE_CAP_MS + CONFIRM_MS);
    });

    it('does not dawdle when the terminal was quiet to begin with', async () => {
        // The common case. A settle that always paid the full cap would add most
        // of a second to every multi-line prompt in the product.
        const f = fake({ emitsOn: 'never' });

        await deliverInput('t1', PASTE, f.ports);

        expect(f.slept).toBeLessThan(SETTLE_CAP_MS);
    });
});

describe('it reports whether the terminal actually reacted', () => {
    it('says submitted when output follows the Enter', async () => {
        const f = fake({ emitsOn: 'both' });

        expect(await deliverInput('t1', PASTE, f.ports)).toEqual({
            delivered: true,
            submitted: true,
        });
    });

    it('says NOT submitted when the Enter changed nothing', async () => {
        // The bug, as a report rather than a silence. The body is sitting in the
        // TUI's input box; the caller needs to know, because the next Enter from
        // any source will send it.
        const f = fake({ emitsOn: 'body' });

        expect(await deliverInput('t1', PASTE, f.ports)).toEqual({
            delivered: true,
            submitted: false,
        });
    });

    it('does not call it a failure when it cannot be observed at all', async () => {
        // No output history — a pty that outlived a restart, say. "We could not
        // check" must not be reported as "it failed", or the note tells people to
        // re-send something that already ran.
        const f = fake({ observable: false });

        expect(await deliverInput('t1', PASTE, f.ports)).toEqual({
            delivered: true,
            submitted: true,
        });
    });
});

describe('the cases that never split', () => {
    it('a single-line submit carries its own CR and is not second-guessed', async () => {
        const f = fake({ emitsOn: 'never' });

        expect(await deliverInput('t1', { bytes: 'ls\r' }, f.ports)).toEqual({
            delivered: true,
            submitted: true,
        });
        expect(f.writes).toEqual(['ls\r']);
        expect(f.slept).toBe(0);
    });

    it('never sends a bare Enter after a body that did not arrive', async () => {
        // A stray Enter into a half-dead terminal is exactly what the three-valued
        // result warns about; sending one would cause the thing it warns of.
        const f = fake();
        const ports = { ...f.ports, write: () => false };

        expect(await deliverInput('t1', PASTE, ports)).toEqual({
            delivered: false,
            submitted: false,
        });
    });

    it('reports a submit write that the backend refused', async () => {
        // The pty went away between the two writes. Nothing to confirm — it was
        // never sent.
        const f = fake();
        let n = 0;
        const ports = { ...f.ports, write: () => ++n === 1 };

        expect(await deliverInput('t1', PASTE, ports)).toEqual({
            delivered: true,
            submitted: false,
        });
    });
});
