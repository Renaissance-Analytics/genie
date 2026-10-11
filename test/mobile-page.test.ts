import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachWebSocketServer } from '@particle-academy/fancy-ws';
import { remoteListener, type RemoteListener } from '../src/main/remote-listen.js';
import { staticServer } from '../src/main/static-page.js';

/**
 * THE LISTENER SERVES THE PHONE'S PAGE (§6.8). The Tailscale-bound port that carries the remote
 * socket also answers GET for the built renderer — `/mobile` and its hashed assets — and NOTHING
 * else: another path is 404, another method is 405, and a listener given no page to serve keeps
 * answering 404 to everything, which is the positive control for "the 404 is a decision, not a
 * missing file". Tested over a real socket on the loopback as the Tailscale IPv4.
 */

const running = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'alphar.tailnet.invalid.', TailscaleIPs: ['127.0.0.1'] } });

let dir: string;
let listener: RemoteListener | null = null;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-mobile-page-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>Genie</title><div id="root"></div>');
    await writeFile(join(dir, 'assets', 'index-abc.js'), 'console.log("phone")');
    await writeFile(join(dir, 'secret.txt'), 'not served');
});
afterEach(async () => { await listener?.stop(); listener = null; await rm(dir, { recursive: true, force: true }); });

const portOf = (l: RemoteListener) => Number(/:(\d+)\/genie$/.exec(l.transport.address()!)![1]);

/** A raw GET that sends the path verbatim — `fetch` would normalise `..` away before the server saw it. */
const rawGet = (port: number, path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    httpGet({ host: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
});

describe('the listener serving the mobile page', () => {
    it('GET /mobile and the hashed assets come from the renderer directory with their types; everything else is 404 or 405', async () => {
        listener = remoteListener({ tailscale: async () => running, port: 0, attach: attachWebSocketServer, serve: staticServer(dir) });
        await listener.start();
        const port = portOf(listener);

        const page = await fetch(`http://127.0.0.1:${port}/mobile`);
        expect(page.status).toBe(200);
        expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(page.headers.get('cache-control')).toBe('no-store');
        expect(await page.text()).toContain('<div id="root">');

        const withPin = await fetch(`http://127.0.0.1:${port}/mobile?from=qr`);
        expect(withPin.status).toBe(200);

        const asset = await fetch(`http://127.0.0.1:${port}/assets/index-abc.js`);
        expect(asset.status).toBe(200);
        expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
        expect(asset.headers.get('cache-control')).toContain('immutable');
        expect(asset.headers.get('x-content-type-options')).toBe('nosniff');
        expect(await asset.text()).toBe('console.log("phone")');

        const head = await fetch(`http://127.0.0.1:${port}/mobile`, { method: 'HEAD' });
        expect(head.status).toBe(200);
        expect(await head.text()).toBe('');

        expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
        expect((await fetch(`http://127.0.0.1:${port}/secret.txt`)).status).toBe(404);
        expect((await fetch(`http://127.0.0.1:${port}/assets/missing.js`)).status).toBe(404);
        expect((await fetch(`http://127.0.0.1:${port}/genie`)).status).toBe(404);
        expect((await rawGet(port, '/assets/../secret.txt')).status).toBe(404);
        expect((await rawGet(port, '/assets/..%2fsecret.txt')).status).toBe(404);

        const post = await fetch(`http://127.0.0.1:${port}/mobile`, { method: 'POST', body: 'x' });
        expect(post.status).toBe(405);
        expect(post.headers.get('allow')).toBe('GET, HEAD');
    });

    it('with nothing to serve the port answers 404 to the page too — the socket is all it carries', async () => {
        listener = remoteListener({ tailscale: async () => running, port: 0, attach: attachWebSocketServer });
        await listener.start();
        const port = portOf(listener);
        expect((await fetch(`http://127.0.0.1:${port}/mobile`)).status).toBe(404);
        expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    });
});

describe('staticServer', () => {
    it('reads only what staticFile allows and answers null for a file that is not there', async () => {
        const serve = staticServer(dir);
        const page = await serve('/mobile');
        expect(page?.contentType).toBe('text/html; charset=utf-8');
        expect(Buffer.from(page!.body).toString()).toContain('Genie');
        expect(await serve('/assets/index-abc.js')).toMatchObject({ contentType: 'text/javascript; charset=utf-8' });
        expect(await serve('/assets/index-zzz.js')).toBeNull();
        expect(await serve('/secret.txt')).toBeNull();
        expect(await serve('/assets/../secret.txt')).toBeNull();
    });
});
