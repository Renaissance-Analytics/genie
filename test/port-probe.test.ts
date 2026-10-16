import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { readinessHandshake } from '../src/core/engine-reconcile.js';
import { loopbackAnswers, loopbackPortFree } from '../src/main/port-probe.js';

/**
 * THE NET PORTS behind the allocator and engine readiness, over REAL loopback sockets — which is why these
 * run only on the test machines (WSL distro / Windows VM), never on the owner's desktop. Every "no" is
 * paired with a "yes" from the same probe in the same test.
 */

const servers: Server[] = [];
// Every socket a test server accepted. `close()` waits for them, and a silent listener's accepted socket never ends on
// its own, so cleanup destroys them first (the batch measured a 10 s hook timeout without this).
const accepted: import('node:net').Socket[] = [];
afterEach(async () => {
    for (const sock of accepted.splice(0)) sock.destroy();
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function listen(onConnection: (socket: import('node:net').Socket) => void = () => {}): Promise<number> {
    return new Promise((resolve) => {
        const server = createServer((socket) => { accepted.push(socket); onConnection(socket); });
        servers.push(server);
        server.listen({ port: 0, host: '127.0.0.1' }, () => resolve((server.address() as { port: number }).port));
    });
}

describe('loopbackPortFree', () => {
    it('a port something listens on is NOT free; the same port once released IS (positive control)', async () => {
        const port = await listen();
        expect(await loopbackPortFree(port)).toBe(false);
        await new Promise<void>((r) => servers.pop()!.close(() => r()));
        expect(await loopbackPortFree(port)).toBe(true);
    });
});

describe('loopbackAnswers', () => {
    it('postgres: a server that answers the SSLRequest with N is ready', async () => {
        const port = await listen((s) => s.once('data', () => s.write('N')));
        expect(await loopbackAnswers(port, readinessHandshake('postgres'))).toBe(true);
    });

    it('a listener that accepts and closes at once (what a port proxy with nothing behind it does) is NOT ready — with the answering one as control', async () => {
        const closer = await listen((s) => s.destroy());
        expect(await loopbackAnswers(closer, readinessHandshake('postgres'))).toBe(false);
        expect(await loopbackAnswers(closer, readinessHandshake('mongo'))).toBe(false);
        const answering = await listen((s) => s.once('data', () => s.write('+PONG\r\n')));
        expect(await loopbackAnswers(answering, readinessHandshake('redis'))).toBe(true);
    });

    it('a listener that accepts and says nothing is not ready for an engine that must answer, within the window', async () => {
        const silent = await listen();
        expect(await loopbackAnswers(silent, readinessHandshake('postgres'), 200)).toBe(false);
        // mongo has no cheap greeting: a held connection is all it can show.
        expect(await loopbackAnswers(silent, readinessHandshake('mongo'), 200)).toBe(true);
    });

    it('nothing listening: refused, not ready', async () => {
        const port = await listen();
        await new Promise<void>((r) => servers.pop()!.close(() => r()));
        expect(await loopbackAnswers(port, readinessHandshake('redis'), 500)).toBe(false);
    });
});
