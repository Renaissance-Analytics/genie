import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import {
    carrierHttpAgent,
    carrierHttpsAgent,
    createLocalSiteCarrier,
    type LocalTarget,
} from '../local-carrier';

/**
 * Keep-alive socket reuse across the site carrier.
 *
 * THE BUG (genie#20 / #25): the carriers dialled with the bare `http` / `https`
 * module, so every forward rode `http.globalAgent` — `keepAlive: true` with a
 * 5000 ms idle timeout that is EXACTLY Node's default `server.keepAliveTimeout`.
 * When an upstream closes an idle connection at the same moment the agent hands
 * that socket to a new request, the request dies with ECONNRESET. There was no
 * retry, so the carrier turned a routine pooling artifact into a hard 502.
 *
 * User-visible as: a `.gen` dev site left idle intermittently serving
 * "Failed to fetch dynamically imported module" for a chunk, or dropping an HMR
 * socket, in the Testing Browser. It surfaced first as two "flaky" tests
 * (site-shim under load, tunnel.spec on the slowest CI runner) — but the
 * flakiness was the product bug, not the tests.
 *
 * These drive a REAL upstream whose keep-alive window is tiny, so the stale
 * socket is a certainty rather than a race, and assert the carrier still serves
 * the request.
 */

const servers: http.Server[] = [];

afterEach(async () => {
    await Promise.all(
        servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
});

/** An upstream that hangs up idle keep-alive sockets almost immediately. */
async function upstream(keepAliveTimeoutMs: number): Promise<{ port: number; hits: () => number }> {
    let hits = 0;
    const server = http.createServer((req, res) => {
        hits += 1;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
    });
    server.keepAliveTimeout = keepAliveTimeoutMs;
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    return { port, hits: () => hits };
}

function carrierFor(port: number) {
    const target: LocalTarget = {
        scheme: 'http',
        hostname: 'demo.gen',
        port,
        loopback: '127.0.0.1',
    };
    return createLocalSiteCarrier(() => target);
}

/** One GET through the carrier; resolves the upstream status. */
async function get(carrier: ReturnType<typeof carrierFor>, path = '/api/site/s1/chunk.js') {
    const { Readable } = await import('node:stream');
    const call = carrier.forward({
        method: 'GET',
        path,
        headers: { host: 'demo.gen' },
        body: Readable.from([]),
    } as never);
    const res = (await call.response) as { status: number; body: NodeJS.ReadableStream };
    // Drain so the socket returns to the pool, exactly as the proxy does.
    await new Promise<void>((r) => {
        res.body.on('data', () => {});
        res.body.on('end', () => r());
        res.body.on('error', () => r());
    });
    return res.status;
}

/**
 * HONESTY NOTE on the two behavioural tests below: they do NOT reproduce the
 * race. It needs the upstream's FIN to still be unread at the instant the agent
 * hands the socket over, and that could not be forced deterministically — which
 * is exactly why the bug presented as intermittent. They are kept as cheap
 * regression guards, not as proof.
 *
 * The assertions that actually PROVE the fix are these invariants: the carriers
 * own their pools, and expire idle sockets strictly before the upstream does. A
 * client window below the server's makes offering a server-closed socket
 * impossible, which removes the race rather than narrowing it.
 */
describe('carrier agents — the invariant that removes the race', () => {
    /** Node's default for BOTH http.globalAgent.timeout and server.keepAliveTimeout. */
    const NODE_DEFAULT_IDLE_MS = 5_000;

    it('does not use the global agent pool', () => {
        // Sharing globalAgent also let unrelated traffic poison these dials.
        expect(carrierHttpAgent).not.toBe(http.globalAgent);
        expect(carrierHttpsAgent).not.toBe(http.globalAgent);
    });

    it('expires idle sockets strictly before a default upstream would', () => {
        for (const agent of [carrierHttpAgent, carrierHttpsAgent]) {
            expect(agent.options.keepAlive).toBe(true);
            const timeout = agent.options.timeout;
            expect(timeout).toBeTypeOf('number');
            // STRICTLY less — equal is the bug. Node ships 5000 on both sides,
            // so the client and server can expire the same socket simultaneously.
            expect(timeout as number).toBeLessThan(NODE_DEFAULT_IDLE_MS);
        }
    });
});

describe('local site carrier — idle keep-alive sockets', () => {
    it('serves a request after the upstream hung up an idle pooled socket', async () => {
        // 40ms keep-alive so the upstream hangs up quickly.
        const { port } = await upstream(40);
        const carrier = carrierFor(port);

        expect(await get(carrier)).toBe(200);

        // BLOCK the event loop past the keep-alive window instead of awaiting a
        // timer. This is the crux: an `await setTimeout` lets Node read the
        // server's FIN and evict the socket, so the bug does NOT reproduce. A
        // busy-wait leaves the FIN unread, so the agent still believes the dead
        // socket is reusable — which is precisely the production race, where the
        // server's 5s keepAliveTimeout fires while a request is being handed the
        // same socket.
        const until = Date.now() + 150;
        while (Date.now() < until) {
            /* deliberately synchronous — see above */
        }

        // Before the fix this reused the dead socket, the dial errored with
        // ECONNRESET, and the proxy turned it into a 502 — the "Failed to fetch
        // dynamically imported module" the user actually sees.
        expect(await get(carrier)).toBe(200);
    });

    it('survives several idle gaps in a row', async () => {
        // A dev site is idle far more often than it is busy; one recovery is not
        // enough if the next gap poisons the pool again.
        const { port } = await upstream(40);
        const carrier = carrierFor(port);

        for (let i = 0; i < 3; i++) {
            expect(await get(carrier)).toBe(200);
            await new Promise((r) => setTimeout(r, 120));
        }
        expect(await get(carrier)).toBe(200);
    });
});
