import { describe, expect, it } from 'vitest';
import { hotkeyActionFor, matchesAccelerator, type KeyChord } from '../hotkeys';

/**
 * Which keypresses Genie takes for itself, and — far more importantly — which it
 * leaves alone (Tynn stories #246 and #247).
 *
 * Two features need one mechanism: F5 nudges the focused agent to re-ask through
 * ForceTheQuestion, and Ctrl+K opens the Command Window. Both have to be caught
 * BEFORE the terminal sees them, because fancy-term-host/xterm swallows
 * everything it is given.
 *
 * That makes the SCOPE the load-bearing decision, not the binding. These are keys
 * other software owns: F5 reloads a browser and refreshes a file manager, and
 * Ctrl+K is kill-to-end-of-line in every readline shell — which is to say, in the
 * terminal these hotkeys live in. Taking either one too widely does not degrade
 * Genie, it breaks the tool the user is actually using.
 *
 * So the rule is narrow on purpose: a hotkey binds ONLY while a Genie TERMINAL
 * PANEL has focus. Not when Genie is in the background, not when another app has
 * focus, and not in Genie's own settings, editors or modals.
 *
 * `globalShortcut` (what main/shortcuts.ts uses for quick-capture) cannot express
 * this — it is an OS-wide grab that fires with Genie minimised. Electron's
 * `before-input-event` is window-scoped, which removes the background case, but
 * still fires for every focused surface in the window. Hence this predicate.
 */

const BINDINGS = { ftqNudge: 'F5', commandWindow: 'CommandOrControl+K' };
const IN_TERMINAL = { inTerminalPanel: true };
const NOT_IN_TERMINAL = { inTerminalPanel: false };

const chord = (over: Partial<KeyChord> & { key: string }): KeyChord => ({
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
    ...over,
});

describe('with a terminal panel focused', () => {
    it('claims F5 for the ForceTheQuestion nudge', () => {
        expect(hotkeyActionFor(chord({ key: 'F5' }), BINDINGS, IN_TERMINAL, 'win32')).toBe(
            'ftq-nudge',
        );
    });

    it('claims Ctrl+K for the Command Window on Windows and Linux', () => {
        expect(
            hotkeyActionFor(chord({ key: 'k', ctrl: true }), BINDINGS, IN_TERMINAL, 'win32'),
        ).toBe('command-window');
    });

    it('claims Cmd+K on macOS, and NOT Ctrl+K', () => {
        // CommandOrControl means Command there. Ctrl+K on macOS is still
        // kill-to-end-of-line, and taking it would break the shell.
        expect(
            hotkeyActionFor(chord({ key: 'k', meta: true }), BINDINGS, IN_TERMINAL, 'darwin'),
        ).toBe('command-window');
        expect(
            hotkeyActionFor(chord({ key: 'k', ctrl: true }), BINDINGS, IN_TERMINAL, 'darwin'),
        ).toBeNull();
    });

    it('leaves every other key to the terminal', () => {
        expect(hotkeyActionFor(chord({ key: 'a' }), BINDINGS, IN_TERMINAL, 'win32')).toBeNull();
        expect(hotkeyActionFor(chord({ key: 'F6' }), BINDINGS, IN_TERMINAL, 'win32')).toBeNull();
        // Ctrl+C must always reach the shell — it is how you stop a process.
        expect(
            hotkeyActionFor(chord({ key: 'c', ctrl: true }), BINDINGS, IN_TERMINAL, 'win32'),
        ).toBeNull();
    });

    it('does not fire on a SUPERSET of the binding', () => {
        // Ctrl+Shift+K is its own key in plenty of tools; a binding for Ctrl+K
        // must not swallow it. Exact modifier match, not "at least these".
        expect(
            hotkeyActionFor(
                chord({ key: 'k', ctrl: true, shift: true }),
                BINDINGS,
                IN_TERMINAL,
                'win32',
            ),
        ).toBeNull();
    });
});

describe('with focus anywhere else', () => {
    it('claims NOTHING — the whole point of the scope', () => {
        // Settings, an editor, a modal, the site manager. F5 there is a reload or
        // a refresh and belongs to whatever the user is in.
        expect(hotkeyActionFor(chord({ key: 'F5' }), BINDINGS, NOT_IN_TERMINAL, 'win32')).toBeNull();
        expect(
            hotkeyActionFor(chord({ key: 'k', ctrl: true }), BINDINGS, NOT_IN_TERMINAL, 'win32'),
        ).toBeNull();
    });
});

describe('remapping', () => {
    it('honours a workstation-configured key', () => {
        const custom = { ftqNudge: 'Control+Shift+Q', commandWindow: 'F1' };

        expect(
            hotkeyActionFor(chord({ key: 'q', ctrl: true, shift: true }), custom, IN_TERMINAL, 'win32'),
        ).toBe('ftq-nudge');
        expect(hotkeyActionFor(chord({ key: 'F1' }), custom, IN_TERMINAL, 'win32')).toBe(
            'command-window',
        );
        // The defaults stop being special once remapped.
        expect(hotkeyActionFor(chord({ key: 'F5' }), custom, IN_TERMINAL, 'win32')).toBeNull();
    });

    it('treats an empty binding as "not bound" rather than matching everything', () => {
        const none = { ftqNudge: '', commandWindow: '' };
        expect(hotkeyActionFor(chord({ key: 'F5' }), none, IN_TERMINAL, 'win32')).toBeNull();
        expect(hotkeyActionFor(chord({ key: '' }), none, IN_TERMINAL, 'win32')).toBeNull();
    });
});

describe('matchesAccelerator', () => {
    it('is case-insensitive on the key, since the event reports the typed case', () => {
        // Shift+K arrives as 'K'; a binding written 'k' must still match once its
        // shift requirement is satisfied.
        expect(matchesAccelerator(chord({ key: 'K', ctrl: true }), 'Control+k', 'win32')).toBe(true);
    });

    it('accepts the common spellings of each modifier', () => {
        expect(matchesAccelerator(chord({ key: 'k', ctrl: true }), 'Ctrl+K', 'win32')).toBe(true);
        expect(matchesAccelerator(chord({ key: 'k', meta: true }), 'Cmd+K', 'darwin')).toBe(true);
        expect(matchesAccelerator(chord({ key: 'k', meta: true }), 'Meta+K', 'darwin')).toBe(true);
    });

    it('rejects a malformed accelerator instead of throwing', () => {
        expect(matchesAccelerator(chord({ key: 'k' }), '+', 'win32')).toBe(false);
        expect(matchesAccelerator(chord({ key: 'k' }), 'Control+', 'win32')).toBe(false);
    });
});
