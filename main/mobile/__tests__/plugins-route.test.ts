import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type http from 'node:http';
import { Readable } from 'node:stream';

/**
 * genie#101 — the host's Settings → Plugins MANAGEMENT surface for a remote DESKTOP
 * driving this host: `GET /api/desktop/plugins` (+ `/marketplaces`, `/official`,
 * `/developer-mode`) and the `POST /api/desktop/plugins/*` writes. Plugin abilities
 * (MCP tools + recipes) run on the HOST, so the remote window manages the HOST's
 * registry — these routes run the SAME `plugins/manage.ts` operations the local
 * `plugins:*` IPC calls, never a divergent re-implementation.
 *
 * Asserted here (the ROUTE, not the ops — `manage` is mocked): a valid Bearer is
 * required (401 without); READS (list/developer-mode/…) are ungated so a view-only
 * member still sees the host's plugins; WRITES (enable/set-grant/…) take the BATON
 * exactly like process-control (423 when someone else drives, and never run the op),
 * dispatch to the matching operation with parsed args, and are audited.
 */

const manage = vi.hoisted(() => ({
    pluginsList: vi.fn(),
    pluginsInstallRepo: vi.fn(),
    pluginsEnable: vi.fn(),
    pluginsSetGrant: vi.fn(),
    pluginsUninstall: vi.fn(),
    pluginsMarketplaces: vi.fn(),
    pluginsAddMarketplace: vi.fn(),
    pluginsRefreshMarketplace: vi.fn(),
    pluginsRefreshMarketplaces: vi.fn(),
    pluginsRemoveMarketplace: vi.fn(),
    pluginsInstallMarketplacePlugin: vi.fn(),
    pluginsOfficial: vi.fn(),
    pluginsInstallBundled: vi.fn(),
    pluginsDeveloperMode: vi.fn(),
    pluginsSetDeveloperMode: vi.fn(),
    pluginsAddTrustedKey: vi.fn(),
    pluginsRemoveTrustedKey: vi.fn(),
}));
vi.mock('../../plugins/manage', () => manage);

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
    for (const fn of Object.values(manage)) fn.mockReset();
    manage.pluginsList.mockReturnValue([{ id: 'a.b.c', name: 'C' }]);
    manage.pluginsDeveloperMode.mockReturnValue({ enabled: true, keys: [{ keyId: 'k1' }] });
    manage.pluginsEnable.mockResolvedValue({ ok: true, value: true });
    manage.pluginsSetGrant.mockReturnValue({ ok: true, value: true });
});
afterEach(() => {
    _resetAuthForTest();
    _resetAuditForTest();
    _resetBatonForTest();
    setLocked(false);
});

const LIST = '/api/desktop/plugins';
const ENABLE = '/api/desktop/plugins/enable';
const SET_GRANT = '/api/desktop/plugins/set-grant';
const DEV_MODE = '/api/desktop/plugins/developer-mode';

describe('GET /api/desktop/plugins (reads)', () => {
    it('rejects an unauthenticated request with 401 and never touches the registry', async () => {
        const r = await call(getReq(LIST), LIST);
        expect(r.handled).toBe(true);
        expect(r.status).toBe(401);
        expect(manage.pluginsList).not.toHaveBeenCalled();
    });

    it('serves list() even when another driver holds the baton — ungated read', async () => {
        const token = await mintToken();
        setLocked(true);
        const r = await call(getReq(LIST, bearer(token)), LIST);
        expect(r.status).toBe(200);
        expect(r.json).toEqual({ plugins: [{ id: 'a.b.c', name: 'C' }] });
        expect(manage.pluginsList).toHaveBeenCalled();
    });

    it('serves developer-mode state directly (ungated read)', async () => {
        const token = await mintToken();
        setLocked(true);
        const r = await call(getReq(DEV_MODE, bearer(token)), DEV_MODE);
        expect(r.status).toBe(200);
        expect(r.json).toEqual({ enabled: true, keys: [{ keyId: 'k1' }] });
    });
});

describe('POST /api/desktop/plugins/* (writes)', () => {
    it('refuses enable with 423 when another driver holds the baton, and never runs it', async () => {
        const token = await mintToken();
        setLocked(true);
        const r = await call(postReq(ENABLE, { id: 'a.b.c', enabled: true }, bearer(token)), ENABLE);
        expect(r.status).toBe(423);
        expect(manage.pluginsEnable).not.toHaveBeenCalled();
    });

    it('runs enable through the manager when unlocked, and audits it', async () => {
        const token = await mintToken();
        const r = await call(postReq(ENABLE, { id: 'a.b.c', enabled: true }, bearer(token)), ENABLE);
        expect(r.status).toBe(200);
        expect(r.json).toEqual({ ok: true, value: true });
        expect(manage.pluginsEnable).toHaveBeenCalledWith('a.b.c', true);
        expect(recentAudit().find((e) => e.action === 'plugins.enable')).toBeDefined();
    });

    it('dispatches set-grant with the parsed category/key/granted', async () => {
        const token = await mintToken();
        const r = await call(
            postReq(SET_GRANT, { id: 'a.b.c', category: 'network', key: 'api.example.com', granted: true }, bearer(token)),
            SET_GRANT,
        );
        expect(r.status).toBe(200);
        expect(manage.pluginsSetGrant).toHaveBeenCalledWith('a.b.c', 'network', 'api.example.com', true);
        expect(recentAudit().find((e) => e.action === 'plugins.set-grant')).toBeDefined();
    });

    it('401s a write without a token and never runs it', async () => {
        const r = await call(postReq(ENABLE, { id: 'a.b.c', enabled: true }), ENABLE);
        expect(r.status).toBe(401);
        expect(manage.pluginsEnable).not.toHaveBeenCalled();
    });

    it('404s an unknown plugins route', async () => {
        const token = await mintToken();
        const r = await call(
            postReq('/api/desktop/plugins/nope', {}, bearer(token)),
            '/api/desktop/plugins/nope',
        );
        expect(r.status).toBe(404);
    });
});
