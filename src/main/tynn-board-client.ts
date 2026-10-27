/** STUB (red step, genie#1295): the shape the tests name; the behaviour lands in the next commit. */
import type { BoardIds, BoardScope, BoardView } from '../core/tynn-board.js';

export interface TynnBoardPorts {
    signedIn(): boolean;
    projectFor(workspaceId: string): string | null;
    request(path: string, init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}
export type TynnBoardRefusal = { ok: false; state: 'not-linked' | 'signed-out' | 'transition-refused' | 'error'; reason: string };
export async function readTynnBoard(_ports: TynnBoardPorts, _workspaceId: string, _scope: BoardScope): Promise<{ ok: true; view: BoardView } | TynnBoardRefusal> {
    return { ok: false, state: 'error', reason: 'not built' };
}
export async function runTynnBoardAction(_ports: TynnBoardPorts, _workspaceId: string, _input: { action: string; ids: BoardIds; body?: unknown }): Promise<{ ok: true } | TynnBoardRefusal> {
    return { ok: false, state: 'error', reason: 'not built' };
}
