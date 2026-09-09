import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type http from 'node:http';
import { Readable } from 'node:stream';

/**
 * genie#586 — the host's `/api/desktop/lists/*` surface, for a remote DESKTOP
 * driving this host.
 *
 * AgentList + UserList live in the db of the machine that OWNS the workspace. A
 * host-bound window reads its own db and finds nothing, which renders exactly
 * like "you have nothing to do" — so the lists have to be host-sourced, the way
 * AgentInbox, terminals and workspaces already are.
 *
 * Four properties are pinned here, and the third is the one this feature exists
 * for:
 *
 *  1. A valid Bearer is required (401 without) — the read is auth-only, like the
 *     other `/api/desktop/*` GETs.
 *  2. Both routes are ALLOW-LISTED to the workspaces this host serves a remote,
 *     so a paired client can never read or resolve in a workspace it was not
 *     given — and the refusal happens BEFORE the db is touched.
 *  3. Resolving runs on the HOST (that is where the authoring agent's terminal
 *     and the broker live) and reports the SAME delivery outcome the local IPC
 *     does — including an UNDELIVERED nudge. A remote tick that silently loses
 *     its nudge is the same defect wearing a network.
 *  4. The resolve is a "drive the host" mutation, so it takes the kill-switch
 *     (423) like every other POST here.
 *
 * The lists wiring itself is mocked — this is purely about the route (auth,
 * allow-list, gate, dispatch). `resolveUserListItemOnHost` and
 * `readWorkspaceLists` have their own suites.
 */

const lists = vi.hoisted(() => ({
    readWorkspaceLists: vi.fn(),
    resolveUserListItemOnHost: vi.fn(),
    workspaceOfListItem: vi.fn(),
}));
vi.mock('../../lists/wiring', () => lists);

import { handleApi, type MobileDataDeps } from '../api';
import { initAuth, attemptPair, _setPinForTest, _resetAuthForTest } from '../auth';
import { _resetAuditForTest } from '../audit';
import { setLocked, _resetBatonForTest } from '../baton';

function fakeRes() {
    let status = 0;
    let body = '';
    const res = {
        writeHead(s: number) {
            status = s;
            return res;
        },
        end(d?: string) {
            if (typeof d === 'string') body = d;
        },
    } as unknown as http.ServerResponse;
    return {
        res,
        get status() {
            return status;
        },
        get json() {
            return body ? (JSON.parse(body) as Record<string, unknown>) : null;
        },
    };
}

function getReq(url: string, headers: http.IncomingHttpHeaders = {}): http.IncomingMessage {
    return { method: 'GET', headers, url } as unknown as http.IncomingMessage;
}
function postReq(
    url: string,
    body: unknown,
    headers: http.IncomingHttpHeaders = {},
): http.IncomingMessage {
    const r = Readable.from([JSON.stringify(body)]) as unknown as http.IncomingMessage;
    (r as unknown as { method: string }).method = 'POST';
    (r as unknown as { headers: http.IncomingHttpHeaders }).headers = headers;
    (r as unknown as { url: string }).url = url;
    return r;
}

async function mintToken(): Promise<string> {
    initAuth({ userDataDir: null, confirmPair: async () => true });
    _setPinForTest('123456');
    const r = await attemptPair('123456', { ip: '100.0.0.1', ua: 'test' });
    if (!r.ok) throw new Error('failed to mint test token');
    return r.token;
}

const bearer = (t: string): http.IncomingHttpHeaders => ({ authorization: `Bearer ${t}` });

const deps = (...ids: string[]): MobileDataDeps =>
    ({
        listWorkspaces: () => ids.map((id) => ({ id, project_name: id, path: `/ws/${id}` })),
    }) as unknown as MobileDataDeps;

const DEPS = deps('w1');

async function call(
    req: http.IncomingMessage,
    pathname: string,
    d: MobileDataDeps = DEPS,
) {
    const r = fakeRes();
    const handled = await handleApi(req, r.res, pathname, d, { ip: '100.0.0.1', ua: 'test' });
    return { handled, status: r.status, json: r.json };
}

const READ = '/api/desktop/lists/read';
const RESOLVE = '/api/desktop/lists/resolve';

const VIEW = {
    agents: [{ agentName: 'alpha', items: [{ id: 'a1', text: 'Read the RFC' }] }],
    user: [{ id: 'u1', text: 'Approve the staging login', agentName: 'alpha' }],
    userCount: 1,
};

