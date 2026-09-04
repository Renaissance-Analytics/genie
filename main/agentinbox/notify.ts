/**
 * IMMEDIATE inbox notices — the PURE core (owner call, beta.248, extended for
 * preserve-and-restore in JOB 2).
 *
 * ## What a notice is for
 *
 * Wake-on-DM ({@link import('./wake')}) only ever nudged a PROVABLY IDLE agent,
 * because injecting into a live pty was assumed to corrupt the turn. For an
 * agent TUI that assumption is wrong in the useful direction: text arriving
 * mid-turn is QUEUED and shown to the agent at the next opportunity — it is
 * exactly the mechanism by which a human interjects while an agent works. So a
 * message is announced the moment it lands, instead of waiting for a turn to
 * end (which, for a busy agent, could be a very long time — the whole complaint).
 *
 * ## Reading the human keystroke path correctly
 *
 * A notice must never step on the person at the keyboard, so what is in their
 * input box decides how it may land — see {@link import('./draft')}, which owns
 * that model and the decision.
 *
 * This module owns the layer underneath: turning one `terminal:write` chunk into
 * what a PERSON actually did. That IPC is not keystrokes alone — xterm answers
 * the TUI's queries down it, and Genie writes its own OSC 52 clipboard response
 * back through it — and mistaking those replies for typing is what silently
 * jammed the guard that used to live here.
 */

import { inboxNoticeMode, type AgentMode } from '../agents/agent-mode';

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
export function tokenize(data: string): { literal: string; escapes: string[] } {
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
export function isHumanKey(esc: string): boolean {
    if (esc === '\x1b') return true;
    if (/^\x1b\[[0-9;]*[A-HPQS~]$/.test(esc)) return true;
    if (/^\x1bO[A-Z]$/.test(esc)) return true;
    // Alt-<key> arrives as ESC followed by the character itself.
    return /^\x1b[^[\]PQX^_O]$/.test(esc);
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
    /**
     * Whether this agent is expected to act unattended (genie#408).
     *
     * Required, so a caller cannot forget it and hand a Manual agent an
     * imperative by omission. GUIDANCE only: the notice names the tool and the
     * urgency identically for both modes — a mode that withheld the tool would
     * be a permission boundary, and this is deliberately not one.
     */
    mode: AgentMode;
    /** Set when the message was posted to a channel rather than DMed. */
    channel?: string;
    /** `high` = the sender marked it urgent (an `interrupt` DM). */
    priority: 'normal' | 'high';
    /**
     * `ftq-answer` = the human answering a question THIS agent asked.
     *
     * It used to arrive as an ordinary DM notice — "You just received a message
     * from You as a DM" — which reads as a note the agent sent ITSELF, and is
     * indistinguishable from any other message. An agent could not tell "someone
     * said hello" from "the decision you are blocked on has arrived".
     */
    kind?: 'dm' | 'ftq-answer';
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
    const read = 'read it with the agentinbox tool (action: "receive")';
    // The mode clause CLOSES the notice: it is a rider on what was just said,
    // and putting it first would read as the headline.
    const mode = ` ${inboxNoticeMode(n.mode)}`;
    // An answer to YOUR question is not "a message from you". It is the user
    // unblocking a decision you asked for and are waiting on, and it must be
    // distinguishable at a glance from ordinary mail.
    if (n.kind === 'ftq-answer') {
        const what = 'The user answered a question you asked';
        return n.priority === 'high'
            ? `[Genie] ${what} — it was marked urgent, so read it now: ${read}.${mode}`
            : `[Genie] ${what}: ${read}.${mode}`;
    }
    const source = n.channel ? `in the #${n.channel} channel` : 'as a DM';
    const what = `You just received a message from ${n.from} ${source}`;
    return n.priority === 'high'
        ? `[Genie] ${what}, marked HIGH PRIORITY — check it immediately: ${read}.${mode}`
        : `[Genie] ${what}. It is not urgent — check it when you are not busy: ${read}.${mode}`;
}
