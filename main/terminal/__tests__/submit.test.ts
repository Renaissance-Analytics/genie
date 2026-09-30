import { describe, expect, it } from 'vitest';
import { deliverInput, SETTLE_CAP_MS, SETTLE_QUIET_MS, CONFIRM_MS } from '../submit';

/**
 * SUBMIT WHEN THE TERMINAL IS READY, AND SAY WHAT ACTUALLY HAPPENED.
 *
 * A multi-line prompt is delivered as a bracketed paste, and the Enter that
 * submits it is a SEPARATE write so it cannot race the TUI leaving paste mode
 * (issue #8). That second write went out on a fixed 60ms timer, and the result
 * reported `submitted: true` whenever the BYTE reached the pty.
 *
 * Both halves were wrong in the same situation. A freshly-restarted Codex was
 * still coming up 60ms after the paste; the Enter arrived at a TUI that was not
 * listening yet, the prompt sat in the composer as `[Pasted Content 1270 chars]`,
 * and the call reported success. The agent never took a turn, and the caller had
 * no way to know — I hit this four times in one session and each time the repair
 * was to send a bare Enter afterwards.
 *
 * So: WAIT for the terminal to go quiet before submitting — a TUI that is still
 * emitting is a TUI still working through what it was given — and then CONFIRM
 * that it reacted.
 *
 * ## The rule that keeps this honest
 *
 * Genie cannot see inside a TUI. It can see whether the pty produced anything.
 * "No output at all after an Enter" is strong evidence a TUI ignored it, since
 * any keypress redraws something — but it is evidence, not proof, so the
 * unobservable case is never reported as failure. When there is NO output
 * history for a terminal, confirmation is skipped and the old byte-level answer
 * stands: "we could not check" must not become "it failed".
 */

/** A scripted terminal: records writes, and emits output when told to. */
function fake(opts: { emitsOn?: 'body' | 'submit' | 'both' | 'never'; observable?: boolean } = {}) {
    const emits = opts.emitsOn ?? 'both';
    const writes: string[] = [];
    let clock = 1_000;
    let lastOut: number | null = opts.observable === false ? null : clock;
    let slept = 0;
    return {
        writes,
        get slept() {
            return slept;
        },
        /** How long after the BODY write the submit went out. */
        submitDelay: 0,
        ports: {
            write(_id: string, data: string): boolean {
                writes.push(data);
                const isSubmit = writes.length > 1;
                if (
                    emits === 'both' ||
                    (emits === 'body' && !isSubmit) ||
                    (emits === 'submit' && isSubmit)
                ) {
                    if (opts.observable !== false) lastOut = clock;
                }
                return true;
            },
            lastOutputAt(): number | null {
                return lastOut;
            },
            sleep(ms: number): Promise<void> {
                slept += ms;
                clock += ms;
                return Promise.resolve();
            },
        },
    };
}

const PASTE = { bytes: '\x1b[200~line one\nline two\x1b[201~', submitAfter: '\r' };

describe('it waits for the terminal to stop talking before submitting', () => {
    it('does not send the Enter while output is still arriving', async () => {
        // The reported failure: a TUI still coming up when the timer fired. Each
        // step that sees new output must extend the wait rather than submit into
        // a terminal that is plainly still busy.
        const f = fake({ emitsOn: 'body' });
        let steps = 0;
        const ports = {
            ...f.ports,
            // Output keeps arriving for the first few polls, then stops.
            lastOutputAt: () => (steps++ < 3 ? 1_000 + steps * 100 : 1_400),
        };

        await deliverInput('t1', PASTE, ports);

        expect(f.writes).toHaveLength(2);
        expect(f.slept).toBeGreaterThan(SETTLE_QUIET_MS);
    });

    it('gives up waiting rather than hanging on a terminal that never shuts up', async () => {
        // A tail -f, a spinner, a progress bar. Waiting forever would be a worse
        // failure than submitting into noise, so the settle is capped.
        let t = 1_000;
        const f = fake();
        const ports = { ...f.ports, lastOutputAt: () => (t += 50) };

        await deliverInput('t1', PASTE, ports);

        expect(f.writes).toHaveLength(2);
        expect(f.slept).toBeLessThanOrEqual(SETTLE_CAP_MS + CONFIRM_MS);
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
        // TUI's input box; the caller needs to know that, because the next Enter
        // from any source will send it.
        const f = fake({ emitsOn: 'body' });

        expect(await deliverInput('t1', PASTE, f.ports)).toEqual({
            delivered: true,
            submitted: false,
        });
    });

    it('does not call it a failure when it cannot be observed at all', async () => {
        // No output history for this terminal — a pty that outlived a restart,
        // say. "We could not check" must not be reported as "it failed", or the
        // note tells people to re-send something that already ran.
        const f = fake({ observable: false });

        expect(await deliverInput('t1', PASTE, f.ports)).toEqual({
            delivered: true,
            submitted: true,
        });
    });
});

describe('the cases that never split', () => {
    it('a single-line submit carries its own CR and is not second-guessed', async () => {
        // One write, no race to lose, nothing to confirm.
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
        // result exists to warn about; sending one would cause the thing it warns of.
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
