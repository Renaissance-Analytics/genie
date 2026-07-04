import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { SessionCa } from '../site-ca';
import {
    buildForwardHeaders,
    buildForwardResponseHeaders,
    createSiteShim,
    forwardPath,
    isGenHost,
    rewriteGenLocation,
    rewriteGenSetCookieDomain,
    stripHostPort,
    type GenTarget,
    type SiteShim,
} from '../site-proxy';
import { createTailnetSiteCarrier } from '../site-carrier';

/**
 * Serve-local-sites Phase D — the REMOTE forward-proxy shim (design §4/§5). Pure
 * helpers are unit-tested directly; the FULL shim is driven end-to-end WITHOUT a
 * display: a fake host `/api/site/<id>` upstream stands in for the Phase-C host
 * proxy, and a raw CONNECT + TLS(session-CA) client stands in for the Testing
 * Browser's session. We assert:
 *   (a) an enabled `https://tynn.gen` is MITM-terminated (leaf trusts the session
 *       CA) and forwarded to `/api/site/<siteId>/…` with the Bearer added IN MAIN
 *       + the preserve-origin header, and NO token demanded from the browser leg;
 *   (b) the `.test`⇄`.gen` origin rewrite on `Location` + `Set-Cookie Domain`,
 *       with HSTS + `Secure` preserved (no Phase-C downgrade);
 *   (c) a non-`.gen` host, and a disabled/unknown `.gen`, are REFUSED at CONNECT;
 *   (d) two connections' shims/CAs form isolated `.gen` spaces (a leaf from one is
 *       not trusted by the other) — hostA `tynn.gen` ≠ hostB `tynn.gen`.
 */

// --- pure helpers ----------------------------------------------------------

describe('shim pure helpers', () => {
    it('stripHostPort / isGenHost', () => {
        expect(stripHostPort('tynn.gen:443')).toBe('tynn.gen');
        expect(stripHostPort('TYNN.GEN')).toBe('tynn.gen');
        expect(stripHostPort(undefined)).toBe('');
        expect(isGenHost('tynn.gen')).toBe(true);
        expect(isGenHost('mail.tynn.gen')).toBe(true);
        expect(isGenHost('tynn.test')).toBe(false);
        expect(isGenHost('.gen')).toBe(false);
        expect(isGenHost('evil.com')).toBe(false);
    });

    it('rewriteGenLocation maps the site origin .test → .gen (https preserved)', () => {
        expect(rewriteGenLocation('https://tynn.test/next?q=1', 'tynn.test', 'tynn.gen')).toBe(
            'https://tynn.gen/next?q=1',
        );
        // A DIFFERENT host is left alone (not ours to rewrite).
        expect(rewriteGenLocation('https://other.test/x', 'tynn.test', 'tynn.gen')).toBe(
            'https://other.test/x',
        );
        // Root-relative resolves against the .gen origin — leave it.
        expect(rewriteGenLocation('/dashboard', 'tynn.test', 'tynn.gen')).toBe('/dashboard');
    });

    it('rewriteGenSetCookieDomain maps Domain= and keeps Secure', () => {
        expect(
            rewriteGenSetCookieDomain('sid=abc; Path=/; Secure; Domain=tynn.test', 'tynn.test', 'tynn.gen'),
        ).toBe('sid=abc; Path=/; Secure; Domain=tynn.gen');
        // Leading-dot domain preserved.
        expect(
            rewriteGenSetCookieDomain('a=1; Domain=.tynn.test; HttpOnly', 'tynn.test', 'tynn.gen'),
        ).toBe('a=1; Domain=.tynn.gen; HttpOnly');
        // Host-only cookie (no Domain) untouched.
        expect(rewriteGenSetCookieDomain('a=1; Secure', 'tynn.test', 'tynn.gen')).toBe('a=1; Secure');
    });

    it('buildForwardHeaders drops Host/Authorization/hop-by-hop; forwardPath prefixes siteId', () => {
        const out = buildForwardHeaders({
            host: 'tynn.gen',
            authorization: 'Bearer LEAK',
            connection: 'keep-alive',
            'x-custom': 'v',
        });
        expect(out['host']).toBeUndefined();
        expect(out['authorization']).toBeUndefined();
        expect(out['connection']).toBeUndefined();
        expect(out['x-custom']).toBe('v');
        expect(forwardPath('abc123', '/foo?x=1')).toBe('/api/site/abc123/foo?x=1');
        expect(forwardPath('abc123', undefined)).toBe('/api/site/abc123/');
    });

    it('buildForwardResponseHeaders keeps HSTS + rewrites origin headers', () => {
        const out = buildForwardResponseHeaders(
            {
                location: 'https://tynn.test/x',
                'set-cookie': ['s=1; Secure; Domain=tynn.test'],
                'strict-transport-security': 'max-age=63072000',
                connection: 'close',
            },
            'tynn.test',
            'tynn.gen',
        );
        expect(out['location']).toBe('https://tynn.gen/x');
        expect(out['set-cookie']).toEqual(['s=1; Secure; Domain=tynn.gen']);
        expect(out['strict-transport-security']).toBe('max-age=63072000'); // HSTS preserved
        expect(out['connection']).toBeUndefined(); // hop-by-hop stripped
    });
});

