/**
 * Pure helpers for the grid's PANEL drag-reorder (the in-workspace tiles), kept
 * free of React/DOM so the ordering maths is unit-testable — same split as
 * `terminal-grid-layout.ts` and `master-shortcuts.ts`.
 *
 * The persisted order lives on `terminal_specs.sort_order` (main/db.ts), which
 * is what `terminalSpec.list()` sorts by. So the renderer only ever has to
 * (a) compute the new id order and (b) apply it to the flat `specs` array it
 * holds, then hand the same id list to `terminalSpec.reorder()`.
 */
import type { DragEvent } from 'react';
import type { TerminalSpec } from './genie';

/**
 * The drag wiring one panel needs. TerminalGrid owns the drag state and hands
 * each tile its own bundle; the panel components (terminal / code / plugin)
 * just spread it — `draggable` + start/end on the panel HEAD (so dragging never
 * competes with text selection inside a terminal or editor), over/drop on the
 * panel ROOT (so the whole tile is a drop target).
 */
export interface PanelDragHandlers {
    /** True while THIS panel is the one being dragged. */
    dragging: boolean;
    onDragStart: (e: DragEvent<HTMLElement>) => void;
    onDragEnd: (e: DragEvent<HTMLElement>) => void;
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
}

/**
 * Move `dragId` to `overId`'s slot, shifting the rest. Returns the SAME array
 * reference when nothing moves (unknown id, self-drop, no-op) so callers can
 * skip a pointless state update + IPC.
 */
export function movePanel(ids: string[], dragId: string, overId: string): string[] {
    if (dragId === overId) return ids;
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(overId);
    if (from === -1 || to === -1 || from === to) return ids;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, dragId);
    return next;
}

/**
 * Apply a reordered id list to the FLAT cross-workspace `specs` array.
 *
 * Only the specs named in `orderedIds` are rearranged; every other spec keeps
 * its exact position. We walk the original array and, at each slot occupied by
 * a member of the reordered set, emit the next id from `orderedIds`. That way a
 * reorder of one workspace's panels can never disturb another workspace's specs
 * (they're interleaved in the flat list) and no spec is dropped or duplicated.
 *
 * Ids in `orderedIds` that aren't in `specs` are ignored.
 */
export function applyPanelOrder(
    specs: TerminalSpec[],
    orderedIds: string[],
): TerminalSpec[] {
    const byId = new Map(specs.map((s) => [s.id, s]));
    const queue = orderedIds.filter((id) => byId.has(id));
    if (queue.length === 0) return specs;
    const inSet = new Set(queue);
    let cursor = 0;
    return specs.map((s) => (inSet.has(s.id) ? byId.get(queue[cursor++])! : s));
}
