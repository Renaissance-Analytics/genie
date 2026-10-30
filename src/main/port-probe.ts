import { request as httpRequest } from 'node:http';
import { connect, createServer } from 'node:net';
import type { ReadinessHandshake } from '../core/engine-reconcile.js';

/**
 * THE NET PORTS behind the port allocator and engine readiness — loopback only, never 0.0.0.0 (a probe on
 * every interface would raise the Windows firewall prompt for a port nobody asked to expose).
 */

/**
 * HAS A SITE ACTUALLY BOUND? (parity audit 2026-10-30, top-15 #9) — Genie 1's readiness wait, ported from
 * `main/dev-server/port-probe.ts` (v0.7.0-beta.342) `waitForHttp` and `waitForHttpsSni`.
 *
 * A process being alive and a site answering are not the same event: `npm run dev` compiles, `artisan serve` boots the
 * framework. So the question is asked in the protocol the site speaks — a real HTTP request, and only a real RESPONSE
 * counts (Genie 1: a TCP connect can be accepted by a forwarder with nothing behind it):
 *
 * - **A dev server** (proxy): ANY status. A framework's 403 for our Host, or a half-migrated app's 500, is still a server
 *   that has bound.
 * - **Behind the site's own Caddy** (static, php): Caddy answers at once, before the PHP worker behind it is up, so its
 *   own 502/503/504 ("the upstream is not answering yet") is NOT ready; any other status is the site.
 *
 * `127.0.0.1` and `::1` are both asked (Genie 1, genie#227): Vite binds `localhost`, which on a dual-stack machine is
 * `::1` alone, and a `127.0.0.1`-only probe would wait forever on a healthy server. Never throws.
 */
export const SITE_READY_TIMEOUT_MS = 15_000;
/** Between attempts (Genie 1: a bound port usually answers at once). */
const SITE_RETRY_MS = 250;
/**
 * The ceiling on ONE attempt (Genie 1's ATTEMPT_CAP_MS): generous, because a slow response IS readiness — `php artisan
 * serve` re-bootstraps per request (~2.5 s warm, ~7 s cold, measured there) — but bounded, so one connection accepted
 * and never answered cannot eat the whole budget unnoticed.
 */
const SITE_ATTEMPT_CAP_MS = 10_000;
const GATEWAY_DOWN = new Set([502, 503, 504]);

function siteRequestOnce(host: string, port: number, behindCaddy: boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
        // A fresh socket every time (`agent: false`): a pooled one could answer for a server that no longer exists.
        const req = httpRequest({ host, port, method: 'GET', path: '/', agent: false, timeout: timeoutMs }, (res) => {
            // Read and discard, so the dev server logs a finished request rather than an aborted one.
            res.resume();
            done(!(behindCaddy && GATEWAY_DOWN.has(res.statusCode ?? 0)));
        });
        req.on('timeout', () => { req.destroy(); done(false); });
        req.on('error', () => done(false));
        req.end();
    });
}

/** Poll the site's loopback port until it answers (see above), or `timeoutMs` passes: true = it answered. */
export async function siteAnswers(port: number, options: { behindCaddy: boolean; timeoutMs?: number }): Promise<boolean> {
    const deadline = Date.now() + (options.timeoutMs ?? SITE_READY_TIMEOUT_MS);
    for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        const attempt = Math.min(remaining, SITE_ATTEMPT_CAP_MS);
        const answers = await Promise.all(['127.0.0.1', '::1'].map((h) => siteRequestOnce(h, port, options.behindCaddy, attempt).catch(() => false)));
        if (answers.some(Boolean)) return true;
        if (Date.now() + SITE_RETRY_MS >= deadline) return false;
        await new Promise((r) => setTimeout(r, SITE_RETRY_MS));
    }
}

/** Whether 127.0.0.1:<port> can be bound right now: bind exclusively, close at once. Any error = not free. */
export function loopbackPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = createServer();
        server.unref();
        server.once('error', () => resolve(false));
        server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)));
    });
}

/**
 * Whether the engine on 127.0.0.1:<port> ANSWERS: connect, send the handshake's opener, and wait for a reply
 * the handshake accepts. With no expectation (mongo), a connection the peer has not closed within the
 * window counts (expected: Docker's proxy closes the connection when nothing listens behind it — NOT yet
 * measured on Docker Desktop or Linux docker-proxy; see the staging report).
 */
export function loopbackAnswers(port: number, handshake: ReadinessHandshake, windowMs = 1_500): Promise<boolean> {
    return new Promise((resolve) => {
        let done = false;
        let connected = false;
        const chunks: Buffer[] = [];
        const socket = connect({ port, host: '127.0.0.1' });
        const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(ok);
        };
        const timer = setTimeout(() => finish(connected && handshake.expect === null), windowMs);
        socket.once('connect', () => {
            connected = true;
            if (handshake.send) socket.write(handshake.send);
        });
        socket.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            if (handshake.expect?.(new Uint8Array(Buffer.concat(chunks)))) finish(true);
        });
        socket.once('end', () => finish(false));
        socket.once('close', () => finish(false));
        socket.once('error', () => finish(false));
    });
}
