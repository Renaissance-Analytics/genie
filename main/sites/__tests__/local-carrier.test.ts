import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { createLocalSiteCarrier, pickDialTarget, type LocalTarget } from '../local-carrier';
import type { SiteForwardResult } from '../../remote/site-carrier';

/**
 * The LOCAL carrier's Vite-aware routing (Part 2). `pickDialTarget` is unit-tested
 * pure; the carrier is then driven against two real loopback upstreams — a stand-in
 * "Laravel" server and a stand-in "Vite dev" server — to prove a Vite-owned path
 * dials the Vite port (over http) while everything else stays on the Laravel target.
 */

describe('pickDialTarget', () => {
    const base: LocalTarget = { scheme: 'https', hostname: 'biz.test', port: 8443 };

    it('routes a Vite-owned path to the vitePort over http', () => {
        const t: LocalTarget = { ...base, vitePort: 5173 };
        expect(pickDialTarget(t, '/@vite/client')).toEqual({
            scheme: 'http',
            dialHost: 'localhost',
            host: 'localhost:5173',
            port: 5173,
        });
        expect(pickDialTarget(t, '/resources/js/app.tsx')).toEqual({
            scheme: 'http',
            dialHost: 'localhost',
            host: 'localhost:5173',
            port: 5173,
        });
    });

    it('keeps a non-Vite path on the Laravel target', () => {
        const t: LocalTarget = { ...base, vitePort: 5173 };
        expect(pickDialTarget(t, '/dashboard')).toEqual({
            scheme: 'https',
            dialHost: '127.0.0.1',
            host: 'biz.test',
            port: 8443,
        });
        expect(pickDialTarget(t, '/build/assets/app.css')).toEqual({
            scheme: 'https',
            dialHost: '127.0.0.1',
            host: 'biz.test',
            port: 8443,
        });
    });

    it('without a vitePort, every path stays on the Laravel target', () => {
        expect(pickDialTarget(base, '/@vite/client')).toEqual({
            scheme: 'https',
            dialHost: '127.0.0.1',
            host: 'biz.test',
            port: 8443,
        });
    });
});

// --- integration: route through the carrier to two fake upstreams -----------

const SITE_ID = 'site0000';

let laravel: http.Server;
let vite: http.Server;
let laravelPort = 0;
let vitePort = 0;
let laravelHits: { path: string; host?: string }[] = [];
let viteHits: { path: string; host?: string }[] = [];

function listen(s: http.Server): Promise<number> {
    return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));
}

beforeEach(async () => {
    laravelHits = [];
    viteHits = [];
    laravel = http.createServer((req, res) => {
        laravelHits.push({ path: req.url ?? '', host: req.headers.host });
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('laravel');
    });
    vite = http.createServer((req, res) => {
        viteHits.push({ path: req.url ?? '', host: req.headers.host });
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end('vite');
    });
    laravelPort = await listen(laravel);
    vitePort = await listen(vite);
});

afterEach(() => {
    laravel?.close();
    vite?.close();
});

function carrierFor(target: LocalTarget) {
    return createLocalSiteCarrier((id) => (id === SITE_ID ? target : null));
}

function forward(carrier: ReturnType<typeof carrierFor>, path: string): Promise<SiteForwardResult> {
    const body = new PassThrough();
    body.end();
    const call = carrier.forward({ method: 'GET', path, headers: {}, body });
    return call.response;
}

async function drain(body: NodeJS.ReadableStream): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
}

describe('createLocalSiteCarrier — Vite routing', () => {
    it('sends a Vite-owned path to the Vite dev port (Host = loopback:port)', async () => {
        const carrier = carrierFor({ scheme: 'http', hostname: 'biz.test', port: laravelPort, vitePort });
        const res = await forward(carrier, `/api/site/${SITE_ID}/@vite/client`);
        expect(res.status).toBe(200);
        expect(await drain(res.body)).toBe('vite');
        expect(viteHits).toHaveLength(1);
        expect(viteHits[0].path).toBe('/@vite/client');
        expect(viteHits[0].host).toBe(`localhost:${vitePort}`);
        expect(laravelHits).toHaveLength(0);
    });

    it('sends the page + non-Vite assets to the Laravel port (Host = vhost)', async () => {
        const carrier = carrierFor({ scheme: 'http', hostname: 'biz.test', port: laravelPort, vitePort });
        const page = await forward(carrier, `/api/site/${SITE_ID}/dashboard`);
        expect(await drain(page.body)).toBe('laravel');
        const built = await forward(carrier, `/api/site/${SITE_ID}/build/assets/app.css`);
        expect(await drain(built.body)).toBe('laravel');
        expect(laravelHits.map((h) => h.path)).toEqual(['/dashboard', '/build/assets/app.css']);
        expect(laravelHits[0].host).toBe('biz.test');
        expect(viteHits).toHaveLength(0);
    });

    it('with no vitePort, a Vite-looking path still goes to Laravel', async () => {
        const carrier = carrierFor({ scheme: 'http', hostname: 'biz.test', port: laravelPort });
        const res = await forward(carrier, `/api/site/${SITE_ID}/@vite/client`);
        expect(await drain(res.body)).toBe('laravel');
        expect(laravelHits).toHaveLength(1);
        expect(viteHits).toHaveLength(0);
    });
});
