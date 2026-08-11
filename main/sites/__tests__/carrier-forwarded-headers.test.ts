import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { Readable } from 'node:stream';
import { createLocalSiteCarrier, type LocalTarget } from '../local-carrier';

/**
 * Forwarded-proto headers on the LOCAL carrier's upstream dial (genie#238 tail).
 *
 * THE BUG (live on tynn.gen): a HOST-NATIVE site — a repo's own dev server run
 * on the host (`php artisan serve`, `runMode: 'host'`) — viewed in the in-app
 * Testing Browser emitted `http://<name>.gen/…` self-links/redirects, which the
 * Testing Browser BLOCKS (`ERR_BLOCKED_BY_CLIENT` — only https is allowed on a
 * `.gen`). `http://tynn.gen/genie` came back blocked.
 *
 * ROOT CAUSE: the carrier terminates TLS at `.gen` (the browser sees
 * `https://<name>.gen`) and then dials the loopback target directly. For a
 * CONTAINER site the target is the sandbox Caddy, which sets
 * `X-Forwarded-Proto: https` and rewrites the body. For a HOST-NATIVE site the
 * carrier dials the dev server (plain http) DIRECTLY — no Caddy, no
 * forwarded-proto header — so a proxy-trusting app (Tynn: `trustProxies(at:'*')`)
 * sees plain http and builds `http://<name>.gen` self-links.
 *
 * THE INVARIANT: the carrier IS an https-terminating reverse proxy for every
 * `.gen` site, so its upstream dial must carry the standard reverse-proxy
 * forwarded headers — `X-Forwarded-Proto: https` (+ `X-Forwarded-Host: <genName>`
 * and an `X-Forwarded-For` of the loopback) — exactly what Caddy already sends on
 * the external-browser path.
 *
 * These drive a REAL plain-http upstream (a host-native dev server) through the
 * carrier and assert on the headers it actually received.
 */

const servers: http.Server[] = [];

afterEach(async () => {
    await Promise.all(
        servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
});

/** A plain-http upstream (a host-native dev server) that records what it received. */
async function upstream(): Promise<{ port: number; headers: () => http.IncomingHttpHeaders }> {
    let received: http.IncomingHttpHeaders = {};
    const server = http.createServer((req, res) => {
        received = req.headers;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    return { port, headers: () => received };
}

/** One GET through the carrier at a host-native target; drains + resolves status. */
async function forwardGet(
    target: LocalTarget,
    headers: Record<string, string> = {},
): Promise<number> {
    const carrier = createLocalSiteCarrier(() => target);
    const call = carrier.forward({
        method: 'GET',
        path: '/api/site/s1/genie',
        headers: { host: 'tynn.gen', ...headers },
        body: Readable.from([]),
    } as never);
    const res = (await call.response) as { status: number; body: NodeJS.ReadableStream };
    await new Promise<void>((r) => {
        res.body.on('data', () => {});
        res.body.on('end', () => r());
        res.body.on('error', () => r());
    });
    return res.status;
}

function hostNativeTarget(port: number): LocalTarget {
    // A host-native dev server speaks PLAIN http on the host port; the carrier's
    // session-CA shim is what adds the `https://<name>.gen` the browser sees.
    return { scheme: 'http', hostname: 'tynn.gen', port, loopback: '127.0.0.1' };
}

describe('local site carrier — forwarded headers for a host-native .gen site', () => {
    it('tells a plain-http host-native upstream it is behind https at its .gen origin', async () => {
        const up = await upstream();
        expect(await forwardGet(hostNativeTarget(up.port))).toBe(200);
        const h = up.headers();
        // The crux: without this the app builds `http://tynn.gen/…` self-links the
        // Testing Browser blocks.
        expect(h['x-forwarded-proto']).toBe('https');
        expect(h['x-forwarded-host']).toBe('tynn.gen');
        expect(h['x-forwarded-for']).toBe('127.0.0.1');
    });

    it('overrides a browser-supplied X-Forwarded-Proto: http to https for the .gen origin', async () => {
        const up = await upstream();
        // The browser/session layer reached the carrier over https, so whatever it
        // (or an intermediary) forwarded, the upstream must see https.
        expect(await forwardGet(hostNativeTarget(up.port), { 'x-forwarded-proto': 'http' })).toBe(
            200,
        );
        expect(up.headers()['x-forwarded-proto']).toBe('https');
    });
});
