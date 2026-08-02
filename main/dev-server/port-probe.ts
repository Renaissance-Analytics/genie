import http from 'node:http';
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

/** Ceiling on any single attempt, so one hung connect cannot eat the budget. */
const ATTEMPT_CAP_MS = 2_000;

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
    host = '127.0.0.1',
): Promise<boolean> {
    return poll((attemptMs) => connectOnce(host, port, attemptMs), timeoutMs);
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
    host = '127.0.0.1',
): Promise<boolean> {
    return poll((attemptMs) => requestOnce(host, port, attemptMs, hostHeader), timeoutMs);
}