beforeEach(() => {
    _resetAuthForTest();
    _resetAuditForTest();
    _resetBatonForTest();
    lists.readWorkspaceLists.mockReset();
    lists.resolveUserListItemOnHost.mockReset();
    lists.workspaceOfListItem.mockReset();
    lists.readWorkspaceLists.mockReturnValue(VIEW);
    lists.workspaceOfListItem.mockReturnValue('w1');
    lists.resolveUserListItemOnHost.mockReturnValue({
        ok: true,
        todo: { id: 'u1', text: 'Approve the staging login', agent_name: 'alpha' },
        nudge: { delivered: true, terminalId: 't1' },
    });
});
afterEach(() => {
    _resetAuthForTest();
    _resetAuditForTest();
    _resetBatonForTest();
    setLocked(false);
});

describe('GET /api/desktop/lists/read', () => {
    it('rejects an unauthenticated request with 401 and never reads the db', async () => {
        const r = await call(getReq(`${READ}?workspaceId=w1`), READ);
        expect(r.status).toBe(401);
        expect(lists.readWorkspaceLists).not.toHaveBeenCalled();
    });

    it('serves the HOST workspace view a remote window cannot read locally', async () => {
        const t = await mintToken();
        const r = await call(getReq(`${READ}?workspaceId=w1`, bearer(t)), READ);

        expect(r.status).toBe(200);
        expect(r.json).toEqual({ view: VIEW });
        expect(lists.readWorkspaceLists).toHaveBeenCalledWith('w1');
    });

    it('refuses a workspace this host does not serve, without touching the db', async () => {
        const t = await mintToken();
        const r = await call(getReq(`${READ}?workspaceId=someone-elses`, bearer(t)), READ);

        expect(r.status).toBe(404);
        expect(lists.readWorkspaceLists).not.toHaveBeenCalled();
    });

    /**
     * POSITIVE CONTROL for the refusal above. A 404 is also what an absent route
     * answers, so "it 404s" on its own would pass against a feature that does not
     * exist. The SAME id, the same request, the same token — only the host's
     * served set differs — and it goes through. That pins the refusal to the
     * ALLOW-LIST rather than to the route being missing or the id being odd.
     */
    it('serves that very id once the host actually owns that workspace', async () => {
        const t = await mintToken();
        const r = await call(
            getReq(`${READ}?workspaceId=someone-elses`, bearer(t)),
            READ,
            deps('w1', 'someone-elses'),
        );

        expect(r.status).toBe(200);
        expect(lists.readWorkspaceLists).toHaveBeenCalledWith('someone-elses');
    });

    it('refuses a request with no workspaceId at all, rather than reading a blank one', async () => {
        const t = await mintToken();
        const r = await call(getReq(READ, bearer(t)), READ);

        expect(r.status).toBe(404);
        expect(lists.readWorkspaceLists).not.toHaveBeenCalled();
    });
});

