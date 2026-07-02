import { describe, expect, it } from 'vitest';
import { resolveShortcut, type ShortcutKeyEvent } from '../master-shortcuts';

/**
 * Unit tests for the pure keyboard-shortcut intent resolver behind the master
 * view's one remaining global shortcut: ⌘/Ctrl + , → open Settings. The
 * master.tsx effect maps the resolved intent to a state mutation; here we assert
 * the key→intent mapping and the modifier guards, plus that the removed
 * focus/pin/close shortcuts (⌘1–9 / ⌘\ / ⌘W — a focused terminal swallowed them)
 * no longer resolve.
 */

const ev = (over: Partial<ShortcutKeyEvent>): ShortcutKeyEvent => ({
    key: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
});

describe('resolveShortcut', () => {
    it('maps ⌘/Ctrl + , to a settings intent', () => {
        expect(resolveShortcut(ev({ key: ',', metaKey: true }))).toEqual({
            kind: 'settings',
        });
        // Both meta (mac) and ctrl (win/linux) trigger it.
        expect(resolveShortcut(ev({ key: ',', ctrlKey: true }))).toEqual({
            kind: 'settings',
        });
    });

    it('requires the ⌘/Ctrl modifier — bare , is ignored', () => {
        expect(resolveShortcut(ev({ key: ',' }))).toBeNull();
    });

    it('ignores ⌘/Ctrl + , when Alt is held (avoid clobbering OS/app combos)', () => {
        expect(resolveShortcut(ev({ key: ',', metaKey: true, altKey: true }))).toBeNull();
    });

    it('no longer maps the removed focus/pin/close shortcuts (⌘1–9 / ⌘\\ / ⌘W)', () => {
        expect(resolveShortcut(ev({ key: '1', metaKey: true }))).toBeNull();
        expect(resolveShortcut(ev({ key: '9', ctrlKey: true }))).toBeNull();
        expect(resolveShortcut(ev({ key: '\\', metaKey: true }))).toBeNull();
        expect(resolveShortcut(ev({ key: 'w', metaKey: true }))).toBeNull();
        expect(resolveShortcut(ev({ key: 'W', ctrlKey: true }))).toBeNull();
    });

    it('returns null for keys that map to no shortcut', () => {
        expect(resolveShortcut(ev({ key: 'a', ctrlKey: true }))).toBeNull();
        expect(resolveShortcut(ev({ key: '0', metaKey: true }))).toBeNull();
    });
});
