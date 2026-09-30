/**
 * Deliver resolved input to a pty, and report what actually happened.
 *
 * A multi-line prompt goes as a bracketed paste with the submitting Enter as a
 * SEPARATE write, so the Enter cannot race the TUI leaving paste mode (issue #8).
 * That second write went out on a fixed 60ms timer, and the result said
 * `submitted: true` whenever the BYTE reached the pty.
 *
 * Both halves failed together on a freshly-restarted Codex. It was still coming
 * up 60ms after the paste, the Enter reached a TUI that was not listening yet,
 * the prompt sat in the composer as `[Pasted Content 1270 chars]` — and the call
 * reported success, so nothing downstream knew the agent had not taken a turn.
 * Four times in one session; each time the repair was a bare Enter afterwards.
 *
 * Two changes, in causal order:
 *
 *  - **Wait for quiet.** A terminal still emitting is still working through what
 *    it was given. Submitting into that is the race the split write exists to
 *    avoid, reintroduced by using a stopwatch instead of a signal. Capped, so a
 *    terminal that never stops talking still gets its Enter.
 *  - **Confirm.** After the Enter, look for a reaction. Any keypress redraws
 *    something in a TUI and echoes in a shell, so silence is strong evidence the
 *    Enter was ignored.
 *
 * WHAT THIS DOES NOT CLAIM. Genie cannot see inside a TUI; it sees bytes. Output
 * after an Enter is evidence, not proof — and the UNOBSERVABLE case is never
 * reported as failure. With no output history for a terminal, confirmation is
 * skipped and the byte-level answer stands: "we could not check" must not become
 * "it failed", or callers re-send prompts that already ran.
 *
 * A Codex that is BUSY answers correctly by construction: it renders "Message
 * will be submitted after next tool call", which is output, so the Enter is
 * reported as landed — which it did. Queued is not lost.
 */

/** Longest we will wait for a terminal to go quiet before submitting anyway. */
export const SETTLE_CAP_MS = 750;
/** Quiet for this long ⇒ the TUI has finished ingesting the paste. */
export const SETTLE_QUIET_MS = 60;
/** How long a reaction to the Enter may take before we call it unsubmitted. */
export const CONFIRM_MS = 250;
/** Granularity of the settle poll. */
const STEP_MS = 30;

/** What actually reached the pty. */
export interface TerminalInputDelivery {
    /** The BODY write landed. False means nothing was sent at all. */
    delivered: boolean;
    /** The submit landed AND the terminal reacted (or could not be observed). */
    submitted: boolean;
}

/** The I/O this needs, injected so the decision is testable without a pty. */
export interface SubmitPorts {
    write(id: string, data: string): boolean;
    /** When this terminal last produced output, or null when none is held. */
    lastOutputAt(id: string): number | null;
    sleep(ms: number): Promise<void>;
}

export async function deliverInput(
    id: string,
    built: { bytes: string; submitAfter?: string },
    ports: SubmitPorts,
): Promise<TerminalInputDelivery> {
    const delivered = ports.write(id, built.bytes);
    // A single-line submit carries its CR inline: one write, no race to lose.
    if (!built.submitAfter) return { delivered, submitted: delivered };
    // Nothing to submit if the body never arrived — and a bare CR into a
    // half-dead terminal is exactly the stray Enter this warns callers about.
    if (!delivered) return { delivered: false, submitted: false };

    await settle(id, ports);

    const before = ports.lastOutputAt(id);
    if (!ports.write(id, built.submitAfter)) return { delivered: true, submitted: false };

    // Nothing held for this terminal ⇒ nothing to compare against. Report the
    // write, as before, rather than inventing a failure.
    if (before === null) return { delivered: true, submitted: true };

    await ports.sleep(CONFIRM_MS);
    const after = ports.lastOutputAt(id);
    return { delivered: true, submitted: after !== null && after !== before };
}

/**
 * Wait until the terminal has been quiet for {@link SETTLE_QUIET_MS}, or until
 * {@link SETTLE_CAP_MS} runs out.
 *
 * The cap is not a fallback, it is the answer for a whole class of terminal: a
 * tail, a spinner, a progress bar never goes quiet, and waiting forever would be
 * a worse failure than submitting into noise.
 */
async function settle(id: string, ports: SubmitPorts): Promise<void> {
    let waited = 0;
    let quiet = 0;
    let seen = ports.lastOutputAt(id);
    while (waited < SETTLE_CAP_MS && quiet < SETTLE_QUIET_MS) {
        await ports.sleep(STEP_MS);
        waited += STEP_MS;
        const now = ports.lastOutputAt(id);
        if (now !== seen) {
            seen = now;
            quiet = 0; // still talking — start the quiet count again
        } else {
            quiet += STEP_MS;
        }
    }
}
