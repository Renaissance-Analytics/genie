import { featuresActionRequest, featuresBody } from '../core/tynn-features.js';
import { detailsBody, homeActionRequest, parseTynnPage, tynnPagePath, TYNN_PAGES, type TynnPage, type TynnPageActionAnswer, type TynnPageActionInput, type TynnPageView } from '../core/tynn-pages.js';
import { bodyOf, NOT_LINKED, refusal, SIGNED_OUT, type TynnBoardPorts, type TynnBoardRefusal } from './tynn-board-client.js';
import { readTynnIssues } from './tynn-issues-client.js';

/**
 * THE TYNN TAB'S OTHER PAGES TALK TO TYNN AS AN APP, the same way the board does (genie#1295; tynn-board-client.ts):
 * through the person's pairing, on the WORKSPACE's project (looked up here: the renderer names a workspace, never a
 * project), and Tynn's 404 for every refusal reads as "sign in to Tynn again". A page is read whole, as tynn.ai renders
 * it; its buttons that are board verbs go through the board's own action path.
 */
export async function readTynnPage(
    ports: TynnBoardPorts,
    workspaceId: string,
    rawPage: unknown,
    query: unknown,
): Promise<({ ok: true } & TynnPageView) | TynnBoardRefusal> {
    if (typeof rawPage !== 'string' || !TYNN_PAGES.includes(rawPage as TynnPage)) return { ok: false, state: 'error', reason: 'The Tynn tab does not have that page.' };
    const page = rawPage as TynnPage;
    if (page === 'issues') {
        const answer = await readTynnIssues(ports, workspaceId, query);
        return answer.ok ? { ok: true, page, view: answer.view } : answer;
    }
    const projectId = ports.projectFor(workspaceId);
    if (projectId === null) return NOT_LINKED;
    if (!ports.signedIn()) return SIGNED_OUT;
    const asked: Record<string, string> = {};
    if (typeof query === 'object' && query !== null && !Array.isArray(query)) {
        for (const [k, v] of Object.entries(query)) if (typeof v === 'string') asked[k] = v;
    }
    let res;
    try { res = await ports.request(tynnPagePath(projectId, page, asked), { method: 'GET' }); }
    catch (error) { return { ok: false, state: 'error', reason: error instanceof Error ? error.message : String(error) }; }
    if (!res.ok) return refusal(res);
    const parsed = parseTynnPage(page, await bodyOf(res));
    return parsed ? { ok: true, ...parsed } : { ok: false, state: 'error', reason: `Tynn answered with something that is not its ${page} page.` };
}

/** Each page write's body, as its contract declares it; null = not sent (the tab says why). */
const PAGE_BODY: Readonly<Record<string, { build: (raw: unknown) => Record<string, unknown> | null; why: string }>> = {
    'details.update': { build: detailsBody, why: 'Nothing to save.' },
};

/**
 * One write on a page of the tab (the Home's Details save, row H1), on the WORKSPACE's own project through the person's
 * pairing — the same way the board's and the Issues' writes go. Only the contract's action, only the web form's fields;
 * Tynn's 422 in Tynn's words. Tynn answers the page as it now stands, and that answer is what the tab draws.
 */
export async function runTynnPageAction(ports: TynnBoardPorts, workspaceId: string, input: TynnPageActionInput): Promise<TynnPageActionAnswer> {
    const projectId = ports.projectFor(workspaceId);
    if (projectId === null) return NOT_LINKED;
    // Features, Domains and Repositories (row F1): the row's own door; Tynn answers the row, and the tab reads the page again.
    const featureRequest = typeof input.action === 'string' ? featuresActionRequest(projectId, input.action, input.id) : null;
    if (featureRequest !== null) {
        const built = featuresBody(input.action, input.body);
        if (!built.ok) return { ok: false, state: 'error', reason: built.reason };
        if (!ports.signedIn()) return SIGNED_OUT;
        let answer;
        try { answer = await ports.request(featureRequest.path, { method: featureRequest.method, ...(built.body !== undefined ? { body: built.body } : {}) }); }
        catch (error) { return { ok: false, state: 'error', reason: error instanceof Error ? error.message : String(error) }; }
        return answer.ok ? { ok: true, page: null } : refusal(answer);
    }
    const request = typeof input.action === 'string' ? homeActionRequest(projectId, input.action) : null;
    const shape = request ? PAGE_BODY[input.action] : undefined;
    if (request === null || shape === undefined) return { ok: false, state: 'error', reason: `The Tynn tab does not offer ${String(input.action)} here.` };
    const body = shape.build(input.body);
    if (body === null) return { ok: false, state: 'error', reason: shape.why };
    if (!ports.signedIn()) return SIGNED_OUT;
    let res;
    try { res = await ports.request(request.path, { method: request.method, body }); }
    catch (error) { return { ok: false, state: 'error', reason: error instanceof Error ? error.message : String(error) }; }
    if (!res.ok) return refusal(res);
    const parsed = parseTynnPage('home', await bodyOf(res));
    return parsed ? { ok: true, ...parsed } : { ok: false, state: 'error', reason: 'Tynn answered with something that is not the project\'s Details.' };
}
