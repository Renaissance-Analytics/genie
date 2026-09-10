import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
    __resetUpgradeView,
    closeUpgradeView,
    commitUpgrade,
    getUpgradeView,
    markRestartDriven,
    openUpgradeView,
    resetUpgradeCommit,
    subscribeUpgradeView,
} from '../upgrade-view';

/**
 * WHAT THE USER HAS DECIDED ABOUT THE PENDING UPGRADE (genie#622).
 *
 * Two intents, and neither of them belongs to the drain:
 *
 *  - *am I looking at it* — the header control opens the window, ✕ / Esc /
 *    backdrop close it;
 *  - *have I committed to it* — one press of the upgrade button, which the
 *    pill's driver then carries through.
 *
 * They live in a module store rather than either component's `useState` because
 * the control that opens the window (the header label) and the window itself
 * are far apart in the tree — the same reason `FilePickerHost` keeps its
 * request here. Closing was previously `drain.cancel()`, which is how "close
 * the window" came to mean "abandon the upgrade".
 */
describe('the upgrade view store', () => {
    beforeEach(() => {
        __resetUpgradeView();
    });

    it('starts with no intent at all, so the drain gate decides', () => {
        expect(getUpgradeView()).toEqual({
            intent: 'auto',
            forDrain: null,
            committed: false,
            restartDriven: false,
        });
    });

    it('opens on request, and forgets which drain a previous close was about', () => {
        closeUpgradeView(1_000);
        openUpgradeView();
        expect(getUpgradeView().intent).toBe('open');
        expect(getUpgradeView().forDrain).toBe(null);
    });

    it('records WHICH drain the close was about', () => {
        // So the next drain — a different `startedAt` — is not silenced by a
        // dismissal that was about the last one.
        closeUpgradeView(1_234);
        expect(getUpgradeView()).toEqual({
            intent: 'closed',
            forDrain: 1_234,
            committed: false,
            restartDriven: false,
        });
    });

    it('closing a preview records no drain, because there was none', () => {
        closeUpgradeView(null);
        expect(getUpgradeView().forDrain).toBe(null);
    });

    it('keeps the commit across an open and a close', () => {
        // Closing the window is not abandoning the upgrade. The commit is a
        // separate decision and only `resetUpgradeCommit` (a cancelled or dead
        // update) undoes it.
        commitUpgrade();
        closeUpgradeView(7);
        expect(getUpgradeView().committed).toBe(true);
        openUpgradeView();
        expect(getUpgradeView().committed).toBe(true);
        resetUpgradeCommit();
        expect(getUpgradeView().committed).toBe(false);
    });

    it('remembers that a restart is already on its way, and forgets on a reset', () => {
        // Both the window's held-restart button and the pill's driver can start
        // one. Two `quitAndInstall` calls is the double-install race, and a ref
        // private to one component cannot see the other's.
        expect(getUpgradeView().restartDriven).toBe(false);
        markRestartDriven();
        expect(getUpgradeView().restartDriven).toBe(true);
        resetUpgradeCommit();
        expect(getUpgradeView().restartDriven).toBe(false);
    });

    it('tells its subscribers, and stops when they unsubscribe', () => {
        const seen = vi.fn();
        const off = subscribeUpgradeView(seen);
        openUpgradeView();
        closeUpgradeView(1);
        expect(seen).toHaveBeenCalledTimes(2);
        off();
        openUpgradeView();
        expect(seen).toHaveBeenCalledTimes(2);
    });

    it('hands back a new object each change, so useSyncExternalStore re-renders', () => {
        const first = getUpgradeView();
        openUpgradeView();
        expect(getUpgradeView()).not.toBe(first);
    });
});

/**
 * The load-bearing half: this module may not be able to touch the drain.
 *
 * `cancelUpgradeDrain` clears the restore roster — the list that brings every
 * agent back after the upgrade (genie#551). A view-state change must not be
 * able to reach it, and the cheapest guarantee is that the store has no way to:
 * it imports nothing but React.
 */
describe('closing the window cannot touch the drain', () => {
    const src = readFileSync(path.resolve(__dirname, '../upgrade-view.ts'), 'utf8');

    it('reads the module it claims to be checking', () => {
        // The positive control: "X is absent" passes on an empty file too.
        expect(src.length).toBeGreaterThan(1_000);
        expect(src).toContain('export function closeUpgradeView');
    });

    it('imports nothing that could cancel or restart anything', () => {
        // React for the subscription, and one TYPE — erased at build time, so
        // it is not even a runtime edge. Nothing else is reachable from here.
        const imports = [...src.matchAll(/from '([^']+)';/g)].map((m) => m[1]).sort();
        expect(imports).toEqual(['./drain-roster', 'react']);
    });

    it('makes no IPC call of any kind', () => {
        expect(src).not.toContain('api()');
    });
});
