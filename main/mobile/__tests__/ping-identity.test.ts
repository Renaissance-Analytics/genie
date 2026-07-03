import { describe, expect, it } from 'vitest';
import type http from 'node:http';
import { handleApi, type MobileDataDeps } from '../api';

/**
 * The `/api/ping` beacon is the ONLY thing a discovering client reads before it
 * pairs, so it must carry the STABLE host identity (`hostId`) + a display `name` +
 * the MagicDNS dial address — while staying back-compatible for an old client
 * (keeps `hostname`, tolerates a missing `hostId`). `/api/ping` touches no `deps`,
 * so a bare stub is enough (no DB / native module).
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

const req = { method: 'GET', headers: {}, url: '/api/ping' } as unknown as http.IncomingMessage;
const deps = {} as MobileDataDeps;

describe('/api/ping — stable host-identity beacon', () => {
    it('advertises hostId, name, dnsName, protocolVersion + appVersion', async () => {
        const r = fakeRes();
        const handled = await handleApi(req, r.res, '/api/ping', deps, {
            ip: '100.0.0.1',
            ua: 'test',
            serverVersion: '9.9.9',
            hostId: 'HID-abc',
            dnsName: 'alphar.tail1e.ts.net',
        });
        expect(handled).toBe(true);
        expect(r.status).toBe(200);
        const j = r.json!;
        expect(j.genie).toBe(true);
        expect(j.hostId).toBe('HID-abc');
        expect(typeof j.name).toBe('string');
        expect(j.dnsName).toBe('alphar.tail1e.ts.net');
        expect(j.appVersion).toBe('9.9.9');
        expect(typeof j.protocolVersion).toBe('number');
        // Back-compat: the original `hostname` field is still present.
        expect(typeof j.hostname).toBe('string');
    });

    it('degrades gracefully when the host has no hostId/dnsName (old build)', async () => {
        const r = fakeRes();
        await handleApi(req, r.res, '/api/ping', deps, { ip: '100.0.0.1', ua: 'test' });
        const j = r.json!;
        expect(j.genie).toBe(true);
        expect(j.hostId).toBe(null);
        expect(j.dnsName).toBe(null);
        expect(typeof j.hostname).toBe('string');
    });
});
