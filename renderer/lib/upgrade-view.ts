import { useSyncExternalStore } from 'react';

import type { UpgradeViewState } from './drain-roster';

/**
 * WHAT THE USER HAS DECIDED ABOUT THE PENDING UPGRADE (genie#622).
 *
 * Two intents, and neither of them belongs to the drain:
 *
 *  - *am I looking at it* — the header control opens the window; ✕, Esc and
 *    the backdrop close it;
 *  - *have I committed to it* — one press of the upgrade button, which the
 *    header pill's driver then carries through (apply → restart).
 *
 * They live in a module store rather than in either component's `useState`
 * because the control that opens the window and the window itself sit far apart
 * in the tree, and threading a callback between them would mean props through
 * every layer in between. `FilePickerHost` keeps its request the same way, for
 * the same reason.
 *
 * ## This module deliberately cannot do anything
 *
 * It sets three booleans and tells its subscribers. That is the fix: the reason
 * closing the window used to cancel the upgrade is that the only dismissing
 * control called `cancelUpgradeDrain`, which clears the restore roster — the
 * list that brings every agent back afterwards (genie#551). A view-state change
 * must not be able to reach that, and the cheapest guarantee is that nothing
 * here can reach anything: React for the subscription, one erased type import,
 * and no IPC.
 */

/** The user's decisions. {@link UpgradeViewState} is the half the plan reads. */
export interface UpgradeView extends UpgradeViewState {
    /**
     * The upgrade button has been pressed and the flow is driving itself from
     * here — the pill's one-shot driver takes over. Survives closing the
     * window; only an upgrade that DIES (errored, moot, or a cancelled drain)
     * resets it.
     */
    committed: boolean;
    /**
     * A restart has already been asked for, so nothing may ask again.
     *
     * Shared rather than a ref in either component because BOTH can start one:
     * the window's held-restart button, and the pill's driver on the states it
     * carries hands-free. Two `quitAndInstall` calls are the double-install /
     * double-quit race `shouldDriveRestart` exists to prevent, and once the two
     * callers lived in different components a private ref could not see the
     * other one.
     */
    restartDriven: boolean;
}

const INITIAL: UpgradeView = {
    intent: 'auto',
    forDrain: null,
    committed: false,
    restartDriven: false,
};

let state: UpgradeView = INITIAL;
const listeners = new Set<() => void>();

function set(next: Partial<UpgradeView>): void {
    // A NEW object every time, or `useSyncExternalStore` compares the snapshot
    // it already has against itself and nothing re-renders.
    state = { ...state, ...next };
    for (const listener of listeners) listener();
}

export function getUpgradeView(): UpgradeView {
    return state;
}

export function subscribeUpgradeView(onChange: () => void): () => void {
    listeners.add(onChange);
    return () => {
        listeners.delete(onChange);
    };
}

/**
 * Show the window. From the header control, which offers it for as long as an
 * upgrade is staged — so reopening after a cancel is one click rather than a
 * restart of the whole flow.
 *
 * Clears `forDrain`: an explicit open outranks whatever the last dismissal was
 * about.
 */
export function openUpgradeView(): void {
    set({ intent: 'open', forDrain: null });
}

/**
 * Dismiss the window, and nothing else.
 *
 * `forDrain` is the `startedAt` of the drain on screen when the user closed it,
 * or null if there was none. Scoping it that way is what lets the NEXT drain
 * still put itself up: genie#565's gate is not something one ✕ may disarm.
 */
export function closeUpgradeView(forDrain: number | null): void {
    set({ intent: 'closed', forDrain });
}

/** The user pressed the upgrade button. */
export function commitUpgrade(): void {
    set({ committed: true });
}

/** A restart is on its way — whoever asks next must not ask again. */
export function markRestartDriven(): void {
    set({ restartDriven: true });
}

/** The upgrade this commit was riding is over — hand the control back. */
export function resetUpgradeCommit(): void {
    set({ committed: false, restartDriven: false });
}

export function useUpgradeView(): UpgradeView {
    return useSyncExternalStore(subscribeUpgradeView, getUpgradeView, getUpgradeView);
}

/** TEST ONLY — a module singleton outlives the test that changed it. */
export function __resetUpgradeView(): void {
    state = INITIAL;
    for (const listener of listeners) listener();
}
