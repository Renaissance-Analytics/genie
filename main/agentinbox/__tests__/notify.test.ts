import { describe, expect, it } from 'vitest';
import {
    TYPING_QUIET_MS,
    inboxNoticeText,
    containsHumanInput,
    noteKeystrokes,
    shouldNotifyNow,
    type TypingState,
} from '../notify';

/**
 * IMMEDIATE inbox notices (owner, beta.248). Wake-on-DM only ever nudged a
 * PROVABLY IDLE agent, so a message sent to a working agent sat unseen until its
 * turn ended. The owner's call: tell the agent AS SOON AS the message lands —
 * a TUI queues text typed mid-turn, which is exactly how a human interjects.
 *
 * The one thing that must never happen is clobbering the HUMAN's own draft: if
 * they are typing at that terminal, or have text sitting in the box, the notice
 * waits. So the idle gate is replaced by a TYPING gate, not removed.
 */

const state = (over: Partial<TypingState> = {}): TypingState => ({
    pendingInput: false,
    lastUserInputAt: null,
    now: 1_000_000,
    ...over,
});

describe('shouldNotifyNow', () => {
    it('notifies immediately when the box is empty and nobody is typing', () => {
        // The point of the change: no idle requirement. A mid-turn agent gets the
        // notice queued, the way a human interjection is queued.
        expect(shouldNotifyNow(state())).toBe(true);
    });

    it('holds off while the human has text in the box', () => {
        // Injecting now would land in the middle of their half-written prompt.
        expect(shouldNotifyNow(state({ pendingInput: true }))).toBe(false);
    });

    it('holds off while the human is actively typing, even with an empty box', () => {
        // Mid-keystroke: they submitted a moment ago and are still going.
        expect(
            shouldNotifyNow(state({ lastUserInputAt: 1_000_000 - (TYPING_QUIET_MS - 1) })),
        ).toBe(false);
    });

    it('notifies once typing has gone quiet', () => {
        expect(
            shouldNotifyNow(state({ lastUserInputAt: 1_000_000 - (TYPING_QUIET_MS + 1) })),
        ).toBe(true);
    });

    it('still holds off for a stale keystroke if a draft is sitting there', () => {
        // Typed something an hour ago and walked away — the draft is still in the
        // box, so injecting still clobbers it.
        expect(shouldNotifyNow(state({ pendingInput: true, lastUserInputAt: 0 }))).toBe(false);
    });
});

