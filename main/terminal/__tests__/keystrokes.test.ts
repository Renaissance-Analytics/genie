import { describe, expect, it } from 'vitest';
import {
    buildSubmitBytes,
    isTerminalKey,
    keyBytes,
    resolveTerminalInput,
    stripAnsi,
    CR,
    KEY_SEQUENCES,
} from '../keystrokes';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

describe('buildSubmitBytes', () => {
    it('single-line + submit → text then a CR (no paste wrapper)', () => {
        expect(buildSubmitBytes('npm test', true)).toBe('npm test\r');
        expect(buildSubmitBytes('npm test', true)).not.toContain(PASTE_START);
    });

    it('multi-line + submit → bracketed paste with the CR OUTSIDE the markers', () => {
        const text = 'line one\nline two\nline three';
        const out = buildSubmitBytes(text, true);
        expect(out).toBe(`${PASTE_START}${text}${PASTE_END}${CR}`);
        // The CR is the last byte and sits AFTER the paste-end marker.
        expect(out.endsWith(PASTE_END + '\r')).toBe(true);
        // No phantom newline left inside the paste acting as the submit.
        expect(out.indexOf(PASTE_END)).toBeGreaterThan(out.indexOf(PASTE_START));
    });

    it('submit:false omits the CR (type without running) — single-line', () => {
        const out = buildSubmitBytes('partial', false);
        expect(out).toBe('partial');
        expect(out).not.toContain('\r');
    });

    it('submit:false omits the CR and the paste wrapper — multi-line', () => {
        const text = 'a\nb';
        const out = buildSubmitBytes(text, false);
        expect(out).toBe(text);
        expect(out).not.toContain('\r');
        expect(out).not.toContain(PASTE_START);
    });

    it('strips a single trailing newline so it is not a phantom submit', () => {
        // A lone "foo\n" is still a single-line submit: trailing \n dropped, CR added.
        expect(buildSubmitBytes('foo\n', true)).toBe('foo\r');
        expect(buildSubmitBytes('foo\r\n', true)).toBe('foo\r');
        // A body with an interior newline AND a trailing one → still multi-line.
        const out = buildSubmitBytes('a\nb\n', true);
        expect(out).toBe(`${PASTE_START}a\nb${PASTE_END}${CR}`);
    });

    it('empty text + submit → just a CR (a bare Enter)', () => {
        expect(buildSubmitBytes('', true)).toBe('\r');
    });
});

describe('keys (the escape-hatch allow-list)', () => {
    it('recognises only enter / escape / ctrl-c', () => {
        expect(isTerminalKey('enter')).toBe(true);
        expect(isTerminalKey('escape')).toBe(true);
        expect(isTerminalKey('ctrl-c')).toBe(true);
        expect(isTerminalKey('delete')).toBe(false);
        expect(isTerminalKey('')).toBe(false);
        expect(isTerminalKey('toString')).toBe(false); // not fooled by proto keys
    });

    it('maps each key to its control bytes', () => {
        expect(keyBytes('enter')).toBe('\r');
        expect(keyBytes('escape')).toBe('\x1b');
        expect(keyBytes('ctrl-c')).toBe('\x03');
    });

    it('the allow-list is exactly these three', () => {
        expect(Object.keys(KEY_SEQUENCES).sort()).toEqual(['ctrl-c', 'enter', 'escape']);
    });
});

describe('resolveTerminalInput', () => {
    const bytes = (r: ReturnType<typeof resolveTerminalInput>) =>
        'bytes' in r ? r.bytes : undefined;
    const submitAfter = (r: ReturnType<typeof resolveTerminalInput>) =>
        'bytes' in r ? r.submitAfter : undefined;

    it('default submit → single-line text + CR inline (no separate submit)', () => {
        const r = resolveTerminalInput('npm test', {});
        expect(bytes(r)).toBe('npm test\r');
        expect(submitAfter(r)).toBeUndefined();
    });

    it('multi-line submit → paste WITHOUT the CR, and the CR split into submitAfter (issue #8)', () => {
        const r = resolveTerminalInput('a\nb\nc', {});
        // The paste block carries no trailing Enter — it would race paste-mode exit.
        expect(bytes(r)).toBe(`${PASTE_START}a\nb\nc${PASTE_END}`);
        expect(bytes(r)).not.toContain('\r');
        // The submit Enter is delivered separately (after PASTE_SUBMIT_DELAY_MS).
        expect(submitAfter(r)).toBe('\r');
    });

    it('multi-line: strips a trailing newline before wrapping the paste', () => {
        const r = resolveTerminalInput('a\nb\n', {});
        expect(bytes(r)).toBe(`${PASTE_START}a\nb${PASTE_END}`);
        expect(submitAfter(r)).toBe('\r');
    });

    it('multi-line submit:false → paste body only, no CR, no submitAfter', () => {
        const r = resolveTerminalInput('a\nb', { submit: false });
        expect(bytes(r)).toBe('a\nb');
        expect(submitAfter(r)).toBeUndefined();
    });

    it('a key never carries a separate submit', () => {
        expect(submitAfter(resolveTerminalInput('', { key: 'enter' }))).toBeUndefined();
    });

    it('submit:false → text with no CR', () => {
        const r = resolveTerminalInput('typed', { submit: false });
        expect(bytes(r)).toBe('typed');
        expect(submitAfter(r)).toBeUndefined();
    });

    it('key:"enter" with empty prompt → just a CR', () => {
        const r = resolveTerminalInput('', { key: 'enter' });
        expect(bytes(r)).toBe('\r');
    });

    it('key:"enter" ignores any provided text (the keypress wins)', () => {
        const r = resolveTerminalInput('ignored', { key: 'enter' });
        expect(bytes(r)).toBe('\r');
    });

    it('key:"escape" / "ctrl-c" deliver their control bytes', () => {
        expect(bytes(resolveTerminalInput('', { key: 'escape' }))).toBe('\x1b');
        expect(bytes(resolveTerminalInput('', { key: 'ctrl-c' }))).toBe('\x03');
    });

    it('empty text WITH submit (default) → a bare Enter', () => {
        const r = resolveTerminalInput('', {});
        expect(bytes(r)).toBe('\r');
    });

    it('empty text + submit:false + no key → rejected (nothing to do)', () => {
        const r = resolveTerminalInput('', { submit: false });
        expect('error' in r).toBe(true);
    });

    it('undefined text + submit:false + no key → rejected', () => {
        const r = resolveTerminalInput(undefined, { submit: false });
        expect('error' in r).toBe(true);
    });

    it('an unknown key is rejected', () => {
        const r = resolveTerminalInput('', { key: 'delete' });
        expect('error' in r).toBe(true);
    });

    it('truncates a long preview to ~200 chars', () => {
        const r = resolveTerminalInput('x'.repeat(500), {});
        if ('error' in r) throw new Error('expected bytes');
        expect(r.preview.length).toBeLessThanOrEqual(201);
        expect(r.preview.endsWith('…')).toBe(true);
    });
});

