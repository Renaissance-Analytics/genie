import { describe, expect, it } from 'vitest';
import {
    escapeLeavesForDeck,
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
        /**
         * The single-letter QUEUE commands must not fire under a modifier, or ⌘A would allow a
         * tool call instead of selecting all.
         *
         * ⌘J USED TO BE IN THIS LIST and no longer is, because the board assigns it (§5.4:
         * *"⌘J chat"*). That is a deliberate contract change, not a loosened assertion — the
         * principle is unchanged and still asserted by the three cases below, and the case
         * underneath proves ⌘J now resolves to something rather than merely stopping being
         * null. A letter leaving this list should always be paired with a reason and a
         * positive control; otherwise it reads as the guard quietly eroding.
         */
        expect(resolveShortcut(ev({ key: 'a', metaKey: true }), 'surface')).toBeNull();
        expect(resolveShortcut(ev({ key: 'a', ctrlKey: true }), 'surface')).toBeNull();
        expect(resolveShortcut(ev({ key: 'd', altKey: true }), 'surface')).toBeNull();
        // NOT ⌘K or ⌃K as a fourth case: those are the palette, which the resolver assigns
        // above. Tried it, and it went red — the remaining inert letters under a modifier are
        // exactly `a` and `d`, which is what the three lines above cover.
    });

    it('⌘J is now an assigned chord, which is why it left the list above', () => {
        expect(resolveShortcut(ev({ key: 'j', metaKey: true }), 'surface')).toEqual({ kind: 'chat' });
    });

    it('accepts the shifted letter, since Caps Lock is not a different intent', () => {
        expect(resolveShortcut(ev({ key: 'A', shiftKey: true }), 'surface')).toEqual({
            kind: 'approval',
            decision: 'allow',
        });
    });
});

describe('escapeLeavesForDeck — when Escape may actually navigate', () => {
    /**
     * Escape RESOLVES to the Deck and for a long time did nothing, and the reason is written
     * into `master.tsx`: wiring it navigated away on every Escape, and Escape already means
     * something here — it closes a flyout, dismisses a panel, leaves a docked layout.
     * `preventDefault` on top of that stole the key from the app's own handling, and **four
     * E2E specs failed identically on all three platforms**: a dismissed panel that stayed, an
     * "empty floor" holding one, a hibernated floor, a docked lists header.
     *
     * So the fix is not "never wire it". It is that going up a level is the LAST claim on
     * Escape, not the first. Two conditions, both learned from those failures:
     *
     *  - **Nothing is open.** An overlay owns Escape while it is up; closing it IS the up-a-level
     *    action, and there is no second level to climb in the same keystroke.
     *  - **The view has somewhere to go up TO.** From an agent, that is the Deck. The grid and
     *    the Workbench are where panels live, and every one of those four failures was a panel
     *    losing its Escape — so there the key is left entirely alone.
     */
    it('leaves an agent view for the Deck', () => {
        expect(escapeLeavesForDeck({ view: 'agent', overlayOpen: false })).toBe(true);
    });

    it('does NOT act while an overlay is open — closing it is the up-a-level action', () => {
        expect(escapeLeavesForDeck({ view: 'agent', overlayOpen: true })).toBe(false);
    });

    it('leaves the GRID alone, where four E2E specs were lost to exactly this', () => {
        // Panels own Escape: dismiss, un-hibernate, leave a docked header. Taking it to
        // navigate hid the grid underneath every one of them.
        expect(escapeLeavesForDeck({ view: 'grid', overlayOpen: false })).toBe(false);
        expect(escapeLeavesForDeck({ view: 'workbench', overlayOpen: false })).toBe(false);
    });

    it('does nothing on the Deck itself, because there is no level above it', () => {
        // A key that silently does nothing is better than one that re-navigates the view you
        // are already on and scrolls it back to the top.
        expect(escapeLeavesForDeck({ view: 'deck', overlayOpen: false })).toBe(false);
    });
});


describe('Escape on the Dashboard', () => {
    it('does NOT navigate, because a top-level surface has no level above it', () => {
        // The same answer as the Deck, for the same reason. Asserted rather than left as a
        // consequence of `=== 'agent'`: widening the union made this true silently, and a
        // behaviour that is right by accident cannot be defended when the next view arrives.
        expect(escapeLeavesForDeck({ view: 'dashboard', overlayOpen: false })).toBe(false);
        expect(escapeLeavesForDeck({ view: 'deck', overlayOpen: false })).toBe(false);
        // The positive control: it still DOES navigate from an agent, or this test would pass
        // against a function that always returned false.
        expect(escapeLeavesForDeck({ view: 'agent', overlayOpen: false })).toBe(true);
    });
});

