import { buildNudgeSequence, type NudgePlan } from './draft';

/**
 * Carry out one approved nudge against a terminal. The broker only calls this
 * when the prompt is known empty or the user releases a queued nudge.
 *
 * ## Why this takes its I/O injected
 *
 * `writeToTerminal` returns FALSE when the backend has no pty for that id. This
 * seam preserves that result so a failed delivery never looks successful.
 *
 * ## What it guarantees
 *
 * The keyboard is held for the short approved-submit sequence and ALWAYS given
 * back, replaying anything typed during that settle window.
 */
export interface NudgeIO {
    /** Write to the pty. FALSE means nothing was written — an id the backend has
     *  no live pty for, or a host client that isn't connected. */
    write(terminalId: string, bytes: string): boolean;
    /** End the keyboard hold; returns everything typed while it was held. */
    releaseHold(terminalId: string): string;
    sleep(ms: number): Promise<void>;
}

/**
 * Run `plan` for `text` against `terminalId`. Returns whether every write landed.
 *
 * A failed write does not abort the rest of the sequence: by the time one fails
 * the pty is gone, so there is nothing left to protect.
 */
export async function deliverNudge(
    io: NudgeIO,
    terminalId: string,
    text: string,
    plan: NudgePlan,
): Promise<boolean> {
    let landed = true;
    try {
        for (const w of buildNudgeSequence(plan, text)) {
            if (w.delayMs > 0) await io.sleep(w.delayMs);
            if (!io.write(terminalId, w.bytes)) landed = false;
        }
    } catch {
        // The message is in the inbox regardless — but whatever is in that box
        // now is NOT what was planned, and saying otherwise is the bug above.
        landed = false;
    } finally {
        // Guarded, because this is a `finally`: a throw here would escape the
        // function, skipping the toast below AND rejecting a promise the caller
        // discards with `void`. Losing the notice entirely is strictly worse than
        // the failure that caused it, and the hold must come off regardless.
        try {
            const replay = io.releaseHold(terminalId);
            if (replay) io.write(terminalId, replay);
        } catch {
            /* the keystrokes are lost with the pty that was to receive them */
        }
    }
    return landed;
}