describe('stripAnsi', () => {
    it('removes SGR colour codes', () => {
        expect(stripAnsi('\x1b[31mred\x1b[0m text')).toBe('red text');
    });

    it('removes cursor moves and erase sequences', () => {
        expect(stripAnsi('a\x1b[2K\x1b[1;5Hb')).toBe('ab');
    });

    it('removes bracketed-paste markers', () => {
        expect(stripAnsi(`${PASTE_START}pasted${PASTE_END}`)).toBe('pasted');
    });

    it('removes OSC sequences (titles / hyperlinks), both BEL- and ST-terminated', () => {
        expect(stripAnsi('\x1b]0;my title\x07done')).toBe('done');
        expect(stripAnsi('\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\')).toBe('link');
    });

    it('drops stray carriage returns but keeps newlines', () => {
        expect(stripAnsi('one\r\ntwo')).toBe('one\ntwo');
    });

    it('leaves plain text untouched', () => {
        expect(stripAnsi('just plain text')).toBe('just plain text');
    });
});

/**
 * A SUBMIT must not ride inline behind a bulk body (genie#218).
 *
 * Reported: an AgentInbox nudge — a single line of ~180 characters — landed in
 * the target agent's TUI and just sat at the prompt. The text was there, the
 * turn never started. Driving another agent's terminal showed the same thing:
 * "it just adds a new line".
 *
 * The cause is not multi-line-ness. Claude Code and Codex apply a PASTE
 * HEURISTIC: a chunk that arrives all at once is treated as pasted input, and a
 * newline inside a paste is a newline in the buffer, not a submit. So
 * `body + CR` written as one chunk parks the prompt exactly like the bracketed
 * paste in issue #8 did — which is why the fix there (deliver the Enter as a
 * SEPARATE, slightly delayed write) is the fix here too. It was simply scoped to
 * multi-line, and the nudge is one long line.
 */
describe('submitting a body a TUI will treat as a paste', () => {
    const longLine = `[Genie] You just received a message from claude · master-ops as a DM, marked HIGH PRIORITY — check it immediately: read it with the agentinbox tool (action: "receive").`;

    it('splits the Enter out for a long single line, not just for multi-line', () => {
        const built = resolveTerminalInput(longLine, { submit: true });
        if ('error' in built) throw new Error(built.error);

        // The body must NOT carry a trailing CR — that is the byte the TUI eats
        // as part of the paste.
        expect(built.bytes.endsWith('\r')).toBe(false);
        // …and the submit must be delivered separately.
        expect(built.submitAfter).toBe('\r');
    });

    it('still splits for multi-line, as issue #8 established', () => {
        const built = resolveTerminalInput('one\ntwo', { submit: true });
        if ('error' in built) throw new Error(built.error);
        expect(built.submitAfter).toBe('\r');
    });

    it('keeps a SHORT command inline — no paste heuristic to trip, no delay', () => {
        const built = resolveTerminalInput('ls', { submit: true });
        if ('error' in built) throw new Error(built.error);
        expect(built.bytes).toBe('ls\r');
        expect(built.submitAfter).toBeUndefined();
    });

    it('a bare Enter is still one keystroke', () => {
        const built = resolveTerminalInput('', { submit: true });
        if ('error' in built) throw new Error(built.error);
        expect(built.bytes).toBe('\r');
        expect(built.submitAfter).toBeUndefined();
    });

    it('does not submit at all when the caller said not to', () => {
        const built = resolveTerminalInput(longLine, { submit: false });
        if ('error' in built) throw new Error(built.error);
        expect(built.submitAfter).toBeUndefined();
        expect(built.bytes.endsWith('\r')).toBe(false);
    });
});
