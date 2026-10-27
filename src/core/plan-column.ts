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

/**
 * THE COLUMN'S WIDTH (genie#1280; the owner, 2026-10-27: "Let users resize the plan column too. This gets crowded and hard
 * to read."). Its left edge drags like the chat's (Tynn #798, core/chat-width.ts), and the width is kept on this device
 * beside the collapse above. Genie 1's resizable panes did the same: every split dragged, clamped at a floor
 * (MIN_PANEL_PX), persisted, and a double-click on the gutter reset it (v0.7.0-beta.342
 * `renderer/components/Master/TerminalGrid.tsx:111,436-470,694-695`).
 */
export const PLAN_WIDTH_KEY = 'genie.plan.width';
/** The width the column was designed at (the old fixed `w-[260px]`). */
export const PLAN_WIDTH_DEFAULT = 260;
/** Narrower than this, a step wraps a word to a line. */
export const PLAN_WIDTH_MIN = 200;
/** Wider than this, it takes the Agent view's room for little gain. */
export const PLAN_WIDTH_MAX = 640;
/** Dragged this far past the floor, the column collapses; the toggle in the workspace tab row brings it back. */
const PLAN_COLLAPSE_BELOW = PLAN_WIDTH_MIN - 80;

export function clampPlanWidth(width: number): number {
    return Math.min(PLAN_WIDTH_MAX, Math.max(PLAN_WIDTH_MIN, Math.round(width)));
}

export function readPlanWidth(storage: Store | null | undefined): number {
    let raw: string | null = null;
    try { raw = storage?.getItem(PLAN_WIDTH_KEY) ?? null; } catch { /* unreadable: the designed width */ }
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(n) ? clampPlanWidth(n) : PLAN_WIDTH_DEFAULT;
}

export function writePlanWidth(storage: Store | null | undefined, width: number): void {
    try { storage?.setItem(PLAN_WIDTH_KEY, String(clampPlanWidth(width))); } catch { /* kept for this window only */ }
}

/**
 * A drag of the column's LEFT edge (the column is anchored right, against the chat). `dx` is how far the pointer moved
 * right. Leftward widens; rightward narrows to the floor, and well past the floor the column collapses.
 */
export function planDragWidth(from: number, dx: number): number | 'collapse' {
    const raw = from - dx;
    return raw < PLAN_COLLAPSE_BELOW ? 'collapse' : clampPlanWidth(raw);
}
