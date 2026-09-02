import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type http from 'node:http';
import { Readable } from 'node:stream';

/**
 * The host's Hosting-Manager REST surface for a remote DESKTOP driving this host:
 * `POST /api/desktop/dev-server/site` + `/service`, `GET .../runtime`, and
 * `POST .../repos`. Each routes into the SAME `runManageSite` / `runManageService`
 * the local IPC (`dev:site` / `dev:service`) and the MCP tools call — so the human
 * surface can never drift from the agent one, on a host or locally.
 *
 * The three properties asserted here: a valid Bearer is required (401 without);
 * WRITE actions (create/update/start/stop/remove/add/dedicated) take the BATON
 * exactly like process-control (423 when someone else drives, and never run the
 * manager); READS (list/detect/status/logs/catalog/inventory/runtime/repos) are
 * ungated so a view-only member still sees the host's sites. The manager itself is
 * mocked — these are purely about the route (auth, gate, dispatch, audit).
 */

const siteTools = vi.hoisted(() => ({ runManageSite: vi.fn(), runtimeInfo: vi.fn() }));
const serviceTools = vi.hoisted(() => ({ runManageService: vi.fn() }));
const detect = vi.hoisted(() => ({ detectFolder: vi.fn() }));
vi.mock('../../mcp/dev-site-tools', () => siteTools);
vi.mock('../../mcp/dev-service-tools', () => serviceTools);
vi.mock('../../workspace/detect', () => detect);

import { handleApi, type MobileDataDeps } from '../api';
import { initAuth, attemptPair, _setPinForTest, _resetAuthForTest } from '../auth';
import { _resetAuditForTest, recentAudit } from '../audit';
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

/** A GET with no body (the runtime read). */
function getReq(url: string, headers: http.IncomingHttpHeaders = {}): http.IncomingMessage {
    return { method: 'GET', headers, url } as unknown as http.IncomingMessage;
}
/** A POST carrying a JSON body — a real Readable so `readJsonBody` can drain it. */
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

const DEPS = {
    listWorkspaces: () => [{ id: 'w1', project_name: 'Proj', path: '/ws/w1' }],
} as unknown as MobileDataDeps;

async function call(req: http.IncomingMessage, pathname: string) {
    const r = fakeRes();
    const handled = await handleApi(req, r.res, pathname, DEPS, { ip: '100.0.0.1', ua: 'test' });
    return { handled, status: r.status, json: r.json };
}

beforeEach(() => {
    _resetAuthForTest();
    _resetAuditForTest();
    _resetBatonForTest();
    siteTools.runManageSite.mockReset();
    siteTools.runtimeInfo.mockReset();
    serviceTools.runManageService.mockReset();
    detect.detectFolder.mockReset();
    siteTools.runManageSite.mockResolvedValue({ ok: true, sites: [], runtime: { kind: 'docker' } });
    siteTools.runtimeInfo.mockResolvedValue({ kind: 'docker' });
    serviceTools.runManageService.mockResolvedValue({
        ok: true,
        services: [],
        runtime: { kind: 'docker' },
    });
    detect.detectFolder.mockReturnValue({ repos: ['api', 'web'] });
});
afterEach(() => {
    _resetAuthForTest();
    _resetAuditForTest();
    _resetBatonForTest();
    setLocked(false);
});

const SITE = '/api/desktop/dev-server/site';
const SERVICE = '/api/desktop/dev-server/service';

