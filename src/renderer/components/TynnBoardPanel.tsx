/** STUB (red step, genie#1295): the props the tests name; the panel lands in the next commit. */
import type { BoardIds, BoardScope, TynnBoardState } from '../../core/tynn-board.js';

export interface TynnBoardPanelProps {
    readonly state: TynnBoardState;
    readonly onScope: (scope: BoardScope) => void;
    readonly onAction: (input: { action: string; ids: BoardIds; body?: { status: string; order: number; override?: boolean } }) => void;
}

export function TynnBoardPanel(_props: TynnBoardPanelProps) {
    return null;
}
