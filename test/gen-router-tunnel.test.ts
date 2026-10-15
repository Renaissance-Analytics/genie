import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, createSecureContext, type TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { GEN_CA_SUBJECT } from '../src/core/gen-ca.js';
import { GenRouterServer } from '../src/main/gen-router-server.js';
import { issueCa, issueLeaf } from '../src/main/x509.js';

/**
 * THE FRONT DOOR'S TUNNEL FOR THE GENIE BROWSER (S7) — over real sockets, in-process, the way Chromium uses a proxy:
 * `CONNECT site-a.gen:443`, then TLS that must verify against GENIE'S CA for that name, then plain HTTP inside. Each
 * site is reached at its own name and told `X-Forwarded-Proto: https`; anything that is not a served `.gen` site on
 * 443 is refused at CONNECT, so the door is never a general proxy.
 *
 * Real sockets on the test machine — never on the owner's desktop.
 */

const DAY = 24 * 60 * 60 * 1000;
const ca = issueCa({ ...GEN_CA_SUBJECT, notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + 3650 * DAY) });
const leaf = issueLeaf(ca, ['site-a.gen', 'site-b.gen'], new Date(Date.now() - DAY), new Date(Date.now() + 300 * DAY));
const context = createSecureContext({ cert: leaf.certPem, key: leaf.keyPem });

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const close of closers.splice(0)) await close();
});