// --- end-to-end drive ------------------------------------------------------

const SITE_ID = 'abc123siteid0000';
const HOSTNAME = 'tynn.test';
const GEN = 'tynn.gen';

let fakeHost: http.Server;
let fakeHostPort = 0;
let lastAuth: string | undefined;
let lastPreserve: string | undefined;
let lastPath: string | undefined;

beforeEach(async () => {
    lastAuth = undefined;
    lastPreserve = undefined;
    lastPath = undefined;
    fakeHost = http.createServer((req, res) => {
        lastAuth = req.headers['authorization'];
        lastPreserve = req.headers['x-genie-preserve-origin'] as string | undefined;
        lastPath = req.url;
        if (req.url?.includes('/redir')) {
            res.writeHead(302, {
                Location: 'https://tynn.test/next?q=1',
                'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
                'Set-Cookie': ['sid=abc; Path=/; Secure; Domain=tynn.test'],
            });
            res.end();
            return;
        }
        const body = 'hello from the host site';
        res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
    });
    await new Promise<void>((resolve) => fakeHost.listen(0, '127.0.0.1', resolve));
    fakeHostPort = (fakeHost.address() as AddressInfo).port;
});

afterEach(async () => {
    await new Promise<void>((resolve) => fakeHost.close(() => resolve()));
});

function makeShim(ca: SessionCa, genMap: Map<string, GenTarget>): Promise<SiteShim> {
    return createSiteShim({
        ca,
        // The tailnet (direct-dial) carrier — injects the Bearer + `?__genie_token=`
        // IN MAIN, so the host leg sees them exactly as in Phase D.
        carrier: createTailnetSiteCarrier(`http://127.0.0.1:${fakeHostPort}`, () => 'THE_SESSION_TOKEN'),
        resolveGen: (h) => genMap.get(h) ?? null,
    });
}

/** Open a CONNECT tunnel through the shim; resolve the raw tunneled socket, or
 *  reject with the non-200 CONNECT status (a refusal). */
function connectTunnel(shimPort: number, hostport: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: shimPort, method: 'CONNECT', path: hostport });
        req.on('connect', (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                reject(new Error(`CONNECT ${res.statusCode}`));
                return;
            }
            resolve(socket);
        });
        req.on('error', reject);
        req.end();
    });
}

