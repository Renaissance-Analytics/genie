import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { Readable } from 'node:stream';
import {
    createGenHttpsBodyRewriter,
    createLocalSiteCarrier,
    type LocalTarget,
} from '../local-carrier';

/**
 * Site-agnostic https backstop for the in-app Testing Browser (genie#238 tail,
 * follow-up to the #188 forwarded-proto header).
 *
 * THE BUG (reported for MANY agent-built `.gen` sites, not just tynn.gen): a site
 * whose app does NOT trust the proxy still emits `http://<name>.gen` self-links
 * and redirects; the Testing Browser BLOCKS them (only https is allowed on a
 * `.gen`). The #188 `X-Forwarded-Proto: https` header only fixes proxy-TRUSTING
 * apps — so it is not site-agnostic.
 *
 * THE FIX: the carrier is the https-terminating reverse proxy for every `.gen`,
 * so — exactly like the external host Caddy (`replace` + `header_down Location`) —
 * it must rewrite `http://<thisGenHost>` → `https://<thisGenHost>` in the response
 * body AND the `Location` header, scoped to the site's OWN host so third-party
 * URLs are untouched. This works for ANY stack, cooperating or not.
 */

const servers: http.Server[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function upstream(opts: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    chunks?: string[];
}): Promise<number> {
    const server = http.createServer((_req, res) => {
        res.writeHead(opts.status ?? 200, {
            'content-type': 'text/html; charset=utf-8',
            ...(opts.headers ?? {}),
        });
        if (opts.chunks) {
            for (const c of opts.chunks) res.write(c);
            res.end();
        } else {
            res.end(opts.body ?? '');
        }
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return (server.address() as { port: number }).port;
}

const target = (port: number, hostname = 'tynn.gen'): LocalTarget => ({
    scheme: 'http',
    hostname,
    port,
    loopback: '127.0.0.1',
});

async function forward(
    t: LocalTarget,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    const carrier = createLocalSiteCarrier(() => t);
    const call = carrier.forward({
        method: 'GET',
        path: '/api/site/s1/',
        headers: { host: t.hostname },
        body: Readable.from([]),
    } as never);
    const res = (await call.response) as {
        status: number;
        headers: http.IncomingHttpHeaders;
        body: NodeJS.ReadableStream;
    };
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
        res.body.on('data', (c) => chunks.push(Buffer.from(c)));
        res.body.on('end', () => resolve());
        res.body.on('error', reject);
    });
    return { status: res.status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') };
}

describe('local carrier — site-agnostic https backstop (body + Location rewrite)', () => {
    it('rewrites http://<host> self-links to https in the HTML body', async () => {
        const port = await upstream({ body: '<a href="http://tynn.gen/genie">go</a>' });
        const r = await forward(target(port));
        expect(r.body).toBe('<a href="https://tynn.gen/genie">go</a>');
    });

    it('is site-agnostic — rewrites whatever gen host the target is (not just tynn.gen)', async () => {
        const port = await upstream({ body: 'visit http://moic.gen/app now' });
        const r = await forward(target(port, 'moic.gen'));
        expect(r.body).toBe('visit https://moic.gen/app now');
    });

    it('leaves OTHER hosts alone', async () => {
        const port = await upstream({ body: 'http://tynn.gen/a plus http://example.com/b' });
        const r = await forward(target(port));
        expect(r.body).toBe('https://tynn.gen/a plus http://example.com/b');
    });

    it('upgrades a Location redirect pointing at the gen host', async () => {
        const port = await upstream({ status: 302, headers: { location: 'http://tynn.gen/login' } });
        const r = await forward(target(port));
        expect(r.headers.location).toBe('https://tynn.gen/login');
    });

    it('rewrites a match split across chunk boundaries', async () => {
        const port = await upstream({ chunks: ['before http://tyn', 'n.gen/x after'] });
        const r = await forward(target(port));
        expect(r.body).toBe('before https://tynn.gen/x after');
    });

    it('does not rewrite non-text (binary) content types', async () => {
        const port = await upstream({ headers: { 'content-type': 'image/svg+xml' }, body: 'ok' });
        // svg IS text — use a truly binary type instead:
        const bin = await upstream({ headers: { 'content-type': 'application/octet-stream' }, body: 'http://tynn.gen/x' });
        const r = await forward(target(bin));
        expect(r.body).toBe('http://tynn.gen/x');
        servers.length; // keep both servers referenced for afterEach cleanup
        void port;
    });

    it('drops content-length when it rewrites (the body length changes)', async () => {
        const port = await upstream({ body: 'http://tynn.gen/x' });
        const r = await forward(target(port));
        expect(r.body).toBe('https://tynn.gen/x');
        expect(r.headers['content-length']).toBeUndefined();
    });
});

describe('createGenHttpsBodyRewriter — boundary-safe streaming replace', () => {
    it('rewrites every occurrence even when fed one byte at a time', async () => {
        const rw = createGenHttpsBodyRewriter('tynn.gen');
        const input = 'a http://tynn.gen/1 b http://tynn.gen/2 c';
        const out: Buffer[] = [];
        rw.on('data', (c) => out.push(Buffer.from(c)));
        const done = new Promise<void>((r) => rw.on('end', () => r()));
        for (const byte of Buffer.from(input)) rw.write(Buffer.from([byte]));
        rw.end();
        await done;
        expect(Buffer.concat(out).toString('utf8')).toBe(
            'a https://tynn.gen/1 b https://tynn.gen/2 c',
        );
    });
});

/**
 * The carrier is the in-process twin of the host Caddy, so it inherits the same
 * beta.236 gap: the body and `Location` were covered, `Link` was not.
 *
 * MEASURED on biz.gen — a Laravel app advertises its Vite preloads in ONE `Link`
 * header holding every asset, built with `url()`, so a site that does not know it
 * is behind TLS emits `http://<name>.gen/...` there and the Testing Browser blocks
 * all of them. Unlike `Location` (one url, matched at `^http:`) this header holds
 * MANY, so every occurrence of THIS site's host has to be upgraded — and no other
 * host's, so a third-party CDN preload is left exactly as the app wrote it.
 */
describe('local carrier — the Link preload header is upgraded too', () => {
    it('upgrades EVERY http://<host> url in a multi-url Link header', async () => {
        const port = await upstream({
            headers: {
                link: '<http://tynn.gen/a.woff2>; rel="preload"; as="font", <http://tynn.gen/b.css>; rel="preload"; as="style"',
            },
        });
        const r = await forward(target(port));
        expect(r.headers.link).toBe(
            '<https://tynn.gen/a.woff2>; rel="preload"; as="font", <https://tynn.gen/b.css>; rel="preload"; as="style"',
        );
    });

    it('leaves a third-party preload alone', async () => {
        const port = await upstream({
            headers: {
                link: '<http://tynn.gen/own.js>; rel="modulepreload", <http://cdn.example.com/x.js>; rel="modulepreload"',
            },
        });
        const r = await forward(target(port));
        expect(r.headers.link).toBe(
            '<https://tynn.gen/own.js>; rel="modulepreload", <http://cdn.example.com/x.js>; rel="modulepreload"',
        );
    });

    it('is site-agnostic — upgrades whichever gen host the target is', async () => {
        const port = await upstream({ headers: { link: '<http://moic.gen/a.css>; rel="preload"' } });
        const r = await forward(target(port, 'moic.gen'));
        expect(r.headers.link).toBe('<https://moic.gen/a.css>; rel="preload"');
    });

    it('leaves a response with no Link header untouched', async () => {
        const port = await upstream({ body: 'ok' });
        const r = await forward(target(port));
        expect(r.headers.link).toBeUndefined();
    });
});