async function site(name: string): Promise<{ port: number; seen: IncomingHttpHeaders[] }> {
    const seen: IncomingHttpHeaders[] = [];
    const server: Server = createServer((req, res) => {
        seen.push(req.headers);
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`hello from ${name}`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    return { port: (server.address() as { port: number }).port, seen };
}

async function door(routes: Array<{ host: string; target: string }>, tls: (host: string) => ReturnType<typeof createSecureContext> | null = () => context): Promise<number> {
    const d = new GenRouterServer(() => routes, { tls });
    const port = await d.listen();
    closers.push(() => new Promise<void>((r) => d.close(() => r())));
    return port;
}

/** Send raw bytes, read until the server closes or `until` matches. */
function raw(port: number, text: string, until: RegExp = /\r\n\r\n/): Promise<{ text: string; socket: Socket }> {
    return new Promise((resolve, reject) => {
        const socket = netConnect(port, '127.0.0.1', () => socket.write(text));
        let got = '';
        const done = () => resolve({ text: got, socket });
        // On a match the socket is paused and handed over as is (a CONNECT's socket becomes the TLS client's).
        socket.on('data', (c: Buffer) => { got += c.toString('latin1'); if (until.test(got)) { socket.pause(); socket.removeAllListeners('data'); socket.removeAllListeners('end'); done(); } });
        socket.on('end', done);
        socket.on('error', reject);
    });
}

/** CONNECT, then TLS verified against `trust` for `servername`, then one GET with `host`. */
async function throughTunnel(port: number, authority: string, servername: string, host: string, trust = ca.certPem): Promise<{ status: number; body: string }> {
    const { text, socket } = await raw(port, `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    if (!text.startsWith('HTTP/1.1 200')) throw new Error(`CONNECT answered ${JSON.stringify(text.split('\r\n')[0])}`);
    const secure: TLSSocket = await new Promise((resolve, reject) => {
        const s = tlsConnect({ socket, servername, ca: trust }, () => resolve(s));
        s.on('error', reject);
    });
    // A real HTTP client over the tunnel's TLS socket: it reads the response as HTTP/1.1 does (a chunked body included).
    return new Promise((resolve, reject) => {
        const req = httpRequest({ createConnection: () => secure, path: '/dashboard?x=1', headers: { host, connection: 'close' } }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c: string) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

describe('CONNECT to a served .gen site', () => {
    it('opens a TLS tunnel that verifies against GENIE’S CA for that name, and the site sees its own Host and X-Forwarded-Proto: https', async () => {
        const a = await site('site-a');
        const port = await door([{ host: 'site-a.gen', target: `127.0.0.1:${a.port}` }]);
        const r = await throughTunnel(port, 'site-a.gen:443', 'site-a.gen', 'site-a.gen');
        expect(r).toEqual({ status: 200, body: 'hello from site-a' });
        expect(a.seen).toHaveLength(1);
        expect(a.seen[0]).toMatchObject({ host: 'site-a.gen', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'site-a.gen' });
    });

    it('two sites, two tunnels: each reaches its own site, never the other', async () => {
        const a = await site('site-a');
        const b = await site('site-b');
        const port = await door([{ host: 'site-a.gen', target: `127.0.0.1:${a.port}` }, { host: 'site-b.gen', target: `127.0.0.1:${b.port}` }]);
        expect((await throughTunnel(port, 'site-a.gen:443', 'site-a.gen', 'site-a.gen')).body).toBe('hello from site-a');
        expect((await throughTunnel(port, 'site-b.gen:443', 'site-b.gen', 'site-b.gen')).body).toBe('hello from site-b');
        expect([a.seen.length, b.seen.length]).toEqual([1, 1]);
    });

    it('the tunnel’s certificate does NOT verify against another CA (the client side of the same rule)', async () => {
        const a = await site('site-a');
        const port = await door([{ host: 'site-a.gen', target: `127.0.0.1:${a.port}` }]);
        const other = issueCa({ commonName: 'Example Other CA', organization: 'Example', notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + DAY) });
        await expect(throughTunnel(port, 'site-a.gen:443', 'site-a.gen', 'site-a.gen', other.certPem)).rejects.toThrow();
        expect(a.seen).toHaveLength(0);
    });

    it('a request inside site-a’s tunnel that names site-b is 421 Misdirected — and site-b is not reached', async () => {
        const a = await site('site-a');
        const b = await site('site-b');
        const port = await door([{ host: 'site-a.gen', target: `127.0.0.1:${a.port}` }, { host: 'site-b.gen', target: `127.0.0.1:${b.port}` }]);
        const r = await throughTunnel(port, 'site-a.gen:443', 'site-a.gen', 'site-b.gen');
        expect(r.status).toBe(421);
        expect([a.seen.length, b.seen.length]).toEqual([0, 0]);
    });
});

describe('everything else is refused at CONNECT — the door is not a proxy', () => {
    it('counted: not .gen, not 443, nobody serves it, no certificate — and no site is reached', async () => {
        const a = await site('site-a');
        const routes = [{ host: 'site-a.gen', target: `127.0.0.1:${a.port}` }];
        const port = await door(routes);
        const noTls = await door(routes, () => null);
        const answers = await Promise.all([
            raw(port, 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'),
            raw(port, `CONNECT 127.0.0.1:${a.port} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`),
            raw(port, 'CONNECT site-a.gen:80 HTTP/1.1\r\nHost: site-a.gen:80\r\n\r\n'),
            raw(port, 'CONNECT ghost.gen:443 HTTP/1.1\r\nHost: ghost.gen:443\r\n\r\n'),
            raw(noTls, 'CONNECT site-a.gen:443 HTTP/1.1\r\nHost: site-a.gen:443\r\n\r\n'),
        ]);
        for (const r of answers) r.socket.destroy();
        expect(answers.map((r) => r.text.split('\r\n')[0])).toEqual([
            'HTTP/1.1 421 Misdirected Request',
            'HTTP/1.1 421 Misdirected Request',
            'HTTP/1.1 421 Misdirected Request',
            'HTTP/1.1 404 Not Found',
            'HTTP/1.1 502 Bad Gateway',
        ]);
        expect(a.seen).toHaveLength(0);
    });

    it('a proxied http://<site>.gen request is redirected to its https origin; a proxied non-.gen request is 421', async () => {
        const a = await site('site-a');
        const port = await door([{ host: 'site-a.gen', target: `127.0.0.1:${a.port}` }]);
        const up = await raw(port, 'GET http://site-a.gen/x?y=1 HTTP/1.1\r\nHost: site-a.gen\r\nConnection: close\r\n\r\n');
        expect(up.text.split('\r\n')[0]).toBe('HTTP/1.1 308 Permanent Redirect');
        expect(up.text).toMatch(/\r\nlocation: https:\/\/site-a\.gen\/x\?y=1\r\n/i);
        const web = await raw(port, 'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
        expect(web.text.split('\r\n')[0]).toBe('HTTP/1.1 421 Misdirected Request');
        for (const r of [up, web]) r.socket.destroy();
        expect(a.seen).toHaveLength(0);
    });

    it('control: a plain loopback request (origin-form) is proxied exactly as before, with no forwarded-proto added', async () => {
        const a = await site('site-a');
        const port = await door([{ host: 'site-a.gen', target: `127.0.0.1:${a.port}` }]);
        const r = await raw(port, 'GET /dashboard HTTP/1.1\r\nHost: site-a.gen\r\nConnection: close\r\n\r\n', /hello from site-a/);
        r.socket.destroy();
        expect(r.text.split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
        expect(a.seen[0]).toMatchObject({ host: 'site-a.gen' });
        expect(a.seen[0]!['x-forwarded-proto']).toBeUndefined();
    });
});