/**
 * ⌘J / ⌘⇧J — the chat keys the board adds (§5.4).
 *
 * Chat is where a human types to an agent, so its key has to work from wherever they noticed
 * the agent — and the one place it must NOT work is inside a terminal, where the TUI has first
 * claim on every chord. That is the same rule ⌘K already follows for the same reason.
 */
describe('the chat shortcuts', () => {
    const key = (k: string, extra: Partial<KeyboardEvent> = {}) =>
        ({ key: k, metaKey: true, ...extra }) as KeyboardEvent;

    it('⌘J asks for chat', () => {
        expect(resolveShortcut(key('j'), 'surface')).toEqual({ kind: 'chat' });
        // Capitalised too: a chord with Shift reports an upper-case key on some layouts, and
        // ⌘K already handles both for that reason.
        expect(resolveShortcut(key('J', { shiftKey: true }), 'surface')).toEqual({ kind: 'chat-pin' });
    });

    it('⌘⇧J asks for the PIN, not for chat', () => {
        // Order matters in the resolver: the Shift variant must be tested first, or ⌘⇧J would
        // match ⌘J and the pin key would just toggle the panel.
        expect(resolveShortcut(key('j', { shiftKey: true }), 'surface')).toEqual({ kind: 'chat-pin' });
    });

    it('is withheld inside a TERMINAL, where the TUI owns the chord', () => {
        // ⌃J is newline in any readline prompt. The same reasoning that withholds ⌘K.
        expect(resolveShortcut(key('j'), 'terminal')).toBeNull();
        expect(resolveShortcut(key('j', { shiftKey: true }), 'terminal')).toBeNull();
    });

    it('still works from a TEXT field, unlike the single-letter commands', () => {
        // A chord is safe in a field — nothing is being composed by ⌘J — and someone typing in
        // a filter box is exactly who wants to reach an agent. The single letters (J/K/A/D) are
        // the ones that must not fire there, and the test above asserts exactly that for the
        // same focus value.
        expect(resolveShortcut(key('j'), 'text')).toEqual({ kind: 'chat' });
    });
});

/**
 * `L` — the Lanes pulldown (§5.2, "New keys: ... L").
 *
 * An unmodified letter, so it obeys THE SAFETY RULE: it is a command only on Genie's own
 * surface. In a field or a TUI it is the letter `l`, because somewhere in this app a person
 * is always typing prose and a timeline that opens mid-word is worse than no shortcut.
 */
describe('L opens the lanes', () => {
    it('is a command on Genie’s own surface', () => {
        expect(resolveShortcut(ev({ key: 'l' }), 'surface')).toEqual({ kind: 'lanes' });
        expect(resolveShortcut(ev({ key: 'L' }), 'surface')).toEqual({ kind: 'lanes' });
    });

    it('is just a letter in a terminal or a field', () => {
        expect(resolveShortcut(ev({ key: 'l' }), 'terminal')).toBeNull();
        expect(resolveShortcut(ev({ key: 'l' }), 'text')).toBeNull();
    });

    it('is NOT claimed with a modifier, which belongs to the browser and the OS', () => {
        // Ctrl/Cmd-L is the address bar, and Alt is never part of a Genie chord.
        expect(resolveShortcut(ev({ key: 'l', ctrlKey: true }), 'surface')).not.toEqual({
            kind: 'lanes',
        });
        expect(resolveShortcut(ev({ key: 'l', altKey: true }), 'surface')).toBeNull();
    });
});

/**
 * ⌘B — the workspace file panel ("New keys: ... ⌘B files").
 *
 * A CHORD, so it is not bound by the safety rule that governs single letters — but it IS
 * withheld from a terminal, for a sharper reason than most: `Ctrl-B` is tmux's default prefix
 * key and `backward-char` in every readline prompt. Taking it would break the chord people
 * press before every tmux command, and the break would look like tmux itself was broken.
 */
