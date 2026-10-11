import type { Server } from 'node:http';
import type { ServerConnection, ServerTransport } from '../core/remote-protocol.js';

/**
 * THE HOST'S SOCKET TRANSPORT (§6.8) — fancy-ws (`@particle-academy/fancy-ws`) behind Genie's
 * `ServerTransport` port. The attach function is INJECTED so the module is a table under test and the
 * package can land on npm after the owner's first publish without this file changing; main.ts passes
 * fancy-ws's `attachWebSocketServer`. Text frames cross as strings; binary frames are dropped (the wire
 * is JSON text); `onPathMismatch: 'ignore'` leaves other upgrades (the front door's passthrough) alone.
 */

/** The slice of fancy-ws's socket this needs. */
export interface FancyWsSocket {
    readonly readyState: number;
    readonly remoteAddress: string;
    send(data: string | Uint8Array): boolean;
    close(code?: number, reason?: string): void;
    on(event: 'message', listener: (data: string | Buffer, isBinary: boolean) => void): unknown;
    on(event: 'close', listener: (code: number, reason: string) => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface FancyWsServer {
    on(event: 'connection', listener: (socket: FancyWsSocket, request: unknown, verified: unknown) => void): unknown;
}

export type AttachWebSocketServer = (server: Server, options: { path?: string; onPathMismatch?: 'ignore' | 'reject'; maxPayload?: number }) => FancyWsServer;

export function fancyWsTransport(input: { attach: AttachWebSocketServer; server: Server; path: string; address: () => string | null }): ServerTransport {
    const ws = input.attach(input.server, { path: input.path, onPathMismatch: 'ignore' });
    const listeners = new Set<(connection: ServerConnection) => void>();

    ws.on('connection', (socket) => {
        const messages = new Set<(text: string) => void>();
        const closes = new Set<() => void>();
        let closed = false;
        const closeOnce = () => {
            if (closed) return;
            closed = true;
            for (const l of closes) l();
        };
        socket.on('message', (data, isBinary) => {
            if (isBinary || typeof data !== 'string') return;
            for (const l of messages) l(data);
        });
        socket.on('close', closeOnce);
        socket.on('error', () => { /* a close follows; the error itself carries nothing Genie acts on */ });
        const connection: ServerConnection = {
            remoteAddress: socket.remoteAddress,
            send: (text) => { if (!closed) socket.send(text); },
            onMessage: (l) => { messages.add(l); return () => { messages.delete(l); }; },
            onClose: (l) => { closes.add(l); return () => { closes.delete(l); }; },
            close: () => { if (closed) return; socket.close(1000, 'bye'); closeOnce(); },
        };
        for (const l of listeners) l(connection);
    });

    return {
        onConnection: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
        address: input.address,
    };
}
