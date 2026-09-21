/**
 * THE LAST WORDS OF A DEAD PTY, kept where the next one cannot overwrite them
 * (genie#733).
 *
 * `runAgent diagnose` tells whoever is holding a dead agent that **the exit tail
 * is the only evidence of why it went** — and then recommends a restart. Both
 * halves were true and they contradicted each other: the tail lived in the
 * terminal's live read buffer, so the first bytes the replacement pty wrote
 * pushed the dead process's last words out. Anyone who followed the advice lost
 * the evidence by following it.
 *
 * Measured by `claude:fancy` on a real failure: 166 bytes of fresh shell prompt
 * after a pty-exit, with the actual cause — `failed to connect to remote app
 * server … 401 Unauthorized` — only visible because a LATER action happened to
 * reprint it. Had the reattach also exited silently, the cause would have been
 * unavailable entirely. A one-read diagnosis took four steps.
 *
 * ## Why a separate store rather than a bigger buffer
 *
 * Genie already trims the read buffer to a bounded tail on exit (genie#217, the
 * same reasoning). That is right for what it does and cannot solve this: the
 * live buffer belongs to the RUNNING pty, and it must, or a read after a
 * relaunch would serve a mix of two processes' output with no way to tell which
 * line came from which. Keeping the dead one's words somewhere else is what
 * makes both readable.
 *
 * Bounded, and trimmed at the HEAD: a dying process can print a great deal, and
 * what matters is the last thing it said. Replaced rather than appended on a
 * second death, so a crash-looping agent reports why it died THIS time.
 */

/** Same cap as the in-buffer exit trim, for the same reason. */
export const EXIT_TAIL_CAP = 16 * 1024;

export interface RetainedExitTail {
    /** The final output, capped to {@link EXIT_TAIL_CAP} from the END. */
    tail: string;
    /** The pty's exit code, as reported by the backend. */
    exitCode: number;
    /** When it died — so a caller can say whether this is the death it is
     *  looking at or an older one. */
    at: number;
}

const tails = new Map<string, RetainedExitTail>();

/** Record why this terminal's pty ended. Replaces any earlier death. */
export function rememberExitTail(id: string, tail: string, exitCode: number): void {
    if (!id) return;
    tails.set(id, {
        tail: tail.length > EXIT_TAIL_CAP ? tail.slice(-EXIT_TAIL_CAP) : tail,
        exitCode,
        at: Date.now(),
    });
}

/**
 * The retained tail for a terminal, or `undefined` when it has not died here.
 *
 * Deliberately NOT consuming: `diagnose` and a `read` may both want it, and a
 * first reader silently emptying it for the second is the kind of behaviour
 * that makes a diagnostic unreliable in exactly the situation it is for.
 */
export function takeExitTail(id: string): RetainedExitTail | undefined {
    return tails.get(id);
}

/** Drop it — the terminal was really killed, so its spec is gone too. */
export function forgetExitTail(id: string): void {
    tails.delete(id);
}