describe('⌘B opens the files panel', () => {
    it('resolves on Genie’s own surface, with either modifier', () => {
        expect(resolveShortcut(ev({ key: 'b', metaKey: true }), 'surface')).toEqual({ kind: 'files' });
        expect(resolveShortcut(ev({ key: 'b', ctrlKey: true }), 'surface')).toEqual({ kind: 'files' });
    });

    it('accepts the upper-case letter, since Caps Lock is not a different intent', () => {
        // No Shift variant is assigned to B, so BOTH cases mean the same thing — unlike ⌘J,
        // where `J` is the pin and the ordering has to separate them.
        expect(resolveShortcut(ev({ key: 'B', metaKey: true, shiftKey: true }), 'surface')).toEqual({
            kind: 'files',
        });
    });

    it('is withheld inside a TERMINAL, where Ctrl-B is tmux’s prefix', () => {
        expect(resolveShortcut(ev({ key: 'b', ctrlKey: true }), 'terminal')).toBeNull();
        // The positive control: the same chord DOES resolve on the surface, so this pair proves
        // the focus check and not a resolver that returns null for B everywhere.
        expect(resolveShortcut(ev({ key: 'b', ctrlKey: true }), 'surface')).toEqual({ kind: 'files' });
    });

    it('still works from a TEXT field, like ⌘J and ⌘K', () => {
        // Nothing is composed by ⌘B in a plain field — there is no rich-text surface in this app
        // for it to mean "bold" — and someone in a filter box is exactly who wants the files.
        expect(resolveShortcut(ev({ key: 'b', metaKey: true }), 'text')).toEqual({ kind: 'files' });
    });

    it('needs the modifier, and never fires with Alt held', () => {
        expect(resolveShortcut(ev({ key: 'b' }), 'surface')).toBeNull();
        expect(resolveShortcut(ev({ key: 'b', metaKey: true, altKey: true }), 'surface')).toBeNull();
        // Positive control for both negatives above.
        expect(resolveShortcut(ev({ key: 'b', metaKey: true }), 'surface')).toEqual({ kind: 'files' });
    });
});

/**
 * `E` — jump to the next edit in the stream ("New keys: ... E next edit").
 *
 * An unmodified letter, so THE SAFETY RULE governs it: a command only on Genie's own surface.
 * In a field or a TUI it is the letter `e`, which is in roughly every English word a person
 * might type.
 */
describe('E jumps to the next edit', () => {
    it('is a command on Genie’s own surface, in either case', () => {
        expect(resolveShortcut(ev({ key: 'e' }), 'surface')).toEqual({ kind: 'next-edit' });
        expect(resolveShortcut(ev({ key: 'E' }), 'surface')).toEqual({ kind: 'next-edit' });
    });

    it('is just a letter in a terminal or a field', () => {
        expect(resolveShortcut(ev({ key: 'e' }), 'terminal')).toBeNull();
        expect(resolveShortcut(ev({ key: 'e' }), 'text')).toBeNull();
        // The positive control: `e` DOES resolve on the surface. Without this line the two
        // assertions above would pass against a resolver that ignored `e` entirely.
        expect(resolveShortcut(ev({ key: 'e' }), 'surface')).toEqual({ kind: 'next-edit' });
    });

    it('is NOT claimed under a modifier, so ⌘E stays free', () => {
        expect(resolveShortcut(ev({ key: 'e', metaKey: true }), 'surface')).toBeNull();
        expect(resolveShortcut(ev({ key: 'e', ctrlKey: true }), 'surface')).toBeNull();
        // Positive control again: the bare letter is the binding, the chord is not.
        expect(resolveShortcut(ev({ key: 'e' }), 'surface')).toEqual({ kind: 'next-edit' });
    });
});

/**
 * `/` — find in the stream ("New keys: ... / find in stream").
 *
 * The most dangerous key on the board, and the one the safety rule was written for. `/` starts
 * a path and it starts a slash-command, so a human types it constantly INTO things. It may act
 * only on Genie's own surface; anywhere a character is being composed it must reach the field.
 */
describe('/ finds in the stream', () => {
    it('is a command on Genie’s own surface', () => {
        expect(resolveShortcut(ev({ key: '/' }), 'surface')).toEqual({ kind: 'find-in-stream' });
    });

    it('reaches the FIELD and the TUI untouched, because people type it there', () => {
        // `/src/main` in a filter box, `/model` in a TUI. Stealing this keystroke would be the
        // most-noticed bug on the board.
        expect(resolveShortcut(ev({ key: '/' }), 'text')).toBeNull();
        expect(resolveShortcut(ev({ key: '/' }), 'terminal')).toBeNull();
        // The positive control: it still resolves on the surface.
        expect(resolveShortcut(ev({ key: '/' }), 'surface')).toEqual({ kind: 'find-in-stream' });
    });

    it('resolves with Shift held, because on many layouts / IS a shifted key', () => {
        // Shift+7 on a German layout, Shift+: on a Japanese one — the browser still reports
        // `/`. Requiring Shift to be absent would make find unreachable outside US layouts,
        // and the shifted letters (A/D) are already accepted for the same reason.
        expect(resolveShortcut(ev({ key: '/', shiftKey: true }), 'surface')).toEqual({
            kind: 'find-in-stream',
        });
    });

    it('is NOT claimed under ⌘ or Alt', () => {
        expect(resolveShortcut(ev({ key: '/', metaKey: true }), 'surface')).toBeNull();
        expect(resolveShortcut(ev({ key: '/', altKey: true }), 'surface')).toBeNull();
        // Positive control for the two negatives above.
        expect(resolveShortcut(ev({ key: '/' }), 'surface')).toEqual({ kind: 'find-in-stream' });
    });
});
