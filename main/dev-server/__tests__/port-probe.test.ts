import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForHttp, waitForPort } from '../port-probe';

/**
 * READINESS — and the Docker Desktop trap that makes the obvious probe lie.
 *
 * A TCP connect looks like the right way to ask "has the dev server bound its
 * port?". On Linux it is. On Docker Desktop (Windows and macOS) it is NOT: the
 * published port is held open by Docker's own userland forwarder, which ACCEPTS
 * the connection whether or not anything inside the container is listening, and
 * then closes it when the forward fails.
 *
 * That was found by the live smoke, which reported `ready: true` for a container
 * whose python server had not finished starting — and then hung up on the very
 * next request. It is precisely the failure the `ready` field exists to prevent:
 * an agent telling a user "your site is live at https://web.acme.gen" and the
 * user getting a dead socket.
 *
 * So an HTTP surface is probed with a real HTTP request, and only a real
 * RESPONSE counts. The accept-then-close forwarder is modelled directly below,
 * because it is the case that broke.
 */

const servers: net.Server[] = [];

afterEach(() => {
    for (const server of servers.splice(0)) server.close();
});

/** Listen on an ephemeral port with the given connection behaviour. */
function listen(onConnection: (socket: net.Socket) => void): Promise<number> {
    const server = net.createServer(onConnection);
    servers.push(server);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve((server.address() as net.AddressInfo).port);
        });
    });
}

/** An unused loopback port. Bind one, read it, release it. */
async function closedPort(): Promise<number> {
    const port = await listen(() => {});
    servers.pop()?.close();
    return port;
}

describe('waitForPort — the TCP probe', () => {
    it('is true when something accepts', async () => {
        const port = await listen((socket) => socket.destroy());
        expect(await waitForPort(port, 2_000)).toBe(true);
    });

    it('is false, not a throw, when nothing is listening', async () => {
        expect(await waitForPort(await closedPort(), 300)).toBe(false);
    });
});

describe('waitForHttp — what an HTTP surface actually needs', () => {
    it('is true when the server answers with a status line', async () => {
        const port = await listen((socket) => {
            socket.on('data', () => {
                socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi');
            });
        });
        expect(await waitForHttp(port, 2_000)).toBe(true);
    });

    it('counts an ERROR status as ready — the server is up, that is the question', async () => {
        // A framework rejecting our Host, or a 500 from a half-migrated app, is
        // still a dev server that has bound its port.
        const port = await listen((socket) => {
            socket.on('data', () => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
        });
        expect(await waitForHttp(port, 2_000)).toBe(true);
    });

    it('is FALSE for a socket that accepts and then hangs up', async () => {
        // THE DOCKER DESKTOP CASE. The TCP probe says yes here; that is the lie.
        const port = await listen((socket) => socket.destroy());
        expect(await waitForPort(port, 500)).toBe(true);
        expect(await waitForHttp(port, 1_000)).toBe(false);
    });

    it('is false when nothing is listening at all', async () => {
        expect(await waitForHttp(await closedPort(), 300)).toBe(false);
    });

    it('keeps trying until the server comes up inside the budget', async () => {
        // The whole point: a dev server that takes a second to bind is READY,
        // and one that never does is not — both within one bounded call.
        let answering = false;
        const port = await listen((socket) => {
            if (!answering) {
                socket.destroy();
                return;
            }
            socket.on('data', () => socket.end('HTTP/1.1 200 OK\r\n\r\n'));
        });
        setTimeout(() => {
            answering = true;
        }, 400);
        expect(await waitForHttp(port, 5_000)).toBe(true);
    });
});
