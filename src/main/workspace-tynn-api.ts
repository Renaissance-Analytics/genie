import type { BoardIds, BoardScope } from '../core/tynn-board.js';
import type { HostApiDeps } from './host-api.js';
import { readTynnBoard, runTynnBoardAction, type TynnBoardPorts } from './tynn-board-client.js';
import { runTynnIssueAction, type readTynnIssues } from './tynn-issues-client.js';
import { runTynnPageAction, type readTynnPage } from './tynn-page-client.js';

/**
 * THE TYNN TAB, ONE WIRING FOR EVERY PROCESS THAT ANSWERS IT (Tynn #553, host split P5d.5f). The window and genie-host differ
 * only in how they reach the Tynn account and read a page.
 */
type ReadPage = (workspaceId: string, page: unknown, query: unknown) => ReturnType<typeof readTynnPage>;
type TynnTabKeys = 'tynnBoard' | 'tynnPage' | 'tynnBoardAction' | 'tynnIssues' | 'tynnIssueAction' | 'tynnPageAction';

export function workspaceTynnApi(board: () => TynnBoardPorts | Promise<TynnBoardPorts>, readPage: ReadPage): Pick<HostApiDeps['workspaceOps'], TynnTabKeys> {
    const page: ReadPage = async (id, name, query) => (typeof id !== 'string' || typeof name !== 'string' ? { ok: false, state: 'error', reason: 'name a workspace and a page' } : readPage(id, name, query));
    /** Issues keep their own view's shape, read through the same page door as WIP. */
    const issues = async (id: string, filters: unknown): ReturnType<typeof readTynnIssues> => {
        const answer = await page(id, 'issues', filters);
        if (!answer.ok) return answer;
        return answer.page === 'issues' ? { ok: true, view: answer.view } : { ok: false, state: 'error', reason: 'Tynn answered with a different workspace page.' };
    };
    const isInput = (input: unknown): input is object => typeof input === 'object' && input !== null;
    return {
        tynnBoard: async (id, scope) => readTynnBoard(await board(), id, (scope ?? {}) as BoardScope),
        tynnPage: (id, name, query) => page(id, name, query),
        tynnBoardAction: async (id, input) => (isInput(input) ? runTynnBoardAction(await board(), id, input as { action: string; ids: BoardIds; body?: unknown }) : { ok: false, state: 'error', reason: 'name an action' }),
        tynnIssues: (id, filters) => issues(id, filters ?? {}),
        tynnIssueAction: async (id, input) => (isInput(input) ? runTynnIssueAction(await board(), id, input as { action: string; issueId: string | null; body?: unknown }) : { ok: false, state: 'error', reason: 'name an action' }),
        tynnPageAction: async (id, input) => (isInput(input) ? runTynnPageAction(await board(), id, input as { action: string; body?: unknown }) : { ok: false, state: 'error', reason: 'name a workspace and an action' }),
    };
}
