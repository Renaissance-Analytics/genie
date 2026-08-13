/**
 * IMMEDIATE inbox notices — the PURE core (owner call, beta.248).
 *
 * ## Why this replaces the idle gate
 *
 * Wake-on-DM ({@link import('./wake')}) only ever nudged a PROVABLY IDLE agent,
 * because injecting into a live pty was assumed to corrupt the turn. For an
 * agent TUI that assumption is wrong in the useful direction: text arriving
 * mid-turn is QUEUED and shown to the agent at the next opportunity — it is
 * exactly the mechanism by which a human interjects while an agent works. So a
 * message can be announced the moment it lands, instead of waiting for a turn to
 * end (which, for a busy agent, could be a very long time — the whole complaint).
 *
 * ## What replaces it: the HUMAN's draft
 *
 * The one thing that must never happen is stepping on the person at the
 * keyboard. Injecting while they have a half-written prompt in the box would
 * splice Genie's text into their sentence and, worse, submit it. So the gate is
 * no longer "is the AGENT idle" but "is the HUMAN mid-thought at this terminal":
 *
 *   - text already in the box (typed since the last submit) → hold;
 *   - a keystroke within {@link TYPING_QUIET_MS} → hold;
 *   - otherwise → notify now, mid-turn or not.
 *
 * Both signals come from the human keystroke path (`terminal:write` from a
 * renderer), which is distinguishable from Genie's own injection
 * (`writeToTerminal`) — so the guard reads real typing, not our own bytes.
 *
 * Holding is safe: the message is still in the inbox, the MCP stream is still
 * notified, and imDone still carries the count. The notice is an accelerant,
 * never the delivery mechanism.
 */

/** How long after a keystroke the human still counts as "typing". Short enough
 *  to stay responsive, long enough to cover a pause mid-sentence. */
export const TYPING_QUIET_MS = 4_000;

export interface TypingState {
    /** Characters typed into this terminal since the last submit — i.e. a draft
     *  is sitting in the input box. */
    pendingInput: boolean;
    /** Epoch ms of the last human keystroke at this terminal, or null. */
    lastUserInputAt: number | null;
    /** Now (epoch ms). */
    now: number;
}

/**
 * May Genie inject an inbox notice into this terminal RIGHT NOW?
 *
 * Deliberately says nothing about whether the agent is busy — that is the point
 * of the change. It only protects the human's draft.
 */
export function shouldNotifyNow(s: TypingState): boolean {
    // A draft in the box: injecting would splice into their sentence and submit it.
    if (s.pendingInput) return false;
    // Actively typing: the box may be empty this instant, but they are mid-thought.
    if (s.lastUserInputAt != null && s.now - s.lastUserInputAt < TYPING_QUIET_MS) return false;
    return true;
}

/** Bytes that ABANDON or SUBMIT the current line, leaving the box empty:
 *  Enter (CR/LF), Ctrl-C (abort), Ctrl-U (kill line). */
const CLEARS_LINE = /[\r\n\x03\x15]/;

/**
 * Fold one chunk of HUMAN keystrokes into the draft flag.
 *
 * Deliberately crude, and biased the safe way. It cannot track a draft
 * perfectly (backspacing a line back to empty still reads as a draft), and it
 * does not try: over-reporting a draft only DELAYS a notice, while
 * under-reporting it splices text into someone's sentence. So anything
 * printable means "there is something in the box" until the line is submitted
 * or killed.
 *
 * Escape sequences (arrows, function keys, mouse reports) do NOT start a draft:
 * browsing history or moving between panes is not composing a prompt, and
 * counting it would silence notices for anyone whose TUI chatters.
 */
export function noteKeystrokes(pendingInput: boolean, data: string): boolean {
    if (!data) return pendingInput;
    // Only what follows the LAST submit/abort in this chunk can still be in the
    // box — a fast typist (or a paste) can carry both in one write.
    let tail = data;
    for (let i = data.length - 1; i >= 0; i--) {
        if (CLEARS_LINE.test(data[i]!)) {
            tail = data.slice(i + 1);
            pendingInput = false;
            break;
        }
    }
    // Strip escape sequences before asking "did they type anything?".
    const typed = tail.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b./g, '');
    // eslint-disable-next-line no-control-regex
    return pendingInput || /[^\x00-\x1f\x7f]/.test(typed);
}

export interface InboxNotice {
    /** The sender's label. */
    from: string;
    /** Set when the message was posted to a channel rather than DMed. */
    channel?: string;
    /** `high` = the sender marked it urgent (an `interrupt` DM). */
    priority: 'normal' | 'high';
}

/**
 * The notice submitted to the agent's TUI.
 *
 * Self-describing and benign, the same rule the wake nudge follows: a turn this
 * starts must be obviously a Genie AgentInbox notice, never smuggled
 * instructions. It also carries HOW to read the message — telling an agent it
 * has mail without saying how to open it is just noise — and, crucially, how
 * URGENT it is, so a working agent can decide whether to break its flow.
 */
export function inboxNoticeText(n: InboxNotice): string {
    const source = n.channel ? `in the #${n.channel} channel` : 'as a DM';
    const what = `You just received a message from ${n.from} ${source}`;
    const read = 'read it with the agentinbox tool (action: "receive")';
    return n.priority === 'high'
        ? `[Genie] ${what}, marked HIGH PRIORITY — check it immediately: ${read}.`
        : `[Genie] ${what}. It is not urgent — check it when you are not busy: ${read}.`;
}
