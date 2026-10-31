import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MobileConnecting } from '../src/renderer/components/MobileShell.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { get as httpsGet } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachWebSocketServer } from '@particle-academy/fancy-ws';
import { MOBILE_SW, mobileHtml, mobileManifest, shellPolicy } from '../src/core/mobile-pwa.js';
import { mobilePageUrl, staticFile } from '../src/core/mobile.js';
import { remoteListener, type RemoteListener } from '../src/main/remote-listen.js';
import { staticServer } from '../src/main/static-page.js';
import { issueCa, issueLeaf } from '../src/main/x509.js';

/**
 * THE PHONE AS AN INSTALLABLE APP, ONE PER HOST (the owner, 2026-10-30: "i need the mobile PWA for hosts").
 *
 * - Each host serves its own manifest, named after the host — two workstations installed on one phone are two apps, and
 *   each is its own origin (its MagicDNS name) — standalone, with the Genie logo as icons, a maskable one among them.
 * - The service worker caches the APP SHELL ONLY: the page and its hashed assets and icons. Chat, files and tokens never
 *   pass through it (they ride the socket), and the page is network-first, so a reopened app shows the newest shell when
 *   the host is there and the cached one — which says Reconnecting, never old agent data — when it is not.
 * - The page served at /mobile carries the manifest link, a phone viewport (the shared index.html had none: a phone drew
 *   it at 980 px) and the home-screen tags, and its CSP admits the manifest; the desktop's `/` is untouched.
 * - A service worker needs a secure context, so the listener serves HTTPS on the MagicDNS name with a Tailscale cert —
 *   Genie 1's way (main/mobile/tls.ts at v0.7.0-beta.342) — and, like Genie 1, falls back to http over WireGuard when the
 *   tailnet gives no cert.
 */

describe('the manifest, per host', () => {
    it('is named after the host, standalone, scoped to /mobile, with Genie icons including a maskable one', () => {
        const m = mobileManifest('alphar');
        expect(m.name).toBe('Genie — alphar');
        expect(m.short_name).toBe('alphar');
        expect(m.display).toBe('standalone');
        expect(m.start_url).toBe('/mobile');
        expect(m.scope).toBe('/mobile');
        expect(m.id).toBe('/mobile');
        expect(m.icons.map((i) => `${i.src} ${i.sizes} ${i.purpose}`)).toEqual([
            '/mobile/icon-192.png 192x192 any',
            '/mobile/icon-512.png 512x512 any',
            '/mobile/icon-maskable-512.png 512x512 maskable',
        ]);
        expect(mobileManifest('a-very-long-workstation-name').short_name.length).toBeLessThanOrEqual(12);
    });
});

describe('the page at /mobile', () => {
    const base = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'" /><title>Genie</title></head><body></body></html>';

    it('carries the manifest, a phone viewport, the home-screen tags named after the host, and a CSP that admits the manifest', () => {
        const html = mobileHtml(base, 'alphar');
        expect(html).toContain('<link rel="manifest" href="/mobile/manifest.webmanifest"');
        expect(html).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1[^"]*viewport-fit=cover"/);
        expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes"');
        expect(html).toContain('<meta name="apple-mobile-web-app-title" content="alphar"');
        expect(html).toContain('<link rel="apple-touch-icon" href="/mobile/apple-touch-icon.png"');
        expect(html).toContain("default-src 'none'; manifest-src 'self';");
        expect(html).toContain('<title>Genie — alphar</title>');
    });

    it('escapes the host name', () => {
        const html = mobileHtml(base, 'x"><script>alert(1)</script>');
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&quot;&gt;&lt;script&gt;');
    });
});

describe('reopened from the home screen', () => {
    it('a remembered phone shows Connecting while it dials — never the PIN form', () => {
        const html = renderToStaticMarkup(createElement(MobileConnecting, { host: 'alphar.tail.ts.net' }));
        expect(html).toContain('data-mobile="connecting"');
        expect(html).toContain('alphar.tail.ts.net');
        expect(html).not.toContain('name="pin"');
    });
});

describe('the service worker caches the app shell and nothing else', () => {
    it('the policy: assets and icons cache-first, the page network-first, everything else (the socket, the manifest, the worker) untouched', () => {
        expect(shellPolicy('/assets/index-abc.js')).toBe('cache-first');
        expect(shellPolicy('/mobile/assets/index-abc.js')).toBe('cache-first');
        expect(shellPolicy('/mobile/icon-192.png')).toBe('cache-first');
        expect(shellPolicy('/mobile')).toBe('network-first');
        expect(shellPolicy('/mobile/')).toBe('network-first');
        for (const p of ['/genie', '/mobile/manifest.webmanifest', '/mobile/sw.js', '/', '/nope', '/assets/../genie']) expect(shellPolicy(p), p).toBeNull();
    });

    it('run as a worker: it answers only shell requests, and only GETs on its own origin', () => {
        const listeners = new Map<string, (e: unknown) => void>();
        const self = { addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn), skipWaiting: () => {}, clients: { claim: async () => {} }, location: { origin: 'https://alphar.ts.net:7421' } };
        new Function('self', 'caches', 'fetch', 'location', MOBILE_SW)(self, { open: async () => ({ match: async () => undefined, put: async () => {} }), keys: async () => [], match: async () => undefined, delete: async () => true }, async () => new Response('x'), self.location);
        const answered = (url: string, method = 'GET') => {
            let did = false;
            listeners.get('fetch')!({ request: { url, method }, respondWith: () => { did = true; } });
            return did;
        };
        expect(answered('https://alphar.ts.net:7421/assets/index-abc.js')).toBe(true);
        expect(answered('https://alphar.ts.net:7421/mobile')).toBe(true);
        expect(answered('https://alphar.ts.net:7421/genie')).toBe(false);
        expect(answered('https://alphar.ts.net:7421/mobile/manifest.webmanifest')).toBe(false);
        expect(answered('https://alphar.ts.net:7421/assets/index-abc.js', 'POST')).toBe(false);
        expect(answered('https://evil.example/assets/index-abc.js')).toBe(false);
    });
});

