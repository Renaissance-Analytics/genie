import { describe, expect, it } from 'vitest';
import { agentViewAction, globalAction, type KeyPress } from '../src/core/keys.js';

/**
 * GLOBAL KEYS. ⌘B / Ctrl+B toggles the workspace file panel (§4.3) from anywhere — a chord with a
 * modifier, so it works while typing too; the agent view's letter keys never fire on it.
 */

const press = (over: Partial<KeyPress>): KeyPress => ({ key: 'b', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, typing: false, ...over });

describe('globalAction', () => {
    it('⌘B and Ctrl+B toggle the file panel, even while typing; a bare b, Alt+B or Shift+⌘B do nothing', () => {
        expect(globalAction(press({ metaKey: true }))).toBe('toggle-files');
        expect(globalAction(press({ ctrlKey: true, typing: true }))).toBe('toggle-files');
        expect(globalAction(press({ key: 'B', metaKey: true }))).toBe('toggle-files');
        expect(globalAction(press({}))).toBeNull();
        expect(globalAction(press({ altKey: true, metaKey: true }))).toBeNull();
        expect(globalAction(press({ shiftKey: true, metaKey: true }))).toBeNull();
        // ⌘K is the Command Window's REMAPPABLE binding (Tynn #759, core/hotkeys.ts) — not a fixed chord here; an unbound
        // chord still does nothing.
        expect(globalAction(press({ key: 'k', metaKey: true }))).toBeNull();
        expect(globalAction(press({ key: 'x', metaKey: true }))).toBeNull();
    });

    // Tynn #759: Ctrl+, (⌘, on macOS) opens Settings — the page's own chord, because a menu accelerator never fired in
    // Genie's window on Linux (CI's real window, #911). A bare comma is text.
    it('Ctrl+, and ⌘, open Settings, even while typing; a bare comma or Alt/Shift with it do nothing', () => {
        expect(globalAction(press({ key: ',', ctrlKey: true }))).toBe('open-settings');
        expect(globalAction(press({ key: ',', metaKey: true, typing: true }))).toBe('open-settings');
        expect(globalAction(press({ key: ',' }))).toBeNull();
        expect(globalAction(press({ key: ',', ctrlKey: true, altKey: true }))).toBeNull();
        expect(globalAction(press({ key: ',', ctrlKey: true, shiftKey: true }))).toBeNull();
    });

    it('the agent view ignores the chord, so one press is one action', () => {
        expect(agentViewAction(press({ metaKey: true }))).toBeNull();
    });
});
