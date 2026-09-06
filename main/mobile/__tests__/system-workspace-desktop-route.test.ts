import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type http from 'node:http';

/**
 * POSITIVE CONTROL for genie#455: `/api/desktop/workspaces` still excludes the
 * protected System Workspace, and that is deliberate rather than an oversight.
 *
 * The two remote surfaces are asymmetric on purpose. A PHONE reads
 * `/api/workspaces`, whose list IS its workspace surface, so the System Workspace
 * is sent there — that is the fix. A remote DESKTOP window reads this route and
 * feeds the result to every picker, scope multiselect and launch target it has,
 * all of which rely on the row being absent exactly as they do on the local
 * desktop; its sidebar composes the row itself, from the host's own OSA terminal
 * cwd (`systemWorkspaceRow` in renderer/lib/genie.ts).
 *
 * So a fix that "made the System Workspace visible remotely" by widening this
 * route too would go green on the phone's tests and quietly offer the workstation
 * operator's workspace in seven pickers. This is the test that says no.
 *
 * The route reads `main/db` directly, as every `/api/desktop/*` route does, so
 * the DB is mocked here rather than injected. The auth gate and the routing are
 * the production path.
 */

// Hoisted with the `vi.mock` factory below, which runs before this module's own
// bindings are initialised.
const { SYSTEM_ROW, ORDINARY_ROW } = vi.hoisted(() => ({
    SYSTEM_ROW: {
        id: '__system__',
        project_name: 'System',
        path: '/home/w/.gosa',
        workstation_operator: 1,
    },
    ORDINARY_ROW: { id: 'w1', project_name: 'Proj', path: '/work/proj' },
}));

vi.mock('../../db', async (importActual) => {
    const actual = await importActual<typeof import('../../db')>();
    return {
        ...actual,
        // The SERVED list, System-excluded exactly as `listWorkspacesIn` returns it.
        listWorkspaces: () => [ORDINARY_ROW],
        getWorkspace: (id: string) => (id === '__system__' ? SYSTEM_ROW : undefined),
    };
});

import { handleApi } from '../api';
import { initAuth, attemptPair, _setPinForTest, _resetAuthForTest } from '../auth';
import { _resetAuditForTest } from '../audit';
import { _resetBatonForTest } from '../baton';
import { markDesktopRuntime, _resetRuntimeModeForTest } from '../../runtime-mode';

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

async function mintToken(): Promise<string> {
    initAuth({ userDataDir: null, confirmPair: async () => true });
    _setPinForTest('123456');
    const r = await attemptPair('123456', { ip: '100.0.0.1', ua: 'test' });
    if (!r.ok) throw new Error('failed to mint test token');
    return r.token;
}

async function getWorkspaces(headers: http.IncomingHttpHeaders) {
    const url = '/api/desktop/workspaces';
    const cap = fakeRes();
    await handleApi(
        { method: 'GET', headers, url } as unknown as http.IncomingMessage,
        cap.res,
        url,
        { listWorkspaces: () => [ORDINARY_ROW] } as never,
        { ip: '100.0.0.1', ua: 'test' },
    );
    return cap;
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

describe('GET /api/desktop/workspaces', () => {
    it('sends a paired remote desktop its ordinary workspaces, and NOT the protected row', async () => {
        const token = await mintToken();

        const cap = await getWorkspaces({ authorization: `Bearer ${token}` });

        expect(cap.status).toBe(200);
        // Both halves matter: `w1` present proves the route answered at all, so
        // "no System Workspace" is not passing on an empty or errored response.
        expect((cap.json?.workspaces as Array<{ id: string }>).map((w) => w.id)).toEqual(['w1']);
    });

    it('still refuses an unauthenticated caller outright', async () => {
        await mintToken();

        const cap = await getWorkspaces({});

        expect(cap.status).toBe(401);
    });
});