describe('POST /api/desktop/dev-server/site', () => {
    it('rejects an unauthenticated request with 401 and never touches the manager', async () => {
        const r = await call(postReq(SITE, { workspaceId: 'w1', req: { action: 'list' } }), SITE);
        expect(r.handled).toBe(true);
        expect(r.status).toBe(401);
        expect(siteTools.runManageSite).not.toHaveBeenCalled();
    });

    it('serves a READ (list) even when another driver holds the baton — ungated', async () => {
        const token = await mintToken();
        setLocked(true); // someone else is driving
        const r = await call(
            postReq(SITE, { workspaceId: 'w1', req: { action: 'list' } }, bearer(token)),
            SITE,
        );
        expect(r.status).toBe(200);
        // The read reached the manager against the resolved host workspace.
        expect(siteTools.runManageSite).toHaveBeenCalledWith(
            { id: 'w1', project_name: 'Proj', path: '/ws/w1' },
            { action: 'list' },
        );
    });

    it('refuses a WRITE (start) with 423 when another driver holds the baton, and never runs it', async () => {
        const token = await mintToken();
        setLocked(true);
        const r = await call(
            postReq(SITE, { workspaceId: 'w1', req: { action: 'start', id: 's1' } }, bearer(token)),
            SITE,
        );
        expect(r.status).toBe(423);
        expect(siteTools.runManageSite).not.toHaveBeenCalled();
    });

    it('runs a WRITE (create) through the manager when unlocked, and audits it', async () => {
        const token = await mintToken();
        const r = await call(
            postReq(
                SITE,
                { workspaceId: 'w1', req: { action: 'create', name: 'web', port: 8000 } },
                bearer(token),
            ),
            SITE,
        );
        expect(r.status).toBe(200);
        expect(siteTools.runManageSite).toHaveBeenCalledWith(
            { id: 'w1', project_name: 'Proj', path: '/ws/w1' },
            { action: 'create', name: 'web', port: 8000 },
        );
        const entry = recentAudit().find((e) => e.action === 'dev-site.create');
        expect(entry).toBeDefined();
    });

    it('404s an unknown workspace without running the manager', async () => {
        const token = await mintToken();
        const r = await call(
            postReq(SITE, { workspaceId: 'nope', req: { action: 'start', id: 's1' } }, bearer(token)),
            SITE,
        );
        expect(r.status).toBe(404);
        expect(siteTools.runManageSite).not.toHaveBeenCalled();
    });
});

describe('POST /api/desktop/dev-server/service', () => {
    it('answers `catalog` with no workspace (null target) — a machine-level read', async () => {
        const token = await mintToken();
        serviceTools.runManageService.mockResolvedValue({
            ok: true,
            services: [],
            catalog: [{ engine: 'postgres' }],
            runtime: { kind: 'docker' },
        });
        const r = await call(
            postReq(SERVICE, { req: { action: 'catalog' } }, bearer(token)),
            SERVICE,
        );
        expect(r.status).toBe(200);
        // The owner driving their OWN machine from another device sees what the
        // desktop Services page shows them — only an agent's view is narrowed
        // (genie#345).
        expect(serviceTools.runManageService).toHaveBeenCalledWith(
            null,
            { action: 'catalog' },
            { workspaceId: null, wholeWorkstation: true },
        );
    });

    it('gates a WRITE (add) on the baton and audits it when it runs', async () => {
        const token = await mintToken();
        setLocked(true);
        const locked = await call(
            postReq(SERVICE, { workspaceId: 'w1', req: { action: 'add', engine: 'postgres' } }, bearer(token)),
            SERVICE,
        );
        expect(locked.status).toBe(423);
        expect(serviceTools.runManageService).not.toHaveBeenCalled();

        setLocked(false);
        const ok = await call(
            postReq(SERVICE, { workspaceId: 'w1', req: { action: 'add', engine: 'postgres' } }, bearer(token)),
            SERVICE,
        );
        expect(ok.status).toBe(200);
        expect(serviceTools.runManageService).toHaveBeenCalledWith(
            { id: 'w1', project_name: 'Proj', path: '/ws/w1' },
            { action: 'add', engine: 'postgres' },
            { workspaceId: 'w1', wholeWorkstation: true },
        );
        expect(recentAudit().find((e) => e.action === 'dev-service.add')).toBeDefined();
    });
});

describe('the reads that back the panel forms', () => {
    it('GET /api/desktop/dev-server/runtime returns the host runtime (ungated read)', async () => {
        const token = await mintToken();
        setLocked(true); // still a read — must answer
        const r = await call(
            getReq('/api/desktop/dev-server/runtime', bearer(token)),
            '/api/desktop/dev-server/runtime',
        );
        expect(r.status).toBe(200);
        expect(r.json).toEqual({ runtime: { kind: 'docker' } });
    });

    it('POST /api/desktop/dev-server/repos returns the workspace repo subfolders', async () => {
        const token = await mintToken();
        const r = await call(
            postReq('/api/desktop/dev-server/repos', { workspaceId: 'w1' }, bearer(token)),
            '/api/desktop/dev-server/repos',
        );
        expect(r.status).toBe(200);
        expect(r.json).toEqual({ repos: ['api', 'web'] });
    });

    it('401s the runtime read without a token', async () => {
        const r = await call(
            getReq('/api/desktop/dev-server/runtime'),
            '/api/desktop/dev-server/runtime',
        );
        expect(r.status).toBe(401);
    });
});
