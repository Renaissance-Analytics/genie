/**
 * Pure intent-resolver for Genie's global keyboard shortcuts. Kept free of
 * React/DOM so it can be unit-tested under the Node test environment — the
 * master.tsx effect maps the resolved intent to the matching state mutation.
 *
 * ## Why this module used to hold exactly one shortcut
 *
 * It said: *"The old focus/pin/close shortcuts (⌘1–9 / ⌘\ / ⌘W) were removed: they
 * fire on a window keydown listener, and a focused terminal (xterm) swallows those
 * keys, so they were unreliable and their status-bar hint misled. ⌘, is kept
 * because the terminal doesn't claim it."*
 *
 * That diagnosis was right, and it is also the cleanest statement of why Genie has
 * no keyboard model at all: **you cannot define one while a terminal owns focus.**
 * An app whose primary surface is an ANSI grid has to surrender almost every chord
 * to whatever is running inside it.
 *
 * ## What changed
 *
 * The resolver now takes WHO OWNS FOCUS, so each shortcut is defined exactly where
 * it can work and withheld where it cannot — instead of being defined everywhere,
 * failing in a terminal, and being deleted for it. Three owners, because the
 * obvious two are not enough:
 *
 * - **`text`** — a real field. Nothing unmodified may act.
 * - **`terminal`** — xterm. The TUI owns Escape, Ctrl-K and the digits; only the
 *   chords it does not claim get through.
 * - **`surface`** — Genie's own React UI, where a single letter can mean something
 *   because nobody is typing prose into it.
 *
 * The rule that earns the split: **an unmodified letter must never act while a
 * human is typing.** `a` in a reply box is the letter a, not "approve this tool
 * call", and getting that wrong would approve tool calls by accident.
 */

/** What owns the keyboard when the key is pressed. */
export type FocusOwner = 'terminal' | 'text' | 'surface';

/** The bits of the focused element the classifier needs (so tests need no DOM). */
export interface FocusEl {
    tagName: string;
    isContentEditable: boolean;
    /** True when the element is xterm's hidden helper textarea, or inside `.xterm`. */
    inXterm: boolean;
}

/**
 * Classify the focused element.
 *
 * xterm is the case that makes this non-obvious: it focuses a hidden
 * `.xterm-helper-textarea`, so a naive tag check calls a focused terminal a text
 * field and disables every shortcut in it — while ignoring xterm entirely would let
 * an unmodified letter fire while the owner types into a TUI. It is neither, so it
 * gets its own owner.
 */
export function focusOwnerOf(el: FocusEl | null): FocusOwner {
    if (!el) return 'surface';
    if (el.inXterm) return 'terminal';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return 'text';
    return 'surface';
}

/** Something the human asked for. The effect in master.tsx performs it. */
export type ShortcutIntent =
    | { kind: 'settings' }
    /** Go up to the Deck — the landing view, and the only destination Escape has. */
    | { kind: 'deck' }
    /** Open the command palette. */
    | { kind: 'palette' }
    /** Jump to the nth agent (1-based; there is no slot 0). */
    | { kind: 'agent-slot'; slot: number }
    /** Take over an agent's terminal, or hand it back — one toggle, both ways. */
    | { kind: 'take-over' }
    /** Move through the needs-you queue. `+1` is down, matching j/k. */
    | { kind: 'queue-move'; delta: 1 | -1 }
    /** Resolve the focused approval. */
    | { kind: 'approval'; decision: 'allow' | 'deny' };

/** The subset of a KeyboardEvent the resolver needs (so tests don't need a DOM). */
export interface ShortcutKeyEvent {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
}

export function resolveShortcut(e: ShortcutKeyEvent, focus: FocusOwner = 'surface'): ShortcutIntent | null {
    // Alt is never part of a Genie chord — it belongs to the OS and to app menus.
    if (e.altKey) return null;

    const mod = e.metaKey || e.ctrlKey;

    if (mod) {
        // ⌘/Ctrl + , → Settings. Works EVERYWHERE, including a focused terminal:
        // no TUI claims it, which is exactly why it was the one that survived.
        if (e.key === ',') return { kind: 'settings' };

        // ⌘/Ctrl + Shift + T → take over / hand back. Deliberately available from
        // a terminal, because handing back is something you do while you are in
        // one. The surface offers a visible control for it too, so the capability
        // never depends on a chord surviving xterm.
        if (e.shiftKey && (e.key === 't' || e.key === 'T')) return { kind: 'take-over' };

        // Everything below is withheld from a terminal, where the TUI has first
        // claim: Ctrl-K is kill-line in any readline prompt, and the digits are
        // frequently bound inside TUIs.
        if (focus === 'terminal') return null;

        if (e.key === 'k' || e.key === 'K') return { kind: 'palette' };

        // 1–9 only. There is no slot 0, so ⌘0 stays free for zoom-reset.
        if (e.key >= '1' && e.key <= '9') return { kind: 'agent-slot', slot: Number(e.key) };

        return null;
    }

    // ── Unmodified keys ──────────────────────────────────────────────────────
    // Escape is the exception among them: it is not a letter, so a text field can
    // be given first refusal without the field ever receiving a stray command.
    if (e.key === 'Escape') {
        // In a TUI, Escape belongs to the TUI. In a field it should clear or blur
        // first; stealing it to navigate away would discard what was typed.
        return focus === 'surface' ? { kind: 'deck' } : null;
    }

    // THE SAFETY RULE. A single letter is a command only on Genie's own surface,
    // where nothing is being typed. Anywhere a human might be composing prose —
    // a field, or a TUI's input box — it is just that letter.
    if (focus !== 'surface') return null;

    switch (e.key) {
        case 'j':
        case 'J':
            return { kind: 'queue-move', delta: 1 };
        case 'k':
        case 'K':
            return { kind: 'queue-move', delta: -1 };
        case 'a':
        case 'A':
            return { kind: 'approval', decision: 'allow' };
        case 'd':
        case 'D':
            return { kind: 'approval', decision: 'deny' };
        default:
            return null;
    }
}
