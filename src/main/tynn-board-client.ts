import {
    assignBody,
    boardActionRequest,
    boardChangesPath,
    boardDetailRequest,
    boardQueryPath,
    createBody,
    editBody,
    parseBoard,
    parseBoardChanges,
    parseClaimants,
    parseDetail,
    type BoardChanges,
    type BoardDetail,
    type BoardIds,
    type BoardMethod,
    type BoardScope,
    type BoardView,
    type Claimant,
} from '../core/tynn-board.js';

/**
 * THE TYNN TAB TALKS TO TYNN AS AN APP (genie#1295; the owner, 2026-10-27: "the mcp is for agents, the api is for apps").
 *
 * Every call goes through the person's PAIRING (TynnAccount.request: Bearer `gpk_`, `/api/v1/*` only, Tynn's 404-means-
 * not-authorized handling) — never an agent's MCP key. The project is the WORKSPACE's, read from its project.json on this
 * side (`projectFor`): the tab has no project picker, and a window cannot name some other project.
 *
 * Tynn answers every refusal with a 404 (no `genie:board` scope on an older pairing, no access to the project, a role
 * that may not write); an illegal step is a 422 that says why in Tynn's words: `errors.status` for a workflow step,
 * `errors.claim` for a claim the project's rules refuse, `errors.assignee` for a claimant not on the project.
 */
export interface TynnBoardPorts {
    signedIn(): boolean;
    projectFor(workspaceId: string): string | null;
    request(path: string, init: { method: BoardMethod; body?: unknown }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
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
    const s = (raw ?? {}) as { version?: unknown; story?: unknown; focus?: unknown };
    const at: BoardScope = typeof s.story === 'string' && s.story !== '' ? { story: s.story } : typeof s.version === 'string' && s.version !== '' ? { version: s.version } : {};
    return typeof s.focus === 'string' && /^(story|task):./.test(s.focus) ? { ...at, focus: s.focus } : at;
}

type BoardRead = { ok: true; view: BoardView; detail?: BoardDetail | null; detailRefused?: string | null };

/**
 * The workspace's board at a scope (`{}` versions, `{version}` its stories, `{story}` its tasks) and, when the scope
 * names a focus (`story:<id>` / `task:<id>`, tynn.ai's `?focus=`), that card's detail. A detail Tynn will not show is said
 * beside the board; it never takes the board away.
 */
export async function readTynnBoard(ports: TynnBoardPorts, workspaceId: string, scope: BoardScope): Promise<BoardRead | TynnBoardRefusal> {
    const projectId = ports.projectFor(workspaceId);
    if (projectId === null) return NOT_LINKED;
    if (!ports.signedIn()) return SIGNED_OUT;
    const at = scopeOf(scope);
    let res;
    try { res = await ports.request(boardQueryPath(projectId, at), { method: 'GET' }); }
    catch (error) { return { ok: false, state: 'error', reason: error instanceof Error ? error.message : String(error) }; }
    if (!res.ok) return refusal(res);
    const view = parseBoard(await bodyOf(res));
    if (!view) return { ok: false, state: 'error', reason: 'Tynn answered with something that is not a board.' };

    const detailCall = boardDetailRequest(projectId, at.focus);
    if (detailCall === null) return { ok: true, view };
    let dres;
    try { dres = await ports.request(detailCall.path, { method: 'GET' }); }
    catch (error) { return { ok: true, view, detail: null, detailRefused: error instanceof Error ? error.message : String(error) }; }
    if (!dres.ok) {
        const why = dres.status === 404 ? 'Tynn did not show this card. It may have been deleted, or it is not in this project.' : (await refusal(dres)).reason;
        return { ok: true, view, detail: null, detailRefused: why };
    }
    const detail = parseDetail(await bodyOf(dres));
    return detail ? { ok: true, view, detail } : { ok: true, view, detail: null, detailRefused: 'Tynn answered with something that is not a card.' };
}

/** A drag: the column, the place in it, and the person's Shift override. Anything else is not sent. */
function dragBody(raw: unknown): { status: string; order: number; override?: boolean } | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const b = raw as { status?: unknown; order?: unknown; override?: unknown };
    if (typeof b.status !== 'string' || b.status === '' || typeof b.order !== 'number' || !Number.isInteger(b.order)) return null;
    return { status: b.status, order: b.order, ...(b.override === true ? { override: true } : {}) };
}

