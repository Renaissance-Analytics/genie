import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type http from 'node:http';
import { handleApi, type MobileDataDeps } from '../api';
import {
    initAuth,
    attemptPair,
    _setPinForTest,
    _resetAuthForTest,
} from '../auth';
import { _resetAuditForTest } from '../audit';
import { setLocked, _resetBatonForTest } from '../baton';

/**
 * The host's `.gen` site endpoint, and the two that are GONE.
 *
 * `GET /api/sites/enabled` is the whole surface now: the containers this host's
 * Dev Server is serving. Like `/api/state` it needs a valid Bearer (401
 * without), and per §5 it honours the kill-switch even though it is a READ
 * (naming a machine's dev sites is sensitive), so a locked host returns 423.
 *
 * `GET /api/sites` and `POST /api/sites/set` were the hosts-file model's
 * remote surface — "list the loopback `*.test` vhosts you found" and "tunnel
 * this one". The container Dev Server replaced that source, so both are
 * removed rather than left answering; the last describe below is what keeps
 * them removed.
 *
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
    _resetBatonForTest();
});
afterEach(() => {
    _resetAuthForTest();
    _resetAuditForTest();
    _resetBatonForTest();
});

/**
 * The `.gen` snapshot a remote's header popover + Testing Browser resolver read,
 * and the same set the host site-proxy resolves an opaque siteId against.
 * Token- + kill-switch-gated; an empty set on a host that predates the feature.
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

/**
 * The RETIREMENT, asserted at the wire.
 *
 * A removed route must not merely stop working — it must 404 like any other
 * path this host does not have. A remote asking a new host to enumerate its
 * hosts file, or to tunnel a `*.test` vhost, is asking for a feature that no
 * longer exists; a 200 with an empty list would tell it the opposite, and it
 * would go on offering the user sites that can never load.
 */
describe('the retired hosts-file routes', () => {
    it('no longer answers GET /api/sites', async () => {
        const token = await mintToken();
        const r = fakeRes();
        await handleApi(
            req('/api/sites?workspaceId=w1', bearer(token)),
            r.res,
            '/api/sites',
            {} as MobileDataDeps,
            { ip: '100.0.0.1', ua: 'test' },
        );
        expect(r.status).toBe(404);
    });

    it('no longer answers POST /api/sites/set', async () => {
        const token = await mintToken();
        const r = fakeRes();
        const post = {
            method: 'POST',
            headers: bearer(token),
            url: '/api/sites/set',
        } as unknown as http.IncomingMessage;
        await handleApi(post, r.res, '/api/sites/set', {} as MobileDataDeps, {
            ip: '100.0.0.1',
            ua: 'test',
        });
        expect(r.status).toBe(404);
    });
});
