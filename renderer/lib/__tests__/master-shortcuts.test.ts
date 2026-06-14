import { describe, expect, it } from 'vitest';
import { resolveShortcut, type ShortcutKeyEvent } from '../master-shortcuts';

/**
 * Unit tests for the pure keyboard-shortcut intent resolver that backs the
 * master footer hint ("⌘1–9 focus · ⌘\ pin tree · ⌘W close panel"). The
 * master.tsx effect maps each resolved intent to a state mutation; here we just
 * assert the key→intent mapping (focus/pin/close) and the modifier guards.
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
    it('maps ⌘/Ctrl + 1–9 to a 0-based focus intent', () => {
        expect(resolveShortcut(ev({ key: '1', metaKey: true }))).toEqual({
            kind: 'focus',
            index: 0,
        });
        expect(resolveShortcut(ev({ key: '9', ctrlKey: true }))).toEqual({
            kind: 'focus',
            index: 8,
        });
        // Both meta (mac) and ctrl (win/linux) trigger it.
        expect(resolveShortcut(ev({ key: '3', ctrlKey: true }))).toEqual({
            kind: 'focus',
            index: 2,
        });
    });

    it('maps ⌘/Ctrl + \\ to a pin (toggle tree) intent', () => {
        expect(resolveShortcut(ev({ key: '\\', metaKey: true }))).toEqual({
            kind: 'pin',
        });
        expect(resolveShortcut(ev({ key: '\\', ctrlKey: true }))).toEqual({
            kind: 'pin',
        });
    });

    it('maps ⌘/Ctrl + W (either case) to a close intent', () => {
        expect(resolveShortcut(ev({ key: 'w', metaKey: true }))).toEqual({
            kind: 'close',
        });
        expect(resolveShortcut(ev({ key: 'W', ctrlKey: true }))).toEqual({
            kind: 'close',
        });
    });

    it('requires the ⌘/Ctrl modifier — bare keys are ignored', () => {
        expect(resolveShortcut(ev({ key: '1' }))).toBeNull();
        expect(resolveShortcut(ev({ key: '\\' }))).toBeNull();
        expect(resolveShortcut(ev({ key: 'w' }))).toBeNull();
    });

    it('ignores the combo when Alt is held (avoid clobbering OS/app combos)', () => {
        expect(resolveShortcut(ev({ key: '1', metaKey: true, altKey: true }))).toBeNull();
        expect(resolveShortcut(ev({ key: 'w', ctrlKey: true, altKey: true }))).toBeNull();
    });

    it('ignores Shift+number and Shift+W (reserved for other combos)', () => {
        expect(resolveShortcut(ev({ key: '1', metaKey: true, shiftKey: true }))).toBeNull();
        expect(resolveShortcut(ev({ key: 'W', ctrlKey: true, shiftKey: true }))).toBeNull();
    });

    it('returns null for keys that map to no shortcut', () => {
        expect(resolveShortcut(ev({ key: '0', metaKey: true }))).toBeNull();
        expect(resolveShortcut(ev({ key: 'a', ctrlKey: true }))).toBeNull();
    });
});
