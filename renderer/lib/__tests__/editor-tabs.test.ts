import { describe, expect, it } from 'vitest';
import { closeTab, openTab, reconcileTabs } from '../editor-tabs';

describe('openTab', () => {
    it('appends a new path and makes it active', () => {
        expect(openTab(['a.ts'], 'b.ts')).toEqual({
            open: ['a.ts', 'b.ts'],
            active: 'b.ts',
        });
    });

    it('does not duplicate an already-open path but re-activates it', () => {
        expect(openTab(['a.ts', 'b.ts'], 'a.ts')).toEqual({
            open: ['a.ts', 'b.ts'],
            active: 'a.ts',
        });
    });

    it('opens into an empty set', () => {
        expect(openTab([], 'a.ts')).toEqual({ open: ['a.ts'], active: 'a.ts' });
    });
});

describe('closeTab', () => {
    it('activates the same-index neighbour when the active tab closes', () => {
        // Close the middle (active) tab → the tab that shifts into its slot.
        expect(closeTab(['a', 'b', 'c'], 'b', 'b')).toEqual({
            open: ['a', 'c'],
            active: 'c',
        });
    });

    it('activates the new last tab when the rightmost active tab closes', () => {
        expect(closeTab(['a', 'b', 'c'], 'c', 'c')).toEqual({
            open: ['a', 'b'],
            active: 'b',
        });
    });

    it('keeps the active tab when a different tab closes', () => {
        expect(closeTab(['a', 'b', 'c'], 'a', 'c')).toEqual({
            open: ['a', 'b'],
            active: 'a',
        });
    });

    it('clears active when the last tab closes', () => {
        expect(closeTab(['a'], 'a', 'a')).toEqual({ open: [], active: null });
    });
});

describe('reconcileTabs', () => {
    it('drops persisted tabs whose files no longer loaded', () => {
        expect(reconcileTabs(['a', 'b', 'c'], ['a', 'c'], 'b')).toEqual({
            open: ['a', 'c'],
            active: 'a', // seedActive 'b' is gone → first survivor
        });
    });

    it('keeps the persisted active tab when it survived', () => {
        expect(reconcileTabs(['a', 'b'], ['a', 'b'], 'b')).toEqual({
            open: ['a', 'b'],
            active: 'b',
        });
    });

    it('returns an empty state when nothing loaded', () => {
        expect(reconcileTabs(['a'], [], 'a')).toEqual({ open: [], active: null });
    });
});