/** The project's eligible claimants (GET /claimants), for the Assign picker. */
async function readClaimants(ports: TynnBoardPorts, path: string): Promise<{ ok: true; claimants: Claimant[] } | TynnBoardRefusal> {
    if (!ports.signedIn()) return SIGNED_OUT;
    let res;
    try { res = await ports.request(path, { method: 'GET' }); }
    catch (error) { return { ok: false, state: 'error', reason: error instanceof Error ? error.message : String(error) }; }
    return res.ok ? { ok: true, claimants: parseClaimants(await bodyOf(res)) } : refusal(res);
}

/** One action on the board, by the contract's id (`task.start`, `story.move`, `version.delete`…). */
export async function runTynnBoardAction(ports: TynnBoardPorts, workspaceId: string, input: { action: string; ids: BoardIds; body?: unknown }): Promise<{ ok: true; claimants?: Claimant[] } | TynnBoardRefusal> {
    const projectId = ports.projectFor(workspaceId);
    if (projectId === null) return NOT_LINKED;
    const request = boardActionRequest(projectId, input.action, input.ids ?? {});
    if (request === null) return { ok: false, state: 'error', reason: `The Tynn tab does not offer ${input.action}.` };
    if (input.action === 'board.claimants') return readClaimants(ports, request.path);
    if (request.method === 'GET') return { ok: false, state: 'error', reason: `${input.action} is read with the board (its focus), not run.` };
    const [kind, verb] = input.action.split('.') as [string, string];
    let body: unknown = null;
    if (verb === 'move') {
        body = dragBody(input.body);
        if (body === null) return { ok: false, state: 'error', reason: 'A move names a column and a place in it.' };
    } else if (verb === 'create' && (kind === 'story' || kind === 'task')) {
        body = createBody(kind, input.ids ?? {}, input.body);
        if (body === null) return { ok: false, state: 'error', reason: `A new ${kind} needs a title and a description.` };
    } else if (verb === 'edit' && (kind === 'story' || kind === 'task')) {
        body = editBody(kind, input.body);
        if (body === null) return { ok: false, state: 'error', reason: 'Nothing to save, or the title is empty.' };
    } else if (verb === 'assign') {
        body = assignBody(input.body);
        if (body === null) return { ok: false, state: 'error', reason: 'Pick a person or an agent to assign.' };
    }
    if (!ports.signedIn()) return SIGNED_OUT;
    let res;
    try { res = await ports.request(request.path, { method: request.method, ...(body ? { body } : {}) }); }
    catch (error) { return { ok: false, state: 'error', reason: error instanceof Error ? error.message : String(error) }; }
    return res.ok ? { ok: true } : refusal(res);
}

/**
 * Row B4: what changed on the workspace's board since a cursor (GET /board/changes), and — when the open card (the
 * scope's focus) is among the rows that changed — that card's detail again, so an edit made elsewhere shows in the
 * flyout too. Never the whole board.
 */
export async function readTynnBoardChanges(
    ports: TynnBoardPorts,
    workspaceId: string,
    scope: BoardScope,
    cursor: string,
    ids: readonly string[],
): Promise<{ ok: true; changes: BoardChanges; detail?: BoardDetail | null } | TynnBoardRefusal> {
    const projectId = ports.projectFor(workspaceId);
    if (projectId === null) return NOT_LINKED;
    if (!ports.signedIn()) return SIGNED_OUT;
    if (typeof cursor !== 'string' || cursor === '') return { ok: false, state: 'error', reason: 'No cursor to catch up from.' };
    const at = scopeOf(scope);
    const asked = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id !== '').slice(0, 200) : [];
    let res;
    try { res = await ports.request(boardChangesPath(projectId, at, cursor, asked), { method: 'GET' }); }
    catch (error) { return { ok: false, state: 'error', reason: error instanceof Error ? error.message : String(error) }; }
    if (!res.ok) return refusal(res);
    const changes = parseBoardChanges(await bodyOf(res));
    if (!changes) return { ok: false, state: 'error', reason: 'Tynn answered with something that is not a list of changes.' };

    const focusId = at.focus?.split(':')[1];
    if (focusId === undefined || !changes.cards.some((c) => c.id === focusId)) return { ok: true, changes };
    const detailCall = boardDetailRequest(projectId, at.focus);
    if (detailCall === null) return { ok: true, changes };
    try {
        const dres = await ports.request(detailCall.path, { method: 'GET' });
        const detail = dres.ok ? parseDetail(await bodyOf(dres)) : null;
        return detail ? { ok: true, changes, detail } : { ok: true, changes };
    } catch {
        return { ok: true, changes };
    }
}
