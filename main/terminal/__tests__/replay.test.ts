import { describe, expect, it } from 'vitest';
import {
    MOUSE_REPORTING_OFF,
    sanitizeReplay,
    stripReplayQueries,
} from '../replay';

/**
 * genie#202 / genie#200 — replayed scrollback must be HISTORY, not a live stream.
 *
 * The bytes below are the shapes an agent-TUI actually leaves in a pty's
 * scrollback ring. Replaying them raw into a FRESH xterm re-performs their side
 * effects: the emulator answers the recorded device QUERIES (its reply is written
 * back to the pty, where a bare shell echoes it — the `^[[?1;2c` smeared on the
 * prompt) and re-enters mouse-tracking mode (every later pointer move becomes an
 * SGR report on the pty, and xterm stops doing drag-selection).
 */

/** A recorded "agent TUI ran, enabled mouse tracking, then DIED" scrollback. */
const DEAD_TUI_SCROLLBACK =
    '\x1b[?1049h' + // enter alt screen
    '\x1b[c' + // DA1 probe          → xterm answers ESC[?1;2c
    '\x1b[>0;276;0c' + // (its own DA2 REPLY, echoed into the buffer)
    '\x1b[>q' + // XTVERSION probe    → xterm answers a DCS
    '\x1b[?1004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h' + // mouse tracking ON
    '\x1b[?2004h' + // bracketed paste on
    '\x1b[1;32mclaude\x1b[0m ready\r\n' +
    // …the TUI is killed here: no ESC[?1000l, no ESC[?1049l, no restore at all.
    'user@box:~$ ';

describe('stripReplayQueries', () => {
    it('drops the DA1 probe that makes xterm answer ESC[?1;2c into the pty', () => {
        const out = stripReplayQueries('before\x1b[cafter');
        expect(out).toBe('beforeafter');
    });

    it('drops DA2 / DA3 probes', () => {
        expect(stripReplayQueries('a\x1b[>cb')).toBe('ab');
        expect(stripReplayQueries('a\x1b[>0cb')).toBe('ab');
        expect(stripReplayQueries('a\x1b[=0cb')).toBe('ab');
    });

    it('drops DSR / cursor-position requests', () => {
        expect(stripReplayQueries('a\x1b[6nb')).toBe('ab');
        expect(stripReplayQueries('a\x1b[5nb')).toBe('ab');
        expect(stripReplayQueries('a\x1b[?6nb')).toBe('ab');
        expect(stripReplayQueries('a\x1b[nb')).toBe('ab');
    });

    it('drops DECRQM mode requests and the XTVERSION probe', () => {
        expect(stripReplayQueries('a\x1b[?1049$pb')).toBe('ab');
        expect(stripReplayQueries('a\x1b[?2004$pb')).toBe('ab');
        expect(stripReplayQueries('a\x1b[>0qb')).toBe('ab');
        expect(stripReplayQueries('a\x1b[>qb')).toBe('ab');
    });

    it('drops DECID (ESC Z) and DCS queries (XTGETTCAP / DECRQSS)', () => {
        expect(stripReplayQueries('a\x1bZb')).toBe('ab');
        expect(stripReplayQueries('a\x1bP+q544e\x1b\\b')).toBe('ab');
        expect(stripReplayQueries('a\x1bP$qm\x1b\\b')).toBe('ab');
    });

    it('drops OSC QUERIES (colour probes and the OSC 52 clipboard READ)', () => {
        expect(stripReplayQueries('a\x1b]10;?\x07b')).toBe('ab');
        expect(stripReplayQueries('a\x1b]11;?\x1b\\b')).toBe('ab');
        expect(stripReplayQueries('a\x1b]4;1;?\x07b')).toBe('ab');
        // Genie answers OSC 52 reads by WRITING the clipboard back into the pty
        // (Terminal.tsx registerOscHandler(52)) — a replayed read would inject it.
        expect(stripReplayQueries('a\x1b]52;c;?\x07b')).toBe('ab');
    });

    it('KEEPS everything that merely renders — this is not a blanket ANSI strip', () => {
        const rendering =
            '\x1b[1;32mgreen\x1b[0m' + // SGR colour
            '\x1b[2J\x1b[H' + // clear + home
            '\x1b[10;20H' + // absolute cursor move
            '\x1b[?1049h\x1b[?1049l' + // alt-screen in/out
            '\x1b[?2004h' + // bracketed paste
            '\x1b[?25l\x1b[?25h' + // cursor hide/show
            '\x1b[5 q' + // DECSCUSR cursor style (final `q`, NOT XTVERSION)
            '\x1b]0;a title\x07' + // window title
            '\x1b]7;file:///c/tmp\x07' + // OSC 7 cwd report
            '\x1b]52;c;aGVsbG8=\x07' + // OSC 52 clipboard WRITE (not a read)
            'plain text\r\n';
        expect(stripReplayQueries(rendering)).toBe(rendering);
    });

    it('leaves a query-free stream untouched', () => {
        expect(stripReplayQueries('')).toBe('');
        expect(stripReplayQueries('just text')).toBe('just text');
    });
});

describe('MOUSE_REPORTING_OFF', () => {
    it('disables every mode that turns pointer motion or focus into pty bytes', () => {
        // X10, normal, highlight, button-event, any-event, focus, and the
        // UTF-8/SGR/urxvt/pixel encodings.
        for (const mode of [9, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016]) {
            expect(MOUSE_REPORTING_OFF).toContain(String(mode));
        }
        // A single DECRST (private-mode RESET) — never a `h` (set).
        expect(MOUSE_REPORTING_OFF.startsWith('\x1b[?')).toBe(true);
        expect(MOUSE_REPORTING_OFF.endsWith('l')).toBe(true);
        expect(MOUSE_REPORTING_OFF).not.toContain('h');
    });
});

describe('sanitizeReplay', () => {
    it('answers no query and leaves mouse reporting OFF for a dead-TUI scrollback', () => {
        const out = sanitizeReplay(DEAD_TUI_SCROLLBACK);

        // Nothing left that xterm would ANSWER back into the pty (genie#202's
        // `?1;2c` on the prompt).
        expect(out).not.toContain('\x1b[c');
        expect(out).not.toContain('\x1b[>q');

        // The visible history still renders.
        expect(out).toContain('\x1b[1;32mclaude\x1b[0m ready');
        expect(out).toContain('user@box:~$ ');
        // Alt-screen + bracketed paste are RENDERING/paste state, not input
        // generators — they are deliberately left alone.
        expect(out).toContain('\x1b[?1049h');
        expect(out).toContain('\x1b[?2004h');

        // …and the replay ENDS with mouse reporting disabled, so a pointer move
        // over the reattached pane can never stream SGR reports at a bare shell,
        // and a drag selects text instead of being eaten as a mouse event.
        expect(out.endsWith(MOUSE_REPORTING_OFF)).toBe(true);
    });

    it('emits the mouse-off epilogue exactly once, after the last history byte', () => {
        const out = sanitizeReplay(DEAD_TUI_SCROLLBACK);
        expect(out.split(MOUSE_REPORTING_OFF).length - 1).toBe(1);
        expect(out.indexOf(MOUSE_REPORTING_OFF)).toBe(out.length - MOUSE_REPORTING_OFF.length);
    });

    it('writes NOTHING for an empty replay (no history ⇒ no reset to send)', () => {
        expect(sanitizeReplay('')).toBe('');
        expect(sanitizeReplay(undefined)).toBe('');
    });
});
