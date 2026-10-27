import { boardActionRequest, boardQueryPath, parseBoard, type BoardIds, type BoardScope, type BoardView } from '../core/tynn-board.js';

/**
 * THE TYNN TAB TALKS TO TYNN AS AN APP (genie#1295; the owner, 2026-10-27: "the mcp is for agents, the api is for apps").
 *
 * Every call goes through the person's PAIRING (TynnAccount.request: Bearer `gpk_`, `/api/v1/*` only, Tynn's 404-means-
 * not-authorized handling) — never an agent's MCP key. The project is the WORKSPACE's, read from its project.json on this
 * side (`projectFor`): the tab has no project picker, and a window cannot name some other project.
 *
 * Tynn answers every refusal with a 404 (no `genie:board` scope on an older pairing, no access to the project, a role
 * that may not write); an illegal workflow step is a 422 whose `errors.status` says why, in Tynn's words.
 */
export interface TynnBoardPorts {
    signedIn(): boolean;
    projectFor(workspaceId: string): string | null;
    request(path: string, init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

export type TynnBoardRefusal = { ok: false; state: 'not-linked' | 'signed-out' | 'transition-refused' | 'error'; reason: string };

const NOT_LINKED: TynnBoardRefusal = { ok: false, state: 'not-linked', reason: 'This workspace has no Tynn project.' };
const SIGNED_OUT: TynnBoardRefusal = { ok: false, state: 'signed-out', reason: 'Genie is not signed in to Tynn. Settings → Accounts → Tynn.' };
const REFUSED: TynnBoardRefusal = {
    ok: false,
    state: 'signed-out',
    reason: 'Tynn did not show this board to this Genie. Sign in to Tynn again (Settings → Accounts → Tynn) so the pairing includes the board.',
};

async function bodyOf(res: { json(): Promise<unknown> }): Promise<unknown> {
    try { return await res.json(); } catch { return null; }
}

/** Tynn's own words for a refusal: the first `errors.status` message, else `message`, else the status. */
async function refusal(res: { status: number; json(): Promise<unknown> }): Promise<TynnBoardRefusal> {
    if (res.status === 404 || res.status === 401 || res.status === 403) return REFUSED;
    const body = (await bodyOf(res)) as { message?: unknown; errors?: Record<string, unknown> } | null;
    const firstError = body?.errors ? Object.values(body.errors).flat().find((m): m is string => typeof m === 'string') : undefined;
    const reason = firstError ?? (typeof body?.message === 'string' && body.message !== '' ? body.message : `Tynn answered ${res.status}`);
    return { ok: false, state: res.status === 422 ? 'transition-refused' : 'error', reason };
}

function scopeOf(raw: unknown): BoardScope {
    const s = (raw ?? {}) as { version?: unknown; story?: unknown };
    return typeof s.story === 'string' && s.story !== '' ? { story: s.story } : typeof s.version === 'string' && s.version !== '' ? { version: s.version } : {};
}

/** The workspace's board at a scope (`{}` versions, `{version}` its stories, `{story}` its tasks). */
export async function readTynnBoard(ports: TynnBoardPorts, workspaceId: string, scope: BoardScope): Promise<{ ok: true; view: BoardView } | TynnBoardRefusal> {
    const projectId = ports.projectFor(workspaceId);
    if (projectId === null) return NOT_LINKED;
    if (!ports.signedIn()) return SIGNED_OUT;
    let res;
    try { res = await ports.request(boardQueryPath(projectId, scopeOf(scope)), { method: 'GET' }); }
    catch (error) { return { ok: false, state: 'error', reason: error instanceof Error ? error.message : String(error) }; }
    if (!res.ok) return refusal(res);
    const view = parseBoard(await bodyOf(res));
    return view ? { ok: true, view } : { ok: false, state: 'error', reason: 'Tynn answered with something that is not a board.' };
}

/** A drag: the column, the place in it, and the person's Shift override. Anything else is not sent. */
function dragBody(raw: unknown): { status: string; order: number; override?: boolean } | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const b = raw as { status?: unknown; order?: unknown; override?: unknown };
    if (typeof b.status !== 'string' || b.status === '' || typeof b.order !== 'number' || !Number.isInteger(b.order)) return null;
    return { status: b.status, order: b.order, ...(b.override === true ? { override: true } : {}) };
}

/** One action on the board, by the contract's id (`task.start`, `story.move`, `version.delete`…). */
export async function runTynnBoardAction(ports: TynnBoardPorts, workspaceId: string, input: { action: string; ids: BoardIds; body?: unknown }): Promise<{ ok: true } | TynnBoardRefusal> {
    const projectId = ports.projectFor(workspaceId);
    if (projectId === null) return NOT_LINKED;
    const request = boardActionRequest(projectId, input.action, input.ids ?? {});
    if (request === null) return { ok: false, state: 'error', reason: `The Tynn tab does not offer ${input.action}.` };
    const isMove = input.action.endsWith('.move');
    const body = isMove ? dragBody(input.body) : null;
    if (isMove && body === null) return { ok: false, state: 'error', reason: 'A move names a column and a place in it.' };
    if (!ports.signedIn()) return SIGNED_OUT;
    let res;
    try { res = await ports.request(request.path, { method: request.method, ...(body ? { body } : {}) }); }
    catch (error) { return { ok: false, state: 'error', reason: error instanceof Error ? error.message : String(error) }; }
    return res.ok ? { ok: true } : refusal(res);
}
