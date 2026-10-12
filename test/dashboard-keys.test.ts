import { describe, expect, it } from 'vitest';
import { dashboardAction, stepFocus } from '../src/core/keys.js';

/**
 * THE DASHBOARD'S KEYS (the board, §4.1): `J`/`K` move the row cursor, `↵` opens the focused agent, `G` cycles the
 * grouping. `A`/`D` are deliberately unbound here — the Dashboard resolves nothing. And an unmodified letter must never
 * act while a human is typing.
 */
const press = (key: string, over: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; typing: boolean }> = {}) =>
    ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, typing: false, ...over });

describe('dashboardAction', () => {
    it('j/k step the cursor, Enter opens, g cycles the grouping; a/d do nothing here', () => {
        expect(dashboardAction(press('j'))).toBe('next-row');
        expect(dashboardAction(press('k'))).toBe('prev-row');
        expect(dashboardAction(press('J'))).toBe('next-row');
        expect(dashboardAction(press('Enter'))).toBe('open');
        expect(dashboardAction(press('g'))).toBe('cycle-group');
        expect(dashboardAction(press('a'))).toBeNull();
        expect(dashboardAction(press('d'))).toBeNull();
    });

    it('inert while typing, and with a modifier (those are chords for other things)', () => {
        expect(dashboardAction(press('j', { typing: true }))).toBeNull();
        expect(dashboardAction(press('Enter', { typing: true }))).toBeNull();
        expect(dashboardAction(press('j', { metaKey: true }))).toBeNull();
        expect(dashboardAction(press('g', { ctrlKey: true }))).toBeNull();
    });
});

describe('stepFocus', () => {
    const ids = ['a', 'b', 'c'];
    it('moves within the visible rows and stops at the ends; from nothing, next is the first and prev is the last', () => {
        expect(stepFocus(ids, 'a', 1)).toBe('b');
        expect(stepFocus(ids, 'c', 1)).toBe('c');
        expect(stepFocus(ids, 'a', -1)).toBe('a');
        expect(stepFocus(ids, null, 1)).toBe('a');
        expect(stepFocus(ids, null, -1)).toBe('c');
        // A cursor on a row that vanished (regrouped away) starts over, rather than pointing at nothing.
        expect(stepFocus(ids, 'zz', 1)).toBe('a');
        expect(stepFocus([], 'a', 1)).toBeNull();
    });
});
