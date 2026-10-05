import { describe, expect, it } from 'vitest';
import {
    focusOwnerOf,
    resolveShortcut,
    type FocusEl,
    type ShortcutKeyEvent,
} from '../master-shortcuts';

/**
 * Genie has had exactly ONE global shortcut (⌘, → Settings), and the reason
 * recorded in the module was that the others "fire on a window keydown listener,
 * and a focused terminal (xterm) swallows those keys". That reason is real, and it
 * is also the cleanest proof that terminal-as-main-view is why the app has no
 * keyboard model: you cannot define one while a terminal owns focus.
 *
 * So the resolver now takes WHO OWNS FOCUS, and the policy lives here instead of
 * inside an effect. The assertion that matters most is the dangerous one: an
 * unmodified letter must never act while a human is typing. "a" in a reply box is
 * the letter a — it is not "approve this tool call".
 */

const ev = (over: Partial<ShortcutKeyEvent>): ShortcutKeyEvent => ({
    key: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
});

const el = (over: Partial<FocusEl>): FocusEl => ({
    tagName: 'DIV',
    isContentEditable: false,
    inXterm: false,
    ...over,
});

describe('focusOwnerOf', () => {
    it('calls a real text field text', () => {
        expect(focusOwnerOf(el({ tagName: 'INPUT' }))).toBe('text');
        expect(focusOwnerOf(el({ tagName: 'TEXTAREA' }))).toBe('text');
        expect(focusOwnerOf(el({ isContentEditable: true }))).toBe('text');
    });

    it('calls xterm a terminal even though its hidden input IS a textarea', () => {
        // xterm focuses a hidden `.xterm-helper-textarea`. Classifying that as
        // 'text' would disable every shortcut in a terminal; classifying it as
        // 'surface' would let an unmodified letter act while the owner types into a
        // TUI. It is neither — it is a terminal, and it gets its own rules.
        expect(focusOwnerOf(el({ tagName: 'TEXTAREA', inXterm: true }))).toBe('terminal');
    });

    it('calls everything else, and nothing at all, the surface', () => {
        expect(focusOwnerOf(el({ tagName: 'DIV' }))).toBe('surface');
        expect(focusOwnerOf(el({ tagName: 'BUTTON' }))).toBe('surface');
        expect(focusOwnerOf(null)).toBe('surface');
    });
});

describe('resolveShortcut — the shortcut that already existed', () => {
    it('maps ⌘/Ctrl + , to a settings intent', () => {
        expect(resolveShortcut(ev({ key: ',', metaKey: true }))).toEqual({ kind: 'settings' });
        expect(resolveShortcut(ev({ key: ',', ctrlKey: true }))).toEqual({ kind: 'settings' });
    });

    it('requires the ⌘/Ctrl modifier — bare , is ignored', () => {
        expect(resolveShortcut(ev({ key: ',' }))).toBeNull();
    });

    it('ignores ⌘/Ctrl + , when Alt is held (avoid clobbering OS/app combos)', () => {
        expect(resolveShortcut(ev({ key: ',', metaKey: true, altKey: true }))).toBeNull();
    });

    it('still opens Settings from a focused terminal', () => {
        // The one shortcut the TUI does not claim, which is why it survived the
        // cull. That property is now stated rather than incidental.
        expect(resolveShortcut(ev({ key: ',', metaKey: true }), 'terminal')).toEqual({ kind: 'settings' });
    });

    it('defaults to surface focus when no owner is given', () => {
        // master.tsx's existing call site passes one argument.
        expect(resolveShortcut(ev({ key: 'Escape' }))).toEqual({ kind: 'deck' });
    });
});

