import { connect, createServer } from 'node:net';
import type { ReadinessHandshake } from '../core/engine-reconcile.js';

/**
 * THE NET PORTS behind the port allocator and engine readiness — loopback only, never 0.0.0.0 (a probe on
 * every interface would raise the Windows firewall prompt for a port nobody asked to expose).
 */

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
