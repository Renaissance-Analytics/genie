/**
 * Holding a terminal's HUMAN keystrokes while Genie swaps the draft out of its
 * input box — the race guard for preserve-and-restore (owner, JOB 2).
 *
 * Delivering a notice to a box that already has a half-written prompt in it
 * means cutting that draft out, injecting, and putting it back. That is several
 * pty writes with a settle delay between them, so it spans roughly 100–300ms —
 * and a keystroke landing in the middle of it would be swept into the cut,
 * interleaved with the nudge, or simply lost. The owner's call was to buffer
 * those keystrokes and replay them once the draft is back.
 *
 * ## Everything here fails OPEN
 *
 * The one outcome worse than a messy swap is a hold that outlives its swap and
 * silently eats someone's typing — a dead keyboard with no error and nothing to
 * prompt anyone to look. So every limit stops holding and lets keystrokes
 * through rather than keeping them, and buffered bytes are always replayable:
 * they were taken from a person and must come back.
 *
 * Pure (no pty, no electron, no timers) so every branch is unit-tested; the
 * caller does the actual write and owns the watchdog timer.
 */

/** How long a swap may hold the keyboard before it is presumed dead. Comfortably
 *  past a normal swap (~100–300ms) and still short enough that a wedged one is a
 *  hiccup rather than a broken terminal. */
export const HOLD_MAX_MS = 3_000;

/** How much typing a swap may buffer before it stops holding. A swap should
 *  capture a few characters; anything approaching a paste means something has
 *  gone wrong and the person should be talking to their terminal, not to us. */
export const HOLD_MAX_BYTES = 4_096;

interface Hold {
    /** Keystrokes taken from the person, awaiting replay. */
    buffer: string;
    /** When the swap began (epoch ms), for the watchdog. */
    beganAt: number;
    /** Still CAPTURING. Goes false when a limit trips; the hold stays registered
     *  either way, until the swap that owns it releases. */
    capturing: boolean;
}

/**
 * Per-terminal keystroke holds. One swap at a time per terminal: a second
 * notice arriving mid-swap is refused rather than allowed to swap the same box
 * twice.
 *
 * Note the two states are deliberately distinct. A hold that hits a limit stops
 * CAPTURING but stays REGISTERED until its swap releases it. Deregistering there
 * would let a second swap `begin` on a terminal whose first is still running —
 * the very thing `begin` exists to prevent — and that second release would then
 * hand back its own buffer while discarding the bytes the first had already
 * taken from the person.
 */
export class InputHolds {
    private holds = new Map<string, Hold>();

    /** Start holding this terminal's keystrokes. False when a swap is already
     *  running there — the caller must not start a second one. */
    begin(terminalId: string, now: number): boolean {
        if (this.holds.has(terminalId)) return false;
        this.holds.set(terminalId, { buffer: '', beganAt: now, capturing: true });
        return true;
    }

    /** Whether this terminal's keystrokes are currently being captured. */
    isHeld(terminalId: string): boolean {
        return this.holds.get(terminalId)?.capturing ?? false;
    }

    /**
     * Offer one chunk of human keystrokes to the hold. Returns true when it was
     * BUFFERED — the caller must not write it to the pty — and false when it
     * should go straight through.
     *
     * Both limits stop capture for the rest of the swap rather than declining
     * this chunk alone: resuming later would interleave the person's typing out
     * of order.
     */
    hold(terminalId: string, data: string, now: number): boolean {
        const h = this.holds.get(terminalId);
        if (!h || !h.capturing) return false;
        // Presumed-dead swap, or an implausible amount of typing: let the person
        // talk to their terminal again. What was already taken is still owed back.
        if (now - h.beganAt > HOLD_MAX_MS || h.buffer.length >= HOLD_MAX_BYTES) {
            h.capturing = false;
            return false;
        }
        h.buffer += data;
        return true;
    }

    /** End the hold and return the keystrokes to replay, in the order typed. */
    release(terminalId: string): string {
        const h = this.holds.get(terminalId);
        this.holds.delete(terminalId);
        return h?.buffer ?? '';
    }
}
