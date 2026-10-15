import type { IndexLive, IndexSection } from './agent-index.js';

/**
 * THE INDEX COLUMN, COLLAPSED (the owner, 2026-10-14: "the Turns column should be collapseable to just the number").
 *
 * Collapsed, the column is a narrow strip of turn NUMBERS, newest first as in the full column, each still a door to its
 * turn and still carrying the live dot. Files and compactions are not in the strip: they have no number to show. The
 * choice is remembered in the renderer's localStorage beside the chat's width (`genie.chat.width`).
 */
export const INDEX_COLLAPSED_KEY = 'genie.index.collapsed';

type FlagStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** `false` (the full column) unless the person collapsed it; storage that throws or is absent reads as never set. */
export function readIndexCollapsed(storage: FlagStorage | null | undefined): boolean {
    try {
        return storage?.getItem(INDEX_COLLAPSED_KEY) === '1';
    } catch {
        return false;
    }
}

export function writeIndexCollapsed(storage: FlagStorage | null | undefined, collapsed: boolean): void {
    try {
        storage?.setItem(INDEX_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
        /* a full or refused storage keeps the choice for this view only */
    }
}

export interface TurnNumber {
    id: string;
    n: number;
    live: IndexLive | null;
    selected: boolean;
    rowId: string;
}

/** The Turns section's items as bare numbers, in the column's own order. */
export function turnNumbers(sections: readonly IndexSection[]): TurnNumber[] {
    const turns = sections.find((s) => s.title === 'Turns');
    if (!turns) return [];
    return turns.items.flatMap((item) => {
        const m = /^turn:(\d+)$/.exec(item.id);
        return m ? [{ id: item.id, n: Number(m[1]), live: item.live, selected: item.selected, rowId: item.rowId }] : [];
    });
}