describe('the listener serves the app', () => {
    let dir: string;
    let listener: RemoteListener | null = null;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-mobile-pwa-'));
        await mkdir(join(dir, 'assets'));
        await mkdir(join(dir, 'mobile'));
        await writeFile(join(dir, 'index.html'), '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'" /><title>Genie</title></head><body><div id="root"></div></body></html>');
        await writeFile(join(dir, 'mobile', 'icon-192.png'), 'PNG');
    });
    afterEach(async () => { await listener?.stop(); listener = null; await rm(dir, { recursive: true, force: true }); });

    it('the icons are on the allow-list; nothing else under /mobile/ is', () => {
        expect(staticFile('/mobile/icon-192.png')).toMatchObject({ relative: 'mobile/icon-192.png', contentType: 'image/png' });
        expect(staticFile('/mobile/apple-touch-icon.png')).toMatchObject({ relative: 'mobile/apple-touch-icon.png' });
        expect(staticFile('/mobile/secret.txt')).toBeNull();
        expect(staticFile('/mobile/../index.html')).toBeNull();
    });

    it('/mobile is the injected page, /mobile/manifest.webmanifest is this host’s, /mobile/sw.js may scope /mobile; `/` stays the plain page', async () => {
        const serve = staticServer(dir, { hostName: () => 'alphar' });
        const page = await serve('/mobile');
        expect(Buffer.from(page!.body).toString()).toContain('rel="manifest"');
        const root = await serve('/');
        expect(Buffer.from(root!.body).toString()).not.toContain('rel="manifest"');
        const manifest = await serve('/mobile/manifest.webmanifest');
        expect(manifest!.contentType).toBe('application/manifest+json; charset=utf-8');
        expect(JSON.parse(Buffer.from(manifest!.body).toString()).name).toBe('Genie — alphar');
        const sw = await serve('/mobile/sw.js');
        expect(sw!.contentType).toBe('text/javascript; charset=utf-8');
        expect(sw!.cache).toBe('no-cache');
        expect(sw!.headers?.['Service-Worker-Allowed']).toBe('/mobile');
        expect(await serve('/mobile/icon-192.png')).toMatchObject({ contentType: 'image/png' });
    });

    const ca = issueCa({ commonName: 'Test CA', organization: 'genie tests', notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 86_400_000) });
    const leaf = issueLeaf(ca, ['alphar.tailnet.invalid'], new Date(Date.now() - 60_000), new Date(Date.now() + 86_400_000));
    const running = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'alphar.tailnet.invalid.', TailscaleIPs: ['127.0.0.1'] } });

    it('with a Tailscale cert for the MagicDNS name it serves HTTPS and advertises wss:// — the page a phone opens is https://', async () => {
        const asked: string[] = [];
        listener = remoteListener({ tailscale: async () => running, port: 0, attach: attachWebSocketServer, serve: staticServer(dir, { hostName: () => 'alphar' }), cert: async (dns) => { asked.push(dns); return { cert: leaf.certPem, key: leaf.keyPem }; } });
        await listener.start();
        expect(asked).toEqual(['alphar.tailnet.invalid']);
        const url = listener.transport.address()!;
        expect(url).toMatch(/^wss:\/\/alphar\.tailnet\.invalid:\d+\/genie$/);
        expect(mobilePageUrl(url)).toMatch(/^https:\/\/alphar\.tailnet\.invalid:\d+\/mobile$/);
        const port = Number(/:(\d+)\/genie$/.exec(url)![1]);
        const body = await new Promise<string>((resolve, reject) => {
            httpsGet({ host: '127.0.0.1', port, path: '/mobile/manifest.webmanifest', servername: 'alphar.tailnet.invalid', ca: ca.certPem }, (res) => {
                let b = '';
                res.on('data', (c: Buffer) => { b += c.toString(); });
                res.on('end', () => resolve(b));
            }).on('error', reject);
        });
        expect(JSON.parse(body).display).toBe('standalone');
    });

    it('no cert from the tailnet (HTTPS certs off): http over WireGuard, as Genie 1 fell back — still bound to the tailnet only', async () => {
        listener = remoteListener({ tailscale: async () => running, port: 0, attach: attachWebSocketServer, serve: staticServer(dir, { hostName: () => 'alphar' }), cert: async () => null });
        await listener.start();
        expect(listener.transport.address()).toMatch(/^ws:\/\/alphar\.tailnet\.invalid:\d+\/genie$/);
    });
});
