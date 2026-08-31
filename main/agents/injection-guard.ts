/**
 * Never type into a terminal that is waiting on something other than a prompt.
 *
 * SILENCE IS NOT IDLENESS. A TUI parked on its own modal produces no output at
 * all, so every silence-based idle check in `./wake` says "safe to inject". It
 * is the opposite of safe: the text lands as an answer to a question nobody
 * meant to answer. The case that prompted this was Codex's update prompt —
 *
 *     ✨ Update available! 0.150.1 -> 0.151.0
 *     1. Update now (runs `npm install -g @openai/codex`)
 *     2. Skip
 *     3. Skip until next version
 *     Press enter to continue
 *
 * — where a stray keystroke picks option 1 and starts a global install.
 *
 * This is a VETO, not a permission: it runs in addition to the idle checks,
 * never instead of them. It cannot be perfect, because a TUI can render
 * anything, and it does not need to be. Being wrong defers a nudge, which is
 * cheap and self-correcting. Being wrong the other way answers a modal on the
 * user's behalf, which is neither.
 *
 * WHAT THIS IS NOT. The Codex agent's verdict on it, and it is right: matching
 * strings is not a safe ROOT fix. Wording changes, ANSI and layout change, and
 * an approval prompt contains dynamic command text no pattern anticipates. The
 * root fix is to inject only when the harness's own transport reports an input
 * state that accepts a submitted message, and to DEFER otherwise — never to
 * infer idleness from silence.
 *
 * So this is a stopgap that narrows a known hazard, kept because it costs
 * nothing and catches the case that was actually observed. It is not the
 * reason it is safe to type into a terminal. For CODEX, which parks on
 * key-driven modals constantly, Genie does not type at all -- see
 * ./mcp-reconnect, where its repair is an out-of-band restart.
 *
 * PURE.
 */

/** How much of the tail to inspect. A prompt answered ten minutes ago is
 *  history; only what the terminal is showing NOW can be blocking it. */
const TAIL_LINES = 12;

const PATTERNS: RegExp[] = [
    // "Press enter to continue", "hit any key" — an explicit wait for a keypress.
    /^\s*(press|hit)\s+(enter|return|any key)\b/i,
    // A numbered choice list: "1. Update now" / "2) Skip".
    /^\s*\d+[.)]\s+\S/,
    // "(y/N)", "[Y/n]", "yes/no" — a confirmation.
    /\((y|yes)\s*\/\s*(n|no)\)\s*[:?]?\s*$/i,
    /\[(y|yes)\s*\/\s*(n|no)\]\s*[:?]?\s*$/i,
    // A secret being asked for. Typing a nudge here SENDS it as the password.
    /\b(password|passphrase)\b[^\n]*:\s*$/i,
];

/**
 * Does the terminal's recent output look like it is waiting on a keypress?
 *
 * Fails OPEN — an unreadable buffer is treated as not blocked — because the
 * idle checks are the real safety and making this fail closed would silence
 * every nudge whenever scrollback could not be read.
 */
export function terminalIsBlocked(recentOutput: string | null | undefined): boolean {
    if (!recentOutput) return false;

    // Only the tail, and only whole lines. Matching mid-paragraph is how prose
    // about tooling ("the installer asks you to press enter to continue") would
    // veto a perfectly good prompt — and agents discuss their own tooling
    // constantly.
    const lines = recentOutput
        .split(/\r?\n/)
        .slice(-TAIL_LINES)
        .map((line) => line.replace(/\[[0-9;?]*[A-Za-z]/g, '').trimEnd())
        .filter((line) => line.trim().length > 0);

    return lines.some((line) => PATTERNS.some((pattern) => pattern.test(line)));
}
