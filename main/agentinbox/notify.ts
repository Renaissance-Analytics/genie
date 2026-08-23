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
 * Split a `terminal:write` chunk into the LITERAL bytes (what a person's
 * keypresses put on the wire) and the ESCAPE SEQUENCES around them.
 *
 * This has to be a real parser rather than a regex, because that IPC does not
 * carry keystrokes alone. xterm routes terminal REPLIES through the same
 * `onData` the renderer forwards here — cursor-position and device-status
 * reports, device attributes, focus in/out, window-size reports, OSC colour
 * answers — and Genie itself writes the OSC 52 clipboard response back down it
 * (Terminal.tsx), for a TUI that POLLS the clipboard, as Claude Code does.
 *
 * The regex this replaces only understood CSI with `[0-9;?]` parameters and
 * two-character escapes, so an OSC reply and an SGR mouse report (whose `<`
 * parameter prefix it did not admit) came through as ordinary printable text.
 */
function tokenize(data: string): { literal: string; escapes: string[] } {
    let literal = '';
    const escapes: string[] = [];
    let i = 0;
    while (i < data.length) {
        if (data[i] !== '\x1b') {
            literal += data[i];
            i++;
            continue;
        }
        const start = i;
        const kind = data[i + 1];
        if (kind === '[') {
            let j = i + 2;
            if (data[j] === 'M') {
                // X10 mouse report: ESC [ M then THREE raw bytes, each offset by
                // 32 — so they are themselves printable and must be consumed by
                // count, not by matching a final byte.
                j += 4;
            } else {
                // CSI: parameter bytes 0x30–0x3f (digits, `;`, and the `<`/`=`/
                // `>`/`?` private prefixes), then intermediates 0x20–0x2f, then
                // one final byte 0x40–0x7e.
                while (j < data.length && data[j]! >= '\x30' && data[j]! <= '\x3f') j++;
                while (j < data.length && data[j]! >= '\x20' && data[j]! <= '\x2f') j++;
                if (j < data.length && data[j]! >= '\x40' && data[j]! <= '\x7e') j++;
            }
            i = j;
        } else if (kind && ']P^_X'.includes(kind)) {
            // OSC / DCS / PM / APC / SOS: a string run, closed by BEL or ST.
            let j = i + 2;
            while (j < data.length) {
                if (data[j] === '\x07') {
                    j++;
                    break;
                }
                if (data[j] === '\x1b' && data[j + 1] === '\\') {
                    j += 2;
                    break;
                }
                j++;
            }
            i = j;
        } else if (kind === undefined) {
            i += 1; // a lone ESC (the Escape key)
        } else {
            // Two-character escape: SS3 function keys (ESC O P) carry one more.
            i += kind === 'O' ? 3 : 2;
        }
        escapes.push(data.slice(start, i));
    }
    return { literal, escapes };
}

/** Escape sequences a PERSON produces by pressing a key: cursor/navigation keys
 *  (`ESC [ A`, `ESC [ 3 ~`), SS3 function keys (`ESC O P`), Alt-chords, and a
 *  bare Escape. Deliberately excludes every terminal→host REPORT, which shares
 *  the CSI shape but means "the emulator answered a query": `R` (cursor
 *  position), `n` (device status), `c` (device attributes), `t` (window size),
 *  `I`/`O` (focus), `M`/`m` (mouse), and anything with a private parameter
 *  prefix. */
function isHumanKey(esc: string): boolean {
    if (esc === '\x1b') return true;
    if (/^\x1b\[[0-9;]*[A-HPQS~]$/.test(esc)) return true;
    if (/^\x1bO[A-Z]$/.test(esc)) return true;
    // Alt-<key> arrives as ESC followed by the character itself.
    return /^\x1b[^[\]PQX^_O]$/.test(esc);
}

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
 * counting it would silence notices for anyone whose TUI chatters. Neither do
 * the emulator's own replies — that mistake latched this flag on permanently,
 * because only Enter / Ctrl-C / Ctrl-U clear it and Genie's own injections never
 * travel this path.
 */
export function noteKeystrokes(pendingInput: boolean, data: string): boolean {
    if (!data) return pendingInput;
    // Escapes carry no submit/abort meaning, so drop them BEFORE looking for the
    // last Enter — otherwise a control byte inside a report could "submit".
    const typed = tokenize(data).literal;
    // Only what follows the LAST submit/abort in this chunk can still be in the
    // box — a fast typist (or a paste) can carry both in one write.
    let tail = typed;
    for (let i = typed.length - 1; i >= 0; i--) {
        if (CLEARS_LINE.test(typed[i]!)) {
            tail = typed.slice(i + 1);
            pendingInput = false;
            break;
        }
    }
    // eslint-disable-next-line no-control-regex
    return pendingInput || /[^\x00-\x1f\x7f]/.test(tail);
}

/**
 * Did a PERSON actually touch the keyboard in this chunk?
 *
 * Separate from {@link noteKeystrokes} because the two answer different
 * questions: that one asks "is there a draft in the box", this one asks "is
 * someone mid-thought right now". An arrow key is human input but not a draft;
 * a cursor-position report is neither.
 *
 * The distinction is what keeps a polling TUI from holding the typing window
 * permanently open: `lastUserInputAt` used to be stamped on EVERY write to this
 * IPC, so an emulator answering queries looked exactly like a person typing.
 */
export function containsHumanInput(data: string): boolean {
    if (!data) return false;
    const { literal, escapes } = tokenize(data);
    if (literal.length > 0) return true;
    return escapes.some(isHumanKey);
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