describe('POST /api/desktop/lists/resolve', () => {
    it('rejects an unauthenticated request with 401 and never resolves', async () => {
        const r = await call(
            postReq(RESOLVE, { todoId: 'u1', action: 'done', comment: 'did it' }),
            RESOLVE,
        );
        expect(r.status).toBe(401);
        expect(lists.resolveUserListItemOnHost).not.toHaveBeenCalled();
    });

    it('resolves ON THE HOST — the broker that nudges the agent lives there', async () => {
        const t = await mintToken();
        const r = await call(
            postReq(RESOLVE, { todoId: 'u1', action: 'done', comment: 'did it' }, bearer(t)),
            RESOLVE,
        );

        expect(r.status).toBe(200);
        expect(lists.resolveUserListItemOnHost).toHaveBeenCalledWith({
            todoId: 'u1',
            action: 'done',
            comment: 'did it',
        });
        expect(r.json).toMatchObject({ ok: true, nudge: { delivered: true, terminalId: 't1' } });
    });

    /**
     * The whole point of the feature, over the wire. The record stands whatever
     * happens to the nudge, and the OUTCOME is reported rather than allowed to
     * roll the resolution back — "a tick in the UI over a nudge that went
     * nowhere is the failure this feature exists to prevent". A route that
     * flattened this to `{ok:true}` would put that failure back, remotely.
     */
    it('carries an UNDELIVERED nudge through verbatim, reason and all', async () => {
        const t = await mintToken();
        lists.resolveUserListItemOnHost.mockReturnValue({
            ok: true,
            todo: { id: 'u1', text: 'Approve it', agent_name: 'alpha' },
            nudge: {
                delivered: false,
                reason: 'alpha is no longer running in this workspace, so it was not told.',
            },
        });

        const r = await call(
            postReq(RESOLVE, { todoId: 'u1', action: 'done', comment: 'did it' }, bearer(t)),
            RESOLVE,
        );

        expect(r.status).toBe(200);
        expect(r.json).toEqual({
            ok: true,
            todo: { id: 'u1', text: 'Approve it', agent_name: 'alpha' },
            nudge: {
                delivered: false,
                reason: 'alpha is no longer running in this workspace, so it was not told.',
            },
        });
    });

    /**
     * `action` lands in a column with a CHECK constraint, so a value outside the
     * three would throw SQLITE_CONSTRAINT out of the transaction and up through
     * the route. The local IPC never sees one — the panel only ever sends the
     * three buttons — but a wire client is not the panel, and "the renderer
     * wouldn't do that" is not a validation.
     */
    it.each(['nonsense', 'open', ''])('refuses the unusable action %o', async (action) => {
        const t = await mintToken();
        const r = await call(
            postReq(RESOLVE, { todoId: 'u1', action, comment: 'did it' }, bearer(t)),
            RESOLVE,
        );

        expect(r.status).toBe(400);
        expect(lists.resolveUserListItemOnHost).not.toHaveBeenCalled();
    });

    it('POSITIVE CONTROL: each of the three real outcomes goes through', async () => {
        const t = await mintToken();
        for (const action of ['done', 'thrown_back', 'refused'] as const) {
            lists.resolveUserListItemOnHost.mockClear();
            const r = await call(
                postReq(RESOLVE, { todoId: 'u1', action, comment: 'did it' }, bearer(t)),
                RESOLVE,
            );
            expect(r.status).toBe(200);
            expect(lists.resolveUserListItemOnHost).toHaveBeenCalledWith({
                todoId: 'u1',
                action,
                comment: 'did it',
            });
        }
    });

    it('refuses with 423 while another user drives, and never resolves', async () => {
        const t = await mintToken();
        setLocked(true);
        const r = await call(
            postReq(RESOLVE, { todoId: 'u1', action: 'done', comment: 'did it' }, bearer(t)),
            RESOLVE,
        );

        expect(r.status).toBe(423);
        expect(lists.resolveUserListItemOnHost).not.toHaveBeenCalled();
    });

    it('refuses an item in a workspace this host does not serve, without resolving', async () => {
        const t = await mintToken();
        lists.workspaceOfListItem.mockReturnValue('someone-elses');

        const r = await call(
            postReq(RESOLVE, { todoId: 'u1', action: 'done', comment: 'did it' }, bearer(t)),
            RESOLVE,
        );

        expect(r.status).toBe(404);
        expect(lists.resolveUserListItemOnHost).not.toHaveBeenCalled();
    });

    /**
     * POSITIVE CONTROL, as on the read: the SAME item in the SAME workspace goes
     * through the moment the host actually owns that workspace. Without it, the
     * refusal above would pass against a route that refuses everything — and the
     * workspace is read off the ROW, so this also pins that the check consults
     * the item's real owner rather than anything the client sent.
     */
    it('resolves that very item once the host actually owns its workspace', async () => {
        const t = await mintToken();
        lists.workspaceOfListItem.mockReturnValue('someone-elses');

        const r = await call(
            postReq(RESOLVE, { todoId: 'u1', action: 'done', comment: 'did it' }, bearer(t)),
            RESOLVE,
            deps('w1', 'someone-elses'),
        );

        expect(r.status).toBe(200);
        expect(lists.resolveUserListItemOnHost).toHaveBeenCalledWith({
            todoId: 'u1',
            action: 'done',
            comment: 'did it',
        });
    });

    /**
     * An id that names NO row is not an allow-list breach — it is a stale item
     * the person is trying to tick off twice. Denying it as "unknown workspace"
     * would answer a different question than the one they asked; the resolve's
     * own sentence ("No open UserToDo with that id.") is the honest one.
     */
    it('lets an unknown id through to the resolve, which says so honestly', async () => {
        const t = await mintToken();
        lists.workspaceOfListItem.mockReturnValue(null);
        lists.resolveUserListItemOnHost.mockReturnValue({
            ok: false,
            error: 'No open UserToDo with that id.',
        });

        const r = await call(
            postReq(RESOLVE, { todoId: 'gone', action: 'done', comment: 'did it' }, bearer(t)),
            RESOLVE,
        );

        expect(r.status).toBe(200);
        expect(r.json).toEqual({ ok: false, error: 'No open UserToDo with that id.' });
    });
});
