/**
 * Pure intent-resolver for Genie's global keyboard shortcuts (advertised in the
 * master footer hint). Kept free of React/DOM so it can be unit-tested under the
 * Node test environment — the master.tsx effect just maps the resolved intent to
 * the matching state mutation.
 *
 *   ⌘/Ctrl + 1–9  → { kind: 'focus', index }  focus the Nth visible panel (0-based)
 *   ⌘/Ctrl + \\   → { kind: 'pin' }            toggle the pinned tree/chooser
 *   ⌘/Ctrl + W    → { kind: 'close' }          close the currently focused panel
 *
 * Returns null when the event isn't one of the wired shortcuts (or a modifier
 * guard rules it out), so the caller can leave the keystroke alone.
 */
export type ShortcutIntent =
    | { kind: 'focus'; index: number }
    | { kind: 'pin' }
    | { kind: 'close' }
    | { kind: 'settings' };

/** The subset of a KeyboardEvent the resolver needs (so tests don't need a DOM). */
export interface ShortcutKeyEvent {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
}

export function resolveShortcut(e: ShortcutKeyEvent): ShortcutIntent | null {
    // Require exactly one of ⌘ (mac) / Ctrl (win/linux); never with Alt, so we
    // don't clobber OS/app combos.
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;

    // ⌘/Ctrl + W → close the focused panel.
    if ((e.key === 'w' || e.key === 'W') && !e.shiftKey) {
        return { kind: 'close' };
    }

    // ⌘/Ctrl + \\ → toggle the pinned tree/chooser.
    if (e.key === '\\') {
        return { kind: 'pin' };
    }

    // ⌘/Ctrl + , → open Settings (the standard app-settings shortcut).
    if (e.key === ',') {
        return { kind: 'settings' };
    }

    // ⌘/Ctrl + 1–9 → focus the Nth visible panel (0-based index).
    if (e.key >= '1' && e.key <= '9' && !e.shiftKey) {
        return { kind: 'focus', index: Number(e.key) - 1 };
    }

    return null;
}
