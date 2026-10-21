/**
 * THE ACTIVE PLAN COLUMN, OPEN OR HIDDEN (beta.33 item 11). The owner (FTQ q_99659edf note, 2026-10-20): "the plan column
 * … needs to be able to collapse with a button in the top right of the workspace tab row that opens and hides it."
 *
 * Remembered on THIS device, as the rail's collapse is (Sidebar.tsx, Tynn #799): how wide a screen is, and so whether a
 * column fits beside the chat, is the device's business, not the host's.
 */
export const PLAN_COLLAPSED_KEY = 'genie.plan.collapsed';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** Open unless hidden here; a store that is missing or refuses never hides the plan. */
export function readPlanOpen(storage: Store | null): boolean {
    try { return storage?.getItem(PLAN_COLLAPSED_KEY) !== '1'; } catch { return true; }
}

export function writePlanOpen(storage: Store | null, open: boolean): void {
    try { storage?.setItem(PLAN_COLLAPSED_KEY, open ? '0' : '1'); } catch { /* a preference that cannot be saved still applies now */ }
}
