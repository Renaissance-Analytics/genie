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
 * acknowledge and carry on; naming the tool and the action gets it re-asked.
 */
export const FTQ_NUDGE_TEXT = 'Re-ask that using the ForceTheQuestion tool.';

/**
 * The longest a nudge may be before the TUI paste heuristic changes its meaning.
 *
 * Mirrors `PASTE_HEURISTIC_CHARS` in main/terminal/keystrokes.ts. Agent TUIs treat
 * bulk input as a PASTE, and in paste mode a trailing CR lands in the buffer as a
 * newline instead of submitting (genie#218) — so a nudge over this length would be
 * typed into the prompt and just sit there, which looks exactly like the agent
 * ignoring it. Main's write path splits the submit for long input; the renderer
 * writes raw bytes, so it stays short instead.
 */
export const NUDGE_MAX_CHARS = 48;

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

/** The exact bytes to write: the nudge, then the CR that submits it. */
export function ftqNudgeBytes(): string {
    return FTQ_NUDGE_TEXT + CR;
}
