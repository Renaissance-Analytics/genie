import { buildNudgeSequence, type NudgePlan } from './draft';
import type { AgentInboxAgentType } from './types';

/**
 * Carry out one nudge against a terminal — the I/O half of preserve-and-restore
 * (owner, JOB 2). The plan comes from the broker; the pty writes, the keyboard
 * hold and the toast happen here.
 *
 * ## Why this takes its I/O injected
 *
 * It used to live inline in `background.ts`, where nothing could reach it, and
 * the bug it grew was one a test would have caught in a line: `writeToTerminal`
 * returns FALSE when the backend has no pty for that id, and the loop ignored
 * the return value. The `append` toast then fired from the fact that a delivery
 * was ATTEMPTED — announcing "press Enter" over a box nothing had been typed
 * into. The whole point of this module is that {@link deliverNudge} now reports
 * what actually happened, so extracting the seam is the fix, not decoration.
 *
 * ## What it guarantees
 *
 * The keyboard is held for the whole sequence and ALWAYS given back, replaying
 * whatever the person typed meanwhile. Those bytes were taken from them, so they
 * come back even if a write throws — which is why the release sits in `finally`
 * rather than on the happy path. Replaying them last also puts them exactly
 * where they would have landed had no swap happened: after the restored draft.
 *
 * Note the OS clipboard is never touched. Cutting with Ctrl-A/Ctrl-K and pasting
 * back with bracketed paste keeps the whole round-trip inside the terminal, so
 * there is nothing of the user's to save or clobber in the first place.
 */
export interface NudgeIO {
    /** Write to the pty. FALSE means nothing was written — an id the backend has
     *  no live pty for, or a host client that isn't connected. */
    write(terminalId: string, bytes: string): boolean;
    /** End the keyboard hold; returns everything typed while it was held. */
    releaseHold(terminalId: string): string;
    /** Tell the person a notice is sitting unsent in this terminal's prompt.
     *  `landed` is the TRUTH about the writes, not the intent. */
    announce(terminalId: string, landed: boolean): void;
    sleep(ms: number): Promise<void>;
}

/**
 * Run `plan` for `text` against `terminalId`. Returns whether every write landed.
 *
 * A failed write does not abort the rest of the sequence: by the time one fails
 * the pty is gone, so there is nothing left to protect, and stopping half way
 * through a swap would be its own kind of mess.
 */
export async function deliverNudge(
    io: NudgeIO,
    terminalId: string,
    text: string,
    plan: NudgePlan,
    agentType: AgentInboxAgentType = 'custom',
): Promise<boolean> {
    let landed = true;
    try {
        for (const w of buildNudgeSequence(plan, text, agentType)) {
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
    if (plan.mode === 'append') {
        // Genie would not touch their draft, so the notice is sitting BEHIND it,
        // unsubmitted — or, when `landed` is false, is not there at all. Tell the
        // person either way: the message DID arrive, and which of the two it is
        // decides whether "press Enter" is true.
        io.announce(terminalId, landed);
    }
    return landed;
}