describe('resolveShortcut — navigation', () => {
    it('maps Escape to the Deck', () => {
        expect(resolveShortcut(ev({ key: 'Escape' }), 'surface')).toEqual({ kind: 'deck' });
    });

    it('leaves Escape alone in a terminal and in a text field', () => {
        // In a TUI, Escape belongs to the TUI. In a field it should clear or blur
        // first — stealing it to navigate away would discard what was typed.
        expect(resolveShortcut(ev({ key: 'Escape' }), 'terminal')).toBeNull();
        expect(resolveShortcut(ev({ key: 'Escape' }), 'text')).toBeNull();
    });

    it('maps ⌘/Ctrl + K to the palette', () => {
        expect(resolveShortcut(ev({ key: 'k', metaKey: true }), 'surface')).toEqual({ kind: 'palette' });
        expect(resolveShortcut(ev({ key: 'K', ctrlKey: true }), 'text')).toEqual({ kind: 'palette' });
    });

    it('leaves ⌘/Ctrl + K to the terminal', () => {
        // Ctrl-K is kill-line in every readline-driven prompt.
        expect(resolveShortcut(ev({ key: 'k', ctrlKey: true }), 'terminal')).toBeNull();
    });

    it('maps ⌘/Ctrl + 1..9 to an agent slot', () => {
        // THE CONTRACT CHANGED HERE. This previously asserted null, because these
        // fired on a window listener that a focused terminal swallowed. The resolver
        // now knows who owns focus, so the shortcut is defined exactly where it can
        // work and withheld where it cannot.
        expect(resolveShortcut(ev({ key: '1', metaKey: true }), 'surface')).toEqual({
            kind: 'agent-slot',
            slot: 1,
        });
        expect(resolveShortcut(ev({ key: '9', ctrlKey: true }), 'surface')).toEqual({
            kind: 'agent-slot',
            slot: 9,
        });
    });

    it('has no slot 0, and withholds slots from a terminal', () => {
        expect(resolveShortcut(ev({ key: '0', metaKey: true }), 'surface')).toBeNull();
        expect(resolveShortcut(ev({ key: '1', ctrlKey: true }), 'terminal')).toBeNull();
    });

    it('still maps nothing to the removed pin/close chords', () => {
        // Removed for their own reasons and not revived by this change.
        expect(resolveShortcut(ev({ key: '\\', metaKey: true }), 'surface')).toBeNull();
        expect(resolveShortcut(ev({ key: 'w', metaKey: true }), 'surface')).toBeNull();
        expect(resolveShortcut(ev({ key: 'W', ctrlKey: true }), 'surface')).toBeNull();
    });
});

describe('resolveShortcut — take over', () => {
    it('maps ⌘/Ctrl + Shift + T to take over', () => {
        expect(resolveShortcut(ev({ key: 'T', metaKey: true, shiftKey: true }), 'surface')).toEqual({
            kind: 'take-over',
        });
    });

    it('works from the terminal too, because that is where you hand back', () => {
        expect(resolveShortcut(ev({ key: 'T', ctrlKey: true, shiftKey: true }), 'terminal')).toEqual({
            kind: 'take-over',
        });
    });

    it('requires Shift, so plain ⌘T is not it', () => {
        expect(resolveShortcut(ev({ key: 't', metaKey: true }), 'surface')).toBeNull();
    });
});

describe('resolveShortcut — unmodified keys act ONLY on the surface', () => {
    it('maps j and k to queue movement', () => {
        expect(resolveShortcut(ev({ key: 'j' }), 'surface')).toEqual({ kind: 'queue-move', delta: 1 });
        expect(resolveShortcut(ev({ key: 'k' }), 'surface')).toEqual({ kind: 'queue-move', delta: -1 });
    });

    it('maps a and d to an approval decision', () => {
        expect(resolveShortcut(ev({ key: 'a' }), 'surface')).toEqual({ kind: 'approval', decision: 'allow' });
        expect(resolveShortcut(ev({ key: 'd' }), 'surface')).toEqual({ kind: 'approval', decision: 'deny' });
    });

    it('NEVER acts while a human is typing', () => {
        // The assertion this whole focus argument exists for. Typing "a dashboard"
        // into a reply box must not allow a tool call and then deny one.
        for (const key of ['j', 'k', 'a', 'd', 'J', 'K', 'A', 'D']) {
            expect(resolveShortcut(ev({ key }), 'text')).toBeNull();
            expect(resolveShortcut(ev({ key }), 'terminal')).toBeNull();
        }
    });

    it('NEVER acts when a modifier is held, so select-all still selects all', () => {
        expect(resolveShortcut(ev({ key: 'a', metaKey: true }), 'surface')).toBeNull();
        expect(resolveShortcut(ev({ key: 'a', ctrlKey: true }), 'surface')).toBeNull();
        expect(resolveShortcut(ev({ key: 'd', altKey: true }), 'surface')).toBeNull();
        expect(resolveShortcut(ev({ key: 'j', metaKey: true }), 'surface')).toBeNull();
    });

    it('accepts the shifted letter, since Caps Lock is not a different intent', () => {
        expect(resolveShortcut(ev({ key: 'A', shiftKey: true }), 'surface')).toEqual({
            kind: 'approval',
            decision: 'allow',
        });
    });
});
