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
        // ⌘K is the Command Window now (Tynn #757); an unbound chord still does nothing.
        expect(globalAction(press({ key: 'k', metaKey: true }))).toBe('open-palette');
        expect(globalAction(press({ key: 'x', metaKey: true }))).toBeNull();
    });

    it('the agent view ignores the chord, so one press is one action', () => {
        expect(agentViewAction(press({ metaKey: true }))).toBeNull();
    });
});
