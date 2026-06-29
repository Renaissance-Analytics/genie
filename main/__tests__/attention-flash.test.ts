import { describe, it, expect } from 'vitest';
import {
    shouldFlashWindow,
    resolveAttentionWindow,
    type FlashWindow,
} from '../attention-flash';

/**
 * The pure window-flash decisions (Part B). The imperative `demandWindowAttention`
 * (flashFrame / dock.bounce) is the electron shell and isn't unit-tested here.
 */

function win(opts: { destroyed?: boolean; focused?: boolean }): FlashWindow {
    return {
        isDestroyed: () => !!opts.destroyed,
        isFocused: () => !!opts.focused,
    };
}

describe('shouldFlashWindow', () => {
    it('flashes an unfocused, live window', () => {
        expect(shouldFlashWindow(win({ focused: false }))).toBe(true);
    });

    it('does NOT flash a focused window (the user is already looking)', () => {
        expect(shouldFlashWindow(win({ focused: true }))).toBe(false);
    });

    it('does NOT flash a destroyed window', () => {
        expect(shouldFlashWindow(win({ destroyed: true, focused: false }))).toBe(false);
    });

    it('does NOT flash a missing window (null / undefined)', () => {
        expect(shouldFlashWindow(null)).toBe(false);
        expect(shouldFlashWindow(undefined)).toBe(false);
    });
});

describe('resolveAttentionWindow (pick the right window among several)', () => {
    const master = { tag: 'master' };
    const hostA = { tag: 'hostA' };
    const hostB = { tag: 'hostB' };
    const hostWindows = new Map<string, { tag: string }>([
        ['conn-a', hostA],
        ['conn-b', hostB],
    ]);

    it('picks the master window for a LOCAL workspace (no connKey)', () => {
        expect(resolveAttentionWindow(null, master, hostWindows)).toBe(master);
        expect(resolveAttentionWindow(undefined, master, hostWindows)).toBe(master);
    });

    it('picks the SPECIFIC host window for a remote workspace, not the master', () => {
        expect(resolveAttentionWindow('conn-a', master, hostWindows)).toBe(hostA);
        expect(resolveAttentionWindow('conn-b', master, hostWindows)).toBe(hostB);
    });

    it('returns null when the host window for the connKey is not open', () => {
        expect(resolveAttentionWindow('conn-gone', master, hostWindows)).toBeNull();
    });

    it('returns null when there is no master window for a local alert', () => {
        expect(resolveAttentionWindow(null, null, hostWindows)).toBeNull();
    });
});
