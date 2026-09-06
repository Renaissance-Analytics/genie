import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type http from 'node:http';
import Database from 'better-sqlite3';
import {
    handleApi,
    terminalServable,
    workspacesForRemote,
    type MobileDataDeps,
} from '../api';
import { initAuth, attemptPair, _setPinForTest, _resetAuthForTest } from '../auth';
import { _resetAuditForTest } from '../audit';
import { _resetBatonForTest } from '../baton';
import {
    markDesktopRuntime,
    markHeadlessRuntime,
    _resetRuntimeModeForTest,
} from '../../runtime-mode';
import {
    ensureSystemWorkspaceRow,
    listWorkspacesIn,
    runMigrations,
    SYSTEM_WORKSPACE_ROW_ID,
} from '../../db';

/**
 * genie#455 — the System Workspace is visible to a PAIRED remote, so the Host
 * Genie OSA can be driven from a phone or a remote desktop over the tailnet.
 *
 * The tempting fix is to drop the `WHERE id != ?` from `listWorkspacesIn`
 * (main/db.ts). It is the wrong one: that exclusion is what "protected" means
 * structurally — the pickers, the sidebar, the workstation inventory, the
 * IssueWatch counts, the Dev Server reconcile and the mobile SERVED set all read
 * the same default, and removing it changes six surfaces to fix one. The remote
 * path asks for the row BY ID instead, which is the affordance that exclusion
 * deliberately leaves open and which nothing had used yet.
 *
 * So the POSITIVE CONTROLS below matter more than the headline test: they are
 * what fails if the row is un-protected at the source rather than requested at
 * the seam.
 */

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

function req(url: string, headers: http.IncomingHttpHeaders = {}): http.IncomingMessage {
    return { method: 'GET', headers, url } as unknown as http.IncomingMessage;
}

/** Pair with a known PIN and return the minted bearer token. */
async function mintToken(): Promise<string> {
    initAuth({ userDataDir: null, confirmPair: async () => true });
    _setPinForTest('123456');
    const r = await attemptPair('123456', { ip: '100.0.0.1', ua: 'test' });
    if (!r.ok) throw new Error('failed to mint test token');
    return r.token;
}

const bearer = (t: string): http.IncomingHttpHeaders => ({ authorization: `Bearer ${t}` });

const WS = process.platform === 'win32' ? 'C:\\work\\proj' : '/work/proj';
const GOSA = process.platform === 'win32' ? 'C:\\Users\\w\\.gosa' : '/home/w/.gosa';

const SYSTEM_ROW = { id: SYSTEM_WORKSPACE_ROW_ID, project_name: 'System', path: GOSA };

/**
 * A host with one ordinary workspace and the protected System Workspace, whose
 * OSA terminal (`t-osa`) is bound to the System row exactly as `background.ts`
 * seeds it. `listWorkspaces` is the SERVED list and therefore excludes the
 * System row, as `main/db.ts` does; `systemWorkspace` is the by-id ask.
 */
function deps(overrides: Partial<MobileDataDeps> = {}): MobileDataDeps {
    return {
        listWorkspaces: () => [{ id: 'w1', project_name: 'Proj', path: WS }],
        systemWorkspace: () => SYSTEM_ROW,
        listTerminalSpecs: () => [
            { id: 't-real', workspace_id: 'w1', label: 't', type: 'terminal', cwd: WS, live_cwd: null },
            { id: 't-osa', workspace_id: SYSTEM_WORKSPACE_ROW_ID, label: 'Genie', type: 'terminal', cwd: GOSA, live_cwd: null },
        ],
        listAllProcesses: () => [],
        liveTerminalIds: () => ['t-real', 't-osa'],
        listPendingQuestions: () => [],
        ...overrides,
    } as unknown as MobileDataDeps;
}

beforeEach(() => {
    _resetAuthForTest();
    _resetAuditForTest();
    _resetBatonForTest();
    markDesktopRuntime();
});
afterEach(() => {
    _resetAuthForTest();
    _resetAuditForTest();
    _resetBatonForTest();
    _resetRuntimeModeForTest();
});

async function getJson(path: string, headers: http.IncomingHttpHeaders, d = deps()) {
    const cap = fakeRes();
    await handleApi(req(path, headers), cap.res, path, d, { ip: '100.0.0.1', ua: 'test' });
    return cap;
}

