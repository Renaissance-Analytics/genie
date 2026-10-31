import type { ClientTransport } from './remote-protocol.js';

/**
 * THE LOCAL TRANSPORT (the host split): the remote bridge's text frames over a byte stream — a named pipe on Windows, a
 * unix socket elsewhere — one frame per line. A frame is JSON, and JSON.stringify never emits a raw newline, so a newline
 * is an unambiguous boundary. Implements the same `ClientTransport` the remote socket does, so both ends of the protocol
 * take it unchanged.
 *
 * The stream is a port (`StreamLike`) so the framing is tested without a socket.
 */
export interface StreamLike {
    write(text: string): unknown;
    on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
    on(event: 'close', listener: () => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
    end(): unknown;
    destroy(): unknown;
    setEncoding?(encoding: 'utf8'): unknown;
}

/**
 * Lines longer than this before a peer has authenticated are refused (the connection closes): an unauthenticated peer
 * cannot make the host buffer without bound. After `welcome` the limit is lifted by `trusted()` — a first full ledger can
 * be megabytes.
 */
export const UNTRUSTED_LINE_LIMIT = 64 * 1024;

export interface LineTransport extends ClientTransport {
    /** The peer authenticated: lift the pre-auth line limit. */
    trusted(): void;
}

export function lineTransport(stream: StreamLike): LineTransport {
    const messageListeners = new Set<(text: string) => void>();
    const closeListeners = new Set<() => void>();
    let buffer = '';
    let limit = UNTRUSTED_LINE_LIMIT;
    let closed = false;
    const fireClose = (): void => {
        if (closed) return;
        closed = true;
        for (const listener of [...closeListeners]) listener();
    };
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk) => {
        if (closed) return;
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.length > 0) for (const listener of [...messageListeners]) listener(line);
            if (closed) return;
            newline = buffer.indexOf('\n');
        }
        if (buffer.length > limit) {
            fireClose();
            stream.destroy();
        }
    });
    stream.on('close', fireClose);
    // An error is followed by `close` on a net.Socket; listening keeps it from being thrown as unhandled.
    stream.on('error', () => fireClose());
    return {
        send: (text) => {
            if (!closed) stream.write(`${text}\n`);
        },
        onMessage: (listener) => {
            messageListeners.add(listener);
            return () => messageListeners.delete(listener);
        },
        onClose: (listener) => {
            closeListeners.add(listener);
            return () => closeListeners.delete(listener);
        },
        close: () => {
            stream.end();
            fireClose();
        },
        trusted: () => {
            limit = Number.POSITIVE_INFINITY;
        },
    };
}

/** Two transports joined in memory: what the contract tests drive both ends of the protocol through. */
export function memoryPair(): [ClientTransport, ClientTransport] {
    type Side = { message: Set<(t: string) => void>; close: Set<() => void>; closed: boolean };
    const a: Side = { message: new Set(), close: new Set(), closed: false };
    const b: Side = { message: new Set(), close: new Set(), closed: false };
    const closeBoth = (): void => {
        for (const side of [a, b]) {
            if (side.closed) continue;
            side.closed = true;
            for (const l of [...side.close]) l();
        }
    };
    const end = (self: Side, peer: Side): ClientTransport => ({
        // Delivered asynchronously, in order, as a socket would.
        send: (text) => { if (!self.closed) queueMicrotask(() => { if (!peer.closed) for (const l of [...peer.message]) l(text); }); },
        onMessage: (l) => { self.message.add(l); return () => self.message.delete(l); },
        onClose: (l) => { self.close.add(l); return () => self.close.delete(l); },
        close: closeBoth,
    });
    return [end(a, b), end(b, a)];
}
