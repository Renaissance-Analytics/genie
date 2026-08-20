import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * "Has the dev server actually bound yet?"
 *
 * A container being `running` and a dev server being reachable are not the same
 * event, and the gap between them is seconds — `npm run dev` compiles, `cargo
 * run` builds, `artisan serve` boots the framework. Reporting the first as if it
 * were the second is how an agent says "your site is up at https://web.acme.gen"
 * and the user gets a dead socket.
 *
 * ## Why an HTTP surface is NOT probed with a TCP connect
 *
 * Because on Docker Desktop that probe LIES, and the live P2 smoke caught it
 * doing so. A published port on Windows and macOS is held by Docker's own
 * userland forwarder, which accepts the connection whether or not anything
 * inside the container is listening, and closes it once the forward fails. So a
 * `net.connect` succeeds against a container whose server has not started, and
 * the very next request gets ECONNRESET. On Linux, where publishing is DNAT with
 * no proxy in front, the same probe is honest — which is exactly what makes this
 * the kind of bug that passes CI and fails on every developer's laptop.
 *
 * The fix is to ask the question in the protocol the surface actually speaks:
 *
 *   - **http** → {@link waitForHttp}. A real request; only a real RESPONSE
 *     counts. Any status counts — a 403 from a framework rejecting our `Host`,
 *     or a 500 from a half-migrated app, is still a server that has bound.
 *   - **tcp** → {@link waitForPort}. A connect is all there is for an arbitrary
 *     protocol, and its Docker-Desktop caveat is inherent rather than fixable.
 */

/** How long `start` waits for the port before reporting `ready: false`. */
export const DEFAULT_READY_TIMEOUT_MS = 15_000;

/** Gap between attempts. Short — a bound port usually answers immediately. */
const RETRY_MS = 250;

/**
 * Ceiling on any single attempt, so one genuinely hung connect cannot eat the
 * whole budget — but generous, because for an HTTP surface a SLOW response is
 * readiness, not a hang. A single-threaded dev server that re-bootstraps per
 * request answers in seconds every time (`php artisan serve`: measured ~2.5s
 * warm, ~7s on the cold first hit); capping an attempt below that destroys the
 * request before the honest response lands, and a serving site reads not-ready
 * forever. This cap must clear real per-request latency; it still bounds a true
 * black hole (a connection accepted but never answered) within the total budget.
 */
const ATTEMPT_CAP_MS = 10_000;

/** Run `attempt` until it is true or the budget runs out. Never throws. */
async function poll(
    attempt: (timeoutMs: number) => Promise<boolean>,
    timeoutMs: number,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        if (await attempt(Math.min(remaining, ATTEMPT_CAP_MS))) return true;
        if (Date.now() + RETRY_MS >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
}


/**
 * The loopback addresses a "loopback" probe should actually try.
 *
 * Vite binds `localhost` by default, which on a dual-stack machine is `::1` — so a
 * dev server can be perfectly healthy, answering `curl localhost:5173` with a 200,
 * while a `127.0.0.1` probe gets nothing and the site reads as "still starting"
 * forever (genie#227). Only the DEFAULT is ambiguous: a caller that named a host
 * meant that host, and gets exactly it.
 */
const LOOPBACKS = ['127.0.0.1', '::1'] as const;

/** Race an attempt across both loopbacks; true if EITHER answered. */
async function eitherLoopback(
    host: string,
    attempt: (host: string) => Promise<boolean>,
): Promise<boolean> {
    if (host !== DEFAULT_LOOPBACK) return attempt(host);
    const results = await Promise.all(LOOPBACKS.map((h) => attempt(h).catch(() => false)));
    return results.some(Boolean);
}

/** What every loopback probe means by "loopback" unless told otherwise. */
const DEFAULT_LOOPBACK = '127.0.0.1';

/** One connect attempt. Resolves true iff something accepted. */
function connectOnce(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        let settled = false;
        const done = (result: boolean) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

/**
 * Poll a loopback port until something ACCEPTS a TCP connection.
 *
 * For non-HTTP surfaces, where there is no protocol to speak. Read the file
 * header before using it for an HTTP one.
 */
export async function waitForPort(
    port: number,
    timeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
    host: string = DEFAULT_LOOPBACK,
): Promise<boolean> {
    return poll(
        (attemptMs) => eitherLoopback(host, (h) => connectOnce(h, port, attemptMs)),
        timeoutMs,
    );
}

/**
 * Allocate a guaranteed-free loopback TCP port, never one in `exclude`.
 *
 * The host hands each site its OWN port so `<name>.gen` can route to it, and — by
 * passing the ports its live sites already hold in `exclude` — two Genie sites can
 * never share one. The collision that had `moic.gen` serving another workspace's
 * app (two sites, same default port) becomes IMPOSSIBLE rather than merely
 * unlikely. Binds `:0` so the OS picks a free ephemeral port, reads it, and
 * releases it; the caller binds it moments later and the readiness probe is the
 * backstop for the tiny release→bind window (same port-race stance as the rest of
 * this file).
 */
export async function allocateFreePort(exclude: Set<number> = new Set()): Promise<number> {
    // Bounded retry so a pathological `exclude` can never spin forever.
    for (let attempt = 0; attempt < 1000; attempt++) {
        const port = await new Promise<number>((resolve, reject) => {
            const server = net.createServer();
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                const addr = server.address();
                const p = addr && typeof addr === 'object' ? addr.port : 0;
                server.close(() => resolve(p));
            });
        });
        if (port > 0 && !exclude.has(port)) return port;
    }
    throw new Error('could not allocate a free port after 1000 attempts');
}

