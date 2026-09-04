import { describe, expect, it } from 'vitest';
import { containsHumanInput, inboxNoticeText, tokenize } from '../notify';

/**
 * Reading the human keystroke path correctly.
 *
 * `terminal:write` is NOT "what a human typed". xterm routes terminal REPLIES
 * through the same `onData` the renderer forwards — cursor-position and
 * device-status reports, device attributes, focus in/out, window-size reports,
 * OSC colour answers — and Genie itself writes the OSC 52 clipboard response
 * back down it, for a TUI that POLLS the clipboard, as Claude Code does and as
 * Terminal.tsx's own comment records.
 *
 * Mistaking those replies for typing is what silently killed the immediate
 * notice: the old regex understood only CSI with `[0-9;?]` parameters and
 * two-character escapes, so an OSC reply and an SGR mouse report (whose `<`
 * parameter prefix that class did not admit) survived as printable text and
 * latched the draft guard on permanently.
 */
describe('tokenize — separating what a person typed from what the emulator said', () => {
    const literal = (s: string) => tokenize(s).literal;

    it('plain typing is all literal', () => {
        expect(literal('hello')).toBe('hello');
    });

    it("an OSC 52 clipboard reply — Genie's own answer to a polling TUI — is not typing", () => {
        expect(literal('\x1b]52;c;SGVsbG8gd29ybGQ=\x07')).toBe('');
    });

    it('an OSC reply terminated by ST rather than BEL is not typing', () => {
        expect(literal('\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\x5c')).toBe('');
    });

    it('an SGR mouse report is not typing', () => {
        // The `<` is a CSI parameter-PREFIX byte, which the old `[0-9;?]`
        // character class did not admit, so the whole report survived.
        expect(literal('\x1b[<35;40;12M')).toBe('');
    });

    it('an X10 mouse report is not typing, despite its printable payload', () => {
        // `ESC [ M` then THREE raw bytes, each offset by 32 — so they look like
        // ordinary characters and must be consumed by count.
        expect(literal('\x1b[M !!')).toBe('');
    });

    it('a cursor-position report is not typing', () => {
        expect(literal('\x1b[38;1R')).toBe('');
    });

    it('a device-attributes reply is not typing', () => {
        expect(literal('\x1b[>0;276;0c')).toBe('');
        expect(literal('\x1b[?1;2c')).toBe('');
    });

    it('a device-status-report OK is not typing', () => {
        expect(literal('\x1b[0n')).toBe('');
    });

    it('focus in / focus out reports are not typing', () => {
        expect(literal('\x1b[I')).toBe('');
        expect(literal('\x1b[O')).toBe('');
    });

    it('a window-size report is not typing', () => {
        expect(literal('\x1b[6;24;80t')).toBe('');
    });

    it('an arrow key is an escape, not literal text', () => {
        expect(literal('\x1b[A')).toBe('');
        expect(tokenize('\x1b[A').escapes).toEqual(['\x1b[A']);
    });

    it('the body of a bracketed paste survives; the markers do not', () => {
        expect(literal('\x1b[200~deploy the thing\x1b[201~')).toBe('deploy the thing');
    });

    it('typing mixed in among replies is still recovered', () => {
        expect(literal('\x1b[38;1Rab\x1b[Ic')).toBe('abc');
    });
});

/**
 * Whether a PERSON touched the keyboard — a different question from "what is in
 * the box". An arrow key is human input but not a draft; a cursor-position
 * report is neither.
 *
 * `lastUserInputAt` used to be stamped on EVERY write to this IPC, so an
 * emulator answering queries looked exactly like someone typing and held the
 * "they are mid-thought" window permanently open.
 */
describe('containsHumanInput', () => {
    it('a keystroke is human input', () => {
        expect(containsHumanInput('h')).toBe(true);
    });

    it('Enter is human input', () => {
        expect(containsHumanInput('\r')).toBe(true);
    });

    it('an arrow key is human input', () => {
        expect(containsHumanInput('\x1b[A')).toBe(true);
    });

    it('a function key is human input', () => {
        expect(containsHumanInput('\x1bOP')).toBe(true);
    });

    it('an OSC 52 clipboard reply is NOT human input', () => {
        expect(containsHumanInput('\x1b]52;c;SGVsbG8=\x07')).toBe(false);
    });

    it('a cursor-position report is NOT human input', () => {
        expect(containsHumanInput('\x1b[38;1R')).toBe(false);
    });

    it('a focus in/out report is NOT human input', () => {
        expect(containsHumanInput('\x1b[I')).toBe(false);
        expect(containsHumanInput('\x1b[O')).toBe(false);
    });

    it('a device-attributes reply is NOT human input', () => {
        expect(containsHumanInput('\x1b[>0;276;0c')).toBe(false);
    });

    it('a mouse report is NOT human input', () => {
        expect(containsHumanInput('\x1b[<35;40;12M')).toBe(false);
    });

    it('an empty chunk is not human input', () => {
        expect(containsHumanInput('')).toBe(false);
    });
});

describe('inboxNoticeText', () => {
    it('names the sender and says it arrived as a DM', () => {
        const text = inboxNoticeText({ from: 'guardian', priority: 'normal', mode: 'manual' });
        expect(text).toContain('guardian');
        expect(text).toContain('as a DM');
        expect(text).toContain('[Genie]');
    });

    it('a high-priority notice says to check it immediately', () => {
        const text = inboxNoticeText({ from: 'guardian', priority: 'high', mode: 'manual' });
        expect(text).toMatch(/HIGH PRIORITY/);
        expect(text).toMatch(/immediately/i);
    });

    it('a normal notice says it can wait until the agent is free', () => {
        const text = inboxNoticeText({ from: 'guardian', priority: 'normal', mode: 'manual' });
        expect(text).toMatch(/not urgent/i);
        expect(text).toMatch(/when you are not busy/i);
    });

    it('a channel post names the channel instead', () => {
        const text = inboxNoticeText({ from: 'guardian', channel: 'ops', priority: 'normal', mode: 'manual' });
        expect(text).toContain('#ops');
        expect(text).toContain('channel');
    });

    it('always says HOW to read it — mail with no instructions is just noise', () => {
        expect(inboxNoticeText({ from: 'x', priority: 'high', mode: 'manual' })).toMatch(/agentinbox/i);
        expect(inboxNoticeText({ from: 'x', priority: 'high', mode: 'manual' })).toMatch(/receive/);
    });
});
