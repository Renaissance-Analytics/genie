/**
 * Pure intent-resolver for Genie's global keyboard shortcut. Kept free of
 * React/DOM so it can be unit-tested under the Node test environment — the
 * master.tsx effect maps the resolved intent to the matching state mutation.
 *
 *   ⌘/Ctrl + ,  → { kind: 'settings' }  open Settings
 *
 * The old focus/pin/close shortcuts (⌘1–9 / ⌘\ / ⌘W) were removed: they fire on a
 * window keydown listener, and a focused terminal (xterm) swallows those keys, so
 * they were unreliable and their status-bar hint misled. ⌘, is kept because the
 * terminal doesn't claim it, so it works anywhere. Returns null when the event
 * isn't the wired shortcut (or a modifier guard rules it out).
 */
export type ShortcutIntent = { kind: 'settings' };

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

    // ⌘/Ctrl + , → open Settings (the standard app-settings shortcut).
    if (e.key === ',') {
        return { kind: 'settings' };
    }

    return null;
}
