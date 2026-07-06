import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type http from 'node:http';
import { handleApi, type MobileDataDeps } from '../api';
import type { SiteView } from '../hosts';
import {
    initAuth,
    attemptPair,
    _setPinForTest,
    _resetAuthForTest,
} from '../auth';
import { setLocked, _resetAuditForTest } from '../audit';

/**
 * `GET /api/sites` is the remote/programmatic view of the host's discovered dev
 * sites. Like `/api/state` it needs a valid Bearer (401 without), and per §5 it
 * honours the kill-switch even though it's a READ (listing a local admin panel is
 * sensitive), so a locked host returns 423. When open it returns the merged set.
 * Modeled on ping-identity.test.ts (a captured fake ServerResponse).
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

const SITES: SiteView[] = [
    {
        hostname: 'tynn.test',
        scheme: 'https',
        port: 443,
        kind: 'site',
        enabled: true,
        genName: 'tynn.gen',
        siteId: 'abc123',
    },
];

/** A minimal deps whose listSites records the workspaceId it was called with. */
function deps(): { deps: MobileDataDeps; calls: Array<string | undefined> } {
    const calls: Array<string | undefined> = [];
    const d = {
        listSites: async (workspaceId?: string) => {
            calls.push(workspaceId);
            return SITES;
        },
    } as unknown as MobileDataDeps;
    return { deps: d, calls };
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

beforeEach(() => {
    _resetAuthForTest();
    _resetAuditForTest();
});
afterEach(() => {
    _resetAuthForTest();
    _resetAuditForTest();
});

describe('GET /api/sites', () => {
    it('rejects an unauthenticated request with 401', async () => {
        const r = fakeRes();
        const handled = await handleApi(req('/api/sites'), r.res, '/api/sites', deps().deps, {
            ip: '100.0.0.1',
            ua: 'test',
        });
        expect(handled).toBe(true);
        expect(r.status).toBe(401);
    });

    it('returns 423 when the kill-switch is engaged (even for a read)', async () => {
        const token = await mintToken();
        setLocked(true);
        const r = fakeRes();
        await handleApi(req('/api/sites', bearer(token)), r.res, '/api/sites', deps().deps, {
            ip: '100.0.0.1',
            ua: 'test',
        });
        expect(r.status).toBe(423);
        setLocked(false);
    });

    it('returns the merged discovered set for a valid token, passing workspaceId', async () => {
        const token = await mintToken();
        const d = deps();
        const r = fakeRes();
        await handleApi(
            req('/api/sites?workspaceId=w1', bearer(token)),
            r.res,
            '/api/sites',
            d.deps,
            { ip: '100.0.0.1', ua: 'test' },
        );
        expect(r.status).toBe(200);
        expect(r.json).toEqual({ sites: SITES });
        expect(d.calls).toEqual(['w1']); // the query workspaceId reached listSites
    });

    it('returns an empty set when the host does not support sites', async () => {
        const token = await mintToken();
        const r = fakeRes();
        await handleApi(
            req('/api/sites', bearer(token)),
            r.res,
            '/api/sites',
            {} as MobileDataDeps,
            { ip: '100.0.0.1', ua: 'test' },
        );
        expect(r.status).toBe(200);
        expect(r.json).toEqual({ sites: [] });
    });
});

/**
 * `GET /api/sites/enabled` is the ENABLED-only `.gen` snapshot aggregated across
 * ALL the host's workspaces — the source a remote's header popover + Testing
 * Browser resolver read (never `/api/sites`, which needs a workspaceId and
 * returns everything disabled without one). Token- + kill-switch-gated like
 * `/api/sites`; an empty set on a host that predates the feature.
 */
describe('GET /api/sites/enabled', () => {
    const ENABLED = [
        {
            genName: 'tynn.gen',
            siteId: 'abc123',
            hostname: 'tynn.test',
            scheme: 'https' as const,
            port: 443,
        },
    ];

    it('rejects an unauthenticated request with 401', async () => {
        const r = fakeRes();
        const d = { listEnabledSites: async () => ENABLED } as unknown as MobileDataDeps;
        const handled = await handleApi(
            req('/api/sites/enabled'),
            r.res,
            '/api/sites/enabled',
            d,
            { ip: '100.0.0.1', ua: 'test' },
        );
        expect(handled).toBe(true);
        expect(r.status).toBe(401);
    });

    it('returns 423 when the kill-switch is engaged (even for a read)', async () => {
        const token = await mintToken();
        setLocked(true);
        const r = fakeRes();
        const d = { listEnabledSites: async () => ENABLED } as unknown as MobileDataDeps;
        await handleApi(
            req('/api/sites/enabled', bearer(token)),
            r.res,
            '/api/sites/enabled',
            d,
            { ip: '100.0.0.1', ua: 'test' },
        );
        expect(r.status).toBe(423);
        setLocked(false);
    });

    it('returns the aggregated enabled set for a valid token (no workspaceId)', async () => {
        const token = await mintToken();
        const r = fakeRes();
        const d = { listEnabledSites: async () => ENABLED } as unknown as MobileDataDeps;
        await handleApi(
            req('/api/sites/enabled', bearer(token)),
            r.res,
            '/api/sites/enabled',
            d,
            { ip: '100.0.0.1', ua: 'test' },
        );
        expect(r.status).toBe(200);
        expect(r.json).toEqual({ sites: ENABLED });
    });

    it('returns an empty set when the host does not support sites', async () => {
        const token = await mintToken();
        const r = fakeRes();
        await handleApi(
            req('/api/sites/enabled', bearer(token)),
            r.res,
            '/api/sites/enabled',
            {} as MobileDataDeps,
            { ip: '100.0.0.1', ua: 'test' },
        );
        expect(r.status).toBe(200);
        expect(r.json).toEqual({ sites: [] });
    });
});
