import { parseTynnPage, tynnPagePath, TYNN_PAGES, type TynnPage, type TynnPageView } from '../core/tynn-pages.js';
import { bodyOf, NOT_LINKED, refusal, SIGNED_OUT, type TynnBoardPorts, type TynnBoardRefusal } from './tynn-board-client.js';

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