describe('a paired remote sees the System Workspace', () => {
    it('lists it at GET /api/workspaces', async () => {
        const token = await mintToken();

        const cap = await getJson('/api/workspaces', bearer(token));

        expect(cap.status).toBe(200);
        const ids = (cap.json?.workspaces as Array<{ id: string }>).map((w) => w.id);
        expect(ids).toContain(SYSTEM_WORKSPACE_ROW_ID);
        expect(ids).toContain('w1');
    });

    it('lists it in the /api/state bootstrap the phone paints from', async () => {
        const token = await mintToken();

        const cap = await getJson('/api/state', bearer(token));

        expect(cap.status).toBe(200);
        const ids = (cap.json?.workspaces as Array<{ id: string }>).map((w) => w.id);
        expect(ids).toContain(SYSTEM_WORKSPACE_ROW_ID);
    });

    it('makes the OSA reachable — its terminal now belongs to a workspace the remote can see', async () => {
        // The point of the change. The OSA terminal was ALWAYS in the payload on a
        // desktop host; it was orphaned, bound to a workspace id the remote was
        // never sent, so no surface could group, open or drive it.
        const token = await mintToken();

        const cap = await getJson('/api/state', bearer(token));

        const ids = new Set((cap.json?.workspaces as Array<{ id: string }>).map((w) => w.id));
        const osa = (cap.json?.terminals as Array<{ id: string; workspaceId: string }>).find(
            (t) => t.id === 't-osa',
        );
        expect(osa).toBeDefined();
        expect(ids.has(osa!.workspaceId)).toBe(true);
    });

    it('pins it first, as the sidebar does — it is fixed, not one of the user\u2019s ordered rows', async () => {
        const token = await mintToken();

        const cap = await getJson('/api/workspaces', bearer(token));

        expect((cap.json?.workspaces as Array<{ id: string }>)[0]?.id).toBe(
            SYSTEM_WORKSPACE_ROW_ID,
        );
    });
});

describe('pairing is the gate', () => {
    it('an unauthenticated caller still gets 401 and no workspace list at all', async () => {
        await mintToken(); // a pairing exists; this caller just is not it

        const cap = await getJson('/api/workspaces', {});

        expect(cap.status).toBe(401);
        expect(cap.json).toEqual({ error: 'unauthorised' });
    });

    it('a bad bearer is refused the same way', async () => {
        await mintToken();

        const cap = await getJson('/api/workspaces', bearer('not-a-real-token'));

        expect(cap.status).toBe(401);
    });
});

/**
 * POSITIVE CONTROLS — what must NOT have changed.
 *
 * Each one passes today and would keep passing against the right fix. Against
 * the wrong one — deleting the `WHERE id != ?` in `listWorkspacesIn`, or
 * widening the injected `listWorkspaces` to include the System row — at least
 * one of them goes red.
 */
describe('POSITIVE CONTROL — nothing else starts seeing the System Workspace', () => {
    function fresh(): Database.Database {
        const db = new Database(':memory:');
        runMigrations(db);
        return db;
    }

    it('the shared workspace list every other surface reads still excludes it', () => {
        // `listWorkspacesIn` is the ONE query behind the pickers, the sidebar, the
        // workstation inventory, the IssueWatch counts, the Dev Server reconcile
        // and the mobile SERVED set. If this goes green with the System row in it,
        // all six changed and only one of them was asked to.
        const db = fresh();
        ensureSystemWorkspaceRow(db, GOSA);
        db.prepare(
            `INSERT INTO workspaces
               (id, backend, project_id, project_name, tynn_project_id, tynn_project_name,
                shape, path, last_opened_at, created_by_genie)
             VALUES ('ws-1', 'tynn', 'p1', 'Ordinary', 'p1', 'Ordinary', 'agi', ?, null, 0)`,
        ).run(WS);

        expect(listWorkspacesIn(db).map((w) => w.id)).toEqual(['ws-1']);
    });

    it('the headless (genie-cloud) member surface still never lists it', () => {
        // A member of a shared workstation is not the owner of it. The remote
        // listing widens on the DESKTOP host only; the multi-tenant host is
        // unchanged, and stays so even though the dep is wired.
        markHeadlessRuntime();

        expect(workspacesForRemote([{ id: 'w1' }], { id: SYSTEM_WORKSPACE_ROW_ID })).toEqual([
            { id: 'w1' },
        ]);
    });

    it('the headless SERVED set still refuses System-bound terminals', async () => {
        // The listing and the served set are different questions. Widening the
        // first must not widen the second, or genie-cloud starts streaming the
        // workstation operator's own terminal to a member.
        markHeadlessRuntime();

        expect(terminalServable(deps(), 't-real')).toBe(true);
        expect(terminalServable(deps(), 't-osa')).toBe(false);
    });

    it('a host with no System Workspace row lists exactly what it did before', () => {
        // Every headless host, and a desktop before its first boot seeds the row.
        expect(workspacesForRemote([{ id: 'w1' }], null)).toEqual([{ id: 'w1' }]);
    });
});