/** One HTTP attempt. True only when a response actually arrives. */
function requestOnce(
    host: string,
    port: number,
    timeoutMs: number,
    hostHeader?: string,
): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const done = (result: boolean) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        const req = http.request(
            {
                host,
                port,
                method: 'GET',
                path: '/',
                // A fresh socket every time: the readiness question is about the
                // server, and a pooled connection could answer it with a socket
                // opened before the server existed.
                agent: false,
                timeout: timeoutMs,
                ...(hostHeader ? { headers: { host: hostHeader } } : {}),
            },
            (res) => {
                // ANY status means a server answered. Read and discard so the
                // socket closes cleanly and the dev server sees a finished
                // request rather than an aborted one in its log.
                res.resume();
                done(true);
            },
        );
        req.on('timeout', () => {
            req.destroy();
            done(false);
        });
        // ECONNREFUSED (nothing there) and ECONNRESET (Docker Desktop's
        // forwarder accepting and then hanging up) both land here — which is the
        // entire point of asking in HTTP rather than in TCP.
        req.on('error', () => done(false));
        req.end();
    });
}

/**
 * Poll a loopback port until an HTTP server RESPONDS.
 *
 * `hostHeader` is sent so the request looks like the ones the site will really
 * get — and so a framework's host allowlist logs one recognisable line rather
 * than a stream of odd ones.
 */
export async function waitForHttp(
    port: number,
    timeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
    hostHeader?: string,
    host: string = DEFAULT_LOOPBACK,
): Promise<boolean> {
    return poll(
        (attemptMs) => eitherLoopback(host, (h) => requestOnce(h, port, attemptMs, hostHeader)),
        timeoutMs,
    );
}

/** Caddy's own "the upstream app is not answering yet" statuses. A response
 *  carrying one of these means Caddy is up but the site behind it has NOT bound,
 *  so it is the one case where "a server answered" must NOT count as ready. */
const GATEWAY_DOWN = new Set([502, 503, 504]);

/** One HTTPS attempt with a chosen SNI. True only when the vhost behind Caddy
 *  answered with a real (non-gateway) status. */
function requestOnceHttps(
    host: string,
    port: number,
    servername: string,
    timeoutMs: number,
    hostHeader?: string,
): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const done = (result: boolean) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        const req = https.request(
            {
                host,
                port,
                method: 'GET',
                path: '/',
                agent: false,
                timeout: timeoutMs,
                // Route to the right `.gen` vhost, and terminate Caddy's internal
                // leaf as a client — loopback has no MITM surface, so validation
                // off is fine (the browser-facing cert is the Genie CA elsewhere).
                servername,
                // codeql[js/disabling-certificate-validation]
                rejectUnauthorized: false,
                headers: { host: hostHeader ?? servername },
            },
            (res) => {
                res.resume();
                // A 502/503/504 is Caddy saying the app has not bound yet — keep
                // polling. Any other status is the app itself, i.e. ready.
                done(!GATEWAY_DOWN.has(res.statusCode ?? 0));
            },
        );
        req.on('timeout', () => {
            req.destroy();
            done(false);
        });
        req.on('error', () => done(false));
        req.end();
    });
}

/**
 * Poll the sandbox's published Caddy port until the `.gen` vhost behind it
 * RESPONDS — the exact path the Testing Browser will take (loopback → Caddy →
 * app), routed by TLS SNI.
 *
 * This replaces a direct dial of the app's port, which is now a private loopback
 * detail INSIDE the sandbox and unreachable from the host. Because it goes
 * through Caddy, a Caddy `502` (app still booting) is treated as not-ready rather
 * than as "a server answered".
 */
export async function waitForHttpsSni(
    port: number,
    servername: string,
    timeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
    hostHeader?: string,
    host = '127.0.0.1',
): Promise<boolean> {
    return poll((attemptMs) => requestOnceHttps(host, port, servername, attemptMs, hostHeader), timeoutMs);
}
