import {
    closeBody,
    convertBody,
    issueActionRequest,
    issueChangesPath,
    issueCreateBody,
    issuesQueryPath,
    normalizeIssueFilters,
    parseIssueChanges,
    parseIssueQueue,
    parseIssueRow,
    type IssueChanges,
    type IssueQueueView,
    type IssueRefusal,
    type IssueRow,
} from '../core/tynn-issues.js';
import type { TynnBoardPorts } from './tynn-board-client.js';

/**
 * THE TYNN TAB'S ISSUES TALK TO TYNN AS AN APP (genie#1295 row I1; the owner: "the mcp is for agents, the api is for apps").
 *
 * The same ports as the board: the person's pairing (Bearer `gpk_`, `/api/v1/*` only), the WORKSPACE's own project read on
 * this side — the tab has no picker, and a window cannot name another project. Tynn's issue-queue door answers every
 * refusal with a 404 (a pairing made before `genie:issue-queue` existed, no access, a role that may not triage): the tab
 * says "sign in to Tynn again". An illegal step (converting twice, closing a closed issue, a field the form refuses) is a
 * 422 in Tynn's own words.
 */
const NOT_LINKED: IssueRefusal = { ok: false, state: 'not-linked', reason: 'This workspace has no Tynn project.' };
const SIGNED_OUT: IssueRefusal = { ok: false, state: 'signed-out', reason: 'Genie is not signed in to Tynn. Settings → Accounts → Tynn.' };
const REFUSED: IssueRefusal = {
    ok: false,
    state: 'signed-out',
    reason: 'Tynn did not show this issue queue to this Genie. Sign in to Tynn again (Settings → Accounts → Tynn) so the pairing includes the issue queue.',
};

async function bodyOf(res: { json(): Promise<unknown> }): Promise<unknown> {
    try { return await res.json(); } catch { return null; }
}

/** Tynn's own words: the first message under `errors`, else `message`, else the status. Every 404/401/403 is "sign in again". */
async function refusal(res: { status: number; json(): Promise<unknown> }): Promise<IssueRefusal> {
    if (res.status === 404 || res.status === 401 || res.status === 403) return REFUSED;
    const body = (await bodyOf(res)) as { message?: unknown; errors?: Record<string, unknown> } | null;
    const firstError = body?.errors ? Object.values(body.errors).flat().find((m): m is string => typeof m === 'string') : undefined;
    const reason = firstError ?? (typeof body?.message === 'string' && body.message !== '' ? body.message : `Tynn answered ${res.status}`);
    return { ok: false, state: res.status === 422 ? 'transition-refused' : 'error', reason };
}

const failure = (error: unknown): IssueRefusal => ({ ok: false, state: 'error', reason: error instanceof Error ? error.message : String(error) });

/** The workspace's queue under the page's filters. */
export async function readTynnIssues(ports: TynnBoardPorts, workspaceId: string, filters: unknown): Promise<{ ok: true; view: IssueQueueView } | IssueRefusal> {
    const projectId = ports.projectFor(workspaceId);
    if (projectId === null) return NOT_LINKED;
    if (!ports.signedIn()) return SIGNED_OUT;
    let res;
    try { res = await ports.request(issuesQueryPath(projectId, normalizeIssueFilters(filters)), { method: 'GET' }); }
    catch (error) { return failure(error); }
    if (!res.ok) return refusal(res);
    const view = parseIssueQueue(await bodyOf(res));
    return view ? { ok: true, view } : { ok: false, state: 'error', reason: 'Tynn answered with something that is not an issue queue.' };
}

/** The body an action sends, checked here so Tynn is not asked what the web form would not send. */
function bodyFor(action: string, raw: unknown): { ok: true; body: unknown } | { ok: false; reason: string } {
    switch (action) {
        case 'issue.create': {
            const body = issueCreateBody(raw);
            return body ? { ok: true, body } : { ok: false, reason: 'A new issue needs a title.' };
        }
        case 'issue.update': {
            // The panel sends only what changed (issueEditBody); an empty title is never sent.
            const b = (raw ?? {}) as Record<string, unknown>;
            if (typeof b !== 'object' || Object.keys(b).length === 0) return { ok: false, reason: 'Nothing to save.' };
            if ('title' in b && (typeof b.title !== 'string' || b.title.trim() === '')) return { ok: false, reason: 'An issue needs a title.' };
            return { ok: true, body: b };
        }
        case 'issue.convert': {
            const body = convertBody(raw);
            return body ? { ok: true, body } : { ok: false, reason: 'Pick the version to convert it onto.' };
        }
        case 'issue.resolve':
        case 'issue.discard': {
            const body = closeBody(action, raw);
            return body ? { ok: true, body } : { ok: false, reason: 'Say why: the reason is recorded on the issue.' };
        }
        default:
            return { ok: true, body: undefined };
    }
}

/** One action on the queue, by the contract's id; answers the issue as Tynn now has it (null after a delete). */
export async function runTynnIssueAction(ports: TynnBoardPorts, workspaceId: string, input: { action: string; issueId: string | null; body?: unknown }): Promise<{ ok: true; issue: IssueRow | null } | IssueRefusal> {
    const projectId = ports.projectFor(workspaceId);
    if (projectId === null) return NOT_LINKED;
    const request = issueActionRequest(projectId, input.action, input.issueId ?? null);
    if (request === null) return { ok: false, state: 'error', reason: `The Tynn tab does not offer ${input.action} here.` };
    const body = bodyFor(input.action, input.body);
    if (!body.ok) return { ok: false, state: 'error', reason: body.reason };
    if (!ports.signedIn()) return SIGNED_OUT;
    let res;
    try { res = await ports.request(request.path, { method: request.method, ...(body.body !== undefined ? { body: body.body } : {}) }); }
    catch (error) { return failure(error); }
    if (!res.ok) return refusal(res);
    return { ok: true, issue: request.method === 'DELETE' ? null : parseIssueRow(await bodyOf(res)) };
}

/** What changed under the filters since a cursor (GET /issues/changes) — never the whole queue. */
export async function readTynnIssueChanges(ports: TynnBoardPorts, workspaceId: string, filters: unknown, cursor: string, ids: readonly string[]): Promise<{ ok: true; changes: IssueChanges } | IssueRefusal> {
    const projectId = ports.projectFor(workspaceId);
    if (projectId === null) return NOT_LINKED;
    if (!ports.signedIn()) return SIGNED_OUT;
    if (typeof cursor !== 'string' || cursor === '') return { ok: false, state: 'error', reason: 'No cursor to catch up from.' };
    const asked = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id !== '').slice(0, 200) : [];
    let res;
    try { res = await ports.request(issueChangesPath(projectId, normalizeIssueFilters(filters), cursor, asked), { method: 'GET' }); }
    catch (error) { return failure(error); }
    if (!res.ok) return refusal(res);
    const changes = parseIssueChanges(await bodyOf(res));
    return changes ? { ok: true, changes } : { ok: false, state: 'error', reason: 'Tynn answered with something that is not a list of changes.' };
}