/** A full request THROUGH the shim: CONNECT → TLS(trusting `caPem`) → GET. */
async function fetchThroughShim(
    shim: SiteShim,
    genHost: string,
    path: string,
    caPem: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const socket = await connectTunnel(shim.port, `${genHost}:443`);
    const tlsSock = tls.connect({
        socket,
        servername: genHost,
        ca: [caPem],
    });
    await once(tlsSock, 'secureConnect');
    tlsSock.write(`GET ${path} HTTP/1.1\r\nHost: ${genHost}\r\nConnection: close\r\n\r\n`);
    const chunks: Buffer[] = [];
    for await (const c of tlsSock) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const [head, ...rest] = raw.split('\r\n\r\n');
    const lines = head.split('\r\n');
    const status = Number(lines[0].split(' ')[1]);
    const headers: Record<string, string> = {};
    for (const line of lines.slice(1)) {
        const idx = line.indexOf(':');
        if (idx > 0) {
            const k = line.slice(0, idx).trim().toLowerCase();
            const v = line.slice(idx + 1).trim();
            headers[k] = headers[k] ? `${headers[k]}, ${v}` : v;
        }
    }
    return { status, headers, body: rest.join('\r\n\r\n') };
}

describe('shim end-to-end (no display)', () => {
    it('MITM-terminates an enabled .gen and forwards with the Bearer + preserve-origin', async () => {
        const ca = new SessionCa();
        const genMap = new Map<string, GenTarget>([[GEN, { siteId: SITE_ID, hostname: HOSTNAME }]]);
        const shim = await makeShim(ca, genMap);
        try {
            const res = await fetchThroughShim(shim, GEN, '/', ca.caPem);
            expect(res.status).toBe(200);
            expect(res.body).toBe('hello from the host site');
            // Bearer injected IN MAIN on the host leg (never demanded from the browser).
            expect(lastAuth).toBe('Bearer THE_SESSION_TOKEN');
            expect(lastPreserve).toBe('1');
            // Forwarded to the opaque siteId endpoint (SSRF-safe selector).
            expect(lastPath).toBe(`/api/site/${SITE_ID}/`);
        } finally {
            await shim.close();
        }
    });

    it('applies the .test⇄.gen rewrite and preserves HSTS + Secure', async () => {
        const ca = new SessionCa();
        const genMap = new Map<string, GenTarget>([[GEN, { siteId: SITE_ID, hostname: HOSTNAME }]]);
        const shim = await makeShim(ca, genMap);
        try {
            const res = await fetchThroughShim(shim, GEN, '/redir', ca.caPem);
            expect(res.status).toBe(302);
            expect(res.headers['location']).toBe('https://tynn.gen/next?q=1');
            expect(res.headers['set-cookie']).toContain('Domain=tynn.gen');
            expect(res.headers['set-cookie']).toContain('Secure'); // preserved (valid https)
            expect(res.headers['strict-transport-security']).toContain('max-age=63072000');
        } finally {
            await shim.close();
        }
    });

    it('REFUSES a non-.gen host and a disabled/unknown .gen at CONNECT', async () => {
        const ca = new SessionCa();
        const genMap = new Map<string, GenTarget>([[GEN, { siteId: SITE_ID, hostname: HOSTNAME }]]);
        const shim = await makeShim(ca, genMap);
        try {
            await expect(connectTunnel(shim.port, 'evil.com:443')).rejects.toThrow('CONNECT 403');
            await expect(connectTunnel(shim.port, 'other.gen:443')).rejects.toThrow('CONNECT 403');
        } finally {
            await shim.close();
        }
    });

    it('isolates two connections: a leaf from one CA is not trusted via the other', async () => {
        const caA = new SessionCa();
        const caB = new SessionCa();
        const genMap = new Map<string, GenTarget>([[GEN, { siteId: SITE_ID, hostname: HOSTNAME }]]);
        const shimA = await makeShim(caA, genMap);
        try {
            // Trusting hostA's OWN CA works.
            const ok = await fetchThroughShim(shimA, GEN, '/', caA.caPem);
            expect(ok.status).toBe(200);
            // Trusting hostB's CA for hostA's tynn.gen fails the TLS handshake — the
            // same name in a different session is a different, untrusted cert.
            await expect(fetchThroughShim(shimA, GEN, '/', caB.caPem)).rejects.toBeTruthy();
        } finally {
            await shimA.close();
        }
    });
});
