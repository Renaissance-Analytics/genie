import { PASTE_HEURISTIC_CHARS, PASTE_SUBMIT_DELAY_MS } from '../../main/terminal/keystrokes';

/**
 * The nudge F5 types into the focused agent's terminal (Tynn story #246).
 *
 * The problem it solves is structural, not occasional: an agent that asks its
 * question in PLAINTEXT has asked nobody. The user is in another terminal, another
 * workspace, or another app — Genie hosts many at once — so the question sits
 * unseen and the work stalls until someone happens to look. `ForceTheQuestion`
 * exists for exactly this and puts an OS-level modal in front of the user, but an
 * agent that has already asked in plaintext needs telling.
 *
 * So F5 is "you asked into the void — ask again properly", delivered as one
 * keypress from the terminal the user is already looking at.
 *
 * WORDING: an instruction, not a hint. "Maybe use FTQ?" invites an agent to
 * acknowledge and carry on; naming the tool and the action gets it re-asked. It
 * also says what the re-ask is FOR — the user wants to understand what the agent
 * needs, which is the thing a plaintext question failed to deliver.
 */
export const FTQ_NUDGE_TEXT = 'Use ForceTheQuestion to help me understand what you need';

/**
 * Carriage return — what a TUI reads as "submit", not a newline.
 *
 * Built from its char code rather than written as an escape: this file has been
 * rewritten by tooling twice, each time turning the escape into a LITERAL control
 * character in the source. Same value at runtime, but a bare CR in a file is
 * invisible in review and one `git config autocrlf` away from becoming a newline —
 * which would silently turn every nudge into "typed but never submitted".
 */
const CR = String.fromCharCode(13);

/** How to write a nudge so it actually starts a turn. */
export interface NudgeDeliveryPlan {
    /** The bytes to write first. Carries the CR only when it can ride inline. */
    body: string;
    /** True when the CR must be a SECOND write, after `delayMs`. */
    submitSeparately: boolean;
    /** The submit keystroke, for the separate write. */
    submit: string;
    /** How long to wait before the separate submit. */
    delayMs: number;
}

/**
 * Decide how to deliver a nudge.
 *
 * Agent TUIs treat bulk input as a PASTE, and in paste mode a trailing CR lands
 * in the buffer as a newline instead of submitting (genie#218) — leaving the
 * prompt parked with text in it and no turn started, which is silent and looks
 * exactly like the agent ignoring you.
 *
 * This file used to solve that by keeping the text SHORT: under
 * `PASTE_HEURISTIC_CHARS`, one write with an inline CR is safe. That worked, but
 * it put a 48-character ceiling on what the nudge could SAY, and the wording the
 * owner asked for is 56. Shortening the words to fit the transport is the wrong
 * way round when the transport can simply be fixed — main's write path already
 * splits the submit for long input, and this does the same on the renderer side.
 *
 * So length is no longer a constraint on the copy. The threshold is still
 * honoured, and still mirrors main's constant rather than guessing at one.
 *
 * PURE: the decision is testable without a terminal.
 */
export function ftqNudgeDelivery(text: string = FTQ_NUDGE_TEXT): NudgeDeliveryPlan {
    const body = text.replace(/\r?\n$/, '');
    const submitSeparately = body.length > PASTE_HEURISTIC_CHARS;
    return {
        body: submitSeparately ? body : body + CR,
        submitSeparately,
        submit: CR,
        delayMs: PASTE_SUBMIT_DELAY_MS,
    };
}