describe('inboxNoticeText', () => {
    it('tells the agent a normal DM can wait until it is free', () => {
        const text = inboxNoticeText({ from: 'guardian', priority: 'normal' });
        expect(text).toContain('guardian');
        expect(text).toMatch(/not urgent|not important/i);
        expect(text).toMatch(/when you (are|'re) not busy/i);
        // It must be actionable — an agent told about a message with no way to
        // read it is just noise.
        expect(text).toContain('agentinbox');
    });

    it('tells the agent a HIGH-priority DM needs looking at now', () => {
        const text = inboxNoticeText({ from: 'guardian', priority: 'high' });
        expect(text).toMatch(/immediately|right away/i);
        expect(text).not.toMatch(/when you (are|'re) not busy/i);
        expect(text).toContain('agentinbox');
    });

    it('names the channel when the message was posted to one', () => {
        const text = inboxNoticeText({ from: 'guardian', channel: 'ops', priority: 'normal' });
        expect(text).toContain('ops');
        expect(text).toMatch(/channel/i);
    });

    it('is self-describing, so a turn it starts is obviously a Genie notice', () => {
        // Same rule as the wake nudge: never look like smuggled instructions.
        expect(inboxNoticeText({ from: 'x', priority: 'high' })).toMatch(/agentinbox/i);
    });
});

/**
 * Tracking the human's DRAFT from their keystrokes. Conservative by design: the
 * cost of thinking there IS a draft is a delayed notice (harmless — the message
 * is in the inbox either way); the cost of thinking there ISN'T is splicing
 * Genie's text into someone's half-written prompt and submitting it.
 */
describe('noteKeystrokes', () => {
    it('a printable keystroke starts a draft', () => {
        expect(noteKeystrokes(false, 'h')).toBe(true);
    });

    it('typing more keeps the draft', () => {
        expect(noteKeystrokes(true, 'ello')).toBe(true);
    });

    it('Enter submits, clearing the draft', () => {
        expect(noteKeystrokes(true, '\r')).toBe(false);
    });

    it('text typed AFTER the Enter in one chunk is a new draft', () => {
        // A paste, or a fast typist inside one IPC chunk.
        expect(noteKeystrokes(false, 'run it\rnext thing')).toBe(true);
    });

    it('a chunk ending in Enter leaves nothing pending', () => {
        expect(noteKeystrokes(false, 'run it\r')).toBe(false);
    });

    it('Ctrl-C abandons the line', () => {
        expect(noteKeystrokes(true, '\x03')).toBe(false);
    });

    it('Ctrl-U (kill line) clears the draft', () => {
        expect(noteKeystrokes(true, '\x15')).toBe(false);
    });

    it('arrow keys and other escape sequences do not START a draft on their own', () => {
        // Navigating history/panes is not composing a prompt; treating every
        // cursor key as a draft would silence notices for a browsing user.
        expect(noteKeystrokes(false, '\x1b[A')).toBe(false);
    });

    it('a bare control byte does not start a draft', () => {
        expect(noteKeystrokes(false, '\t')).toBe(false);
    });
});

/**
 * REGRESSION — the `terminal:write` IPC is NOT "what a human typed".
 *
 * xterm emits terminal REPLIES through the same `onData` the renderer forwards
 * to `terminal:write`: cursor-position and device-status reports, device
 * attributes, focus in/out, window-size reports, OSC colour answers — and,
 * decisively, Genie's OWN OSC 52 clipboard response, which Terminal.tsx writes
 * back with `api().terminal.write(id, "\x1b]" + body + "\x07")`. Genie's code
 * comment there records that Claude Code POLLS the clipboard over OSC 52.
 *
 * `noteKeystrokes` only understood CSI (`\x1b[…`) and two-character escapes, so
 * an OSC reply survived stripping as printable text and latched `pendingInput`
 * true. Nothing clears that flag except Enter / Ctrl-C / Ctrl-U arriving on the
 * same IPC — and Genie's own injections never do — so the draft guard jammed on
 * and immediate notices stopped firing for that agent, permanently.
 */
describe('noteKeystrokes — terminal REPLIES are not a human draft', () => {
    it("an OSC 52 clipboard reply (Genie's own answer to a polling TUI) is not a draft", () => {
        expect(noteKeystrokes(false, '\x1b]52;c;SGVsbG8gd29ybGQ=\x07')).toBe(false);
    });

    it('an OSC reply terminated by ST rather than BEL is not a draft', () => {
        expect(noteKeystrokes(false, '\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\x5c')).toBe(false);
    });

    it('an SGR mouse report is not a draft', () => {
        // `\x1b[<35;40;12M` — the `<` is a CSI parameter-prefix byte, which the old
        // `[0-9;?]` character class did not admit, so the whole report survived.
        expect(noteKeystrokes(false, '\x1b[<35;40;12M')).toBe(false);
    });

    it('an X10 mouse report is not a draft', () => {
        // `\x1b[M` followed by three RAW bytes that are themselves printable.
        expect(noteKeystrokes(false, '\x1b[M !!')).toBe(false);
    });

    it('a cursor-position report is not a draft', () => {
        expect(noteKeystrokes(false, '\x1b[38;1R')).toBe(false);
    });

    it('a device-attributes reply is not a draft', () => {
        expect(noteKeystrokes(false, '\x1b[>0;276;0c')).toBe(false);
    });

    it('a device-status-report OK is not a draft', () => {
        expect(noteKeystrokes(false, '\x1b[0n')).toBe(false);
    });

    it('focus in / focus out reports are not a draft', () => {
        expect(noteKeystrokes(false, '\x1b[I')).toBe(false);
        expect(noteKeystrokes(false, '\x1b[O')).toBe(false);
    });

    it('a window-size report is not a draft', () => {
        expect(noteKeystrokes(false, '\x1b[6;24;80t')).toBe(false);
    });

    it('a real paste still counts as a draft, brackets and all', () => {
        // The guard must keep working for what it was built for.
        expect(noteKeystrokes(false, '\x1b[200~deploy the thing\x1b[201~')).toBe(true);
    });

    it('a reply arriving mid-draft does not CLEAR an existing draft', () => {
        expect(noteKeystrokes(true, '\x1b]52;c;SGVsbG8=\x07')).toBe(true);
    });
});

/**
 * The other half of the same defect: `noteUserInput` stamped `lastUserInputAt`
 * on every `terminal:write`, so a polling TUI's replies kept the "human is
 * typing" window permanently fresh even with the draft flag correct.
 */
describe('containsHumanInput — did a person actually touch the keyboard?', () => {
    it('a keystroke is human input', () => {
        expect(containsHumanInput('h')).toBe(true);
    });

    it('Enter is human input', () => {
        expect(containsHumanInput('\r')).toBe(true);
    });

    it('an arrow key is human input', () => {
        // Navigating history is not a DRAFT, but it IS a person at the keyboard.
        expect(containsHumanInput('\x1b[A')).toBe(true);
    });

    it('an OSC 52 clipboard reply is NOT human input', () => {
        expect(containsHumanInput('\x1b]52;c;SGVsbG8=\x07')).toBe(false);
    });

    it('a cursor-position report is NOT human input', () => {
        expect(containsHumanInput('\x1b[38;1R')).toBe(false);
    });

    it('a focus in/out report is NOT human input', () => {
        expect(containsHumanInput('\x1b[I')).toBe(false);
    });

    it('a device-attributes reply is NOT human input', () => {
        expect(containsHumanInput('\x1b[>0;276;0c')).toBe(false);
    });

    it('an empty chunk is not human input', () => {
        expect(containsHumanInput('')).toBe(false);
    });
});
