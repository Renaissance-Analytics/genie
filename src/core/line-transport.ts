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

/**
 * A LINE COSTS ITS OWN SIZE (Tynn #662). The reader keeps a line's BYTES, read by read, and searches only each new read
 * for the newline; a line is joined and decoded once, when its newline comes. It used to be `buffer += chunk;
 * buffer.indexOf('\n')`: V8 flattens the joined string to search it, so every read copied everything still waiting. A
 * frame of L characters read c at a time cost about L^2 / 2c characters copied — for the owner's 24 MB stores dump in 64 KB
 * pipe reads, about 4.6 G characters, each copy a large-object string only a full GC frees: window main at 1.5-3.6 GB, a
 * hang, and windows that vanished. Bytes, not text, because a read can end inside a character; decoding the joined line
 * once is also what makes that safe (no `setEncoding`).
 */
export function lineTransport(stream: StreamLike): LineTransport {
    const messageListeners = new Set<(text: string) => void>();
    const closeListeners = new Set<() => void>();
    /** The current line's bytes so far (before its newline), read by read, and how many. */
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let limit = UNTRUSTED_LINE_LIMIT;
    let closed = false;
    const fireClose = (): void => {
        if (closed) return;
        closed = true;
        for (const listener of [...closeListeners]) listener();
    };
    stream.on('data', (chunk) => {
        if (closed) return;
        const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        let from = 0;
        for (let newline = data.indexOf(0x0a); newline >= 0; newline = data.indexOf(0x0a, from)) {
            let line: string;
            if (pending.length === 0) line = data.toString('utf8', from, newline);
            else {
                pending.push(data.subarray(from, newline));
                line = Buffer.concat(pending, pendingBytes + (newline - from)).toString('utf8');
                pending = [];
                pendingBytes = 0;
            }
            from = newline + 1;
            if (line.length > 0) for (const listener of [...messageListeners]) listener(line);
            if (closed) return;
        }
        if (from < data.length) {
            pending.push(from === 0 ? data : data.subarray(from));
            pendingBytes += data.length - from;
        }
        if (pendingBytes > limit) {
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
    // A close arrives AFTER what was sent before it, as on a socket (end() flushes first): it is queued behind them.
    let closing = false;
    const closeBoth = (): void => {
        if (closing) return;
        closing = true;
        queueMicrotask(() => {
            for (const side of [a, b]) {
                if (side.closed) continue;
                side.closed = true;
                for (const l of [...side.close]) l();
            }
        });
    };
    const end = (self: Side, peer: Side): ClientTransport => ({
        // Delivered asynchronously, in order, as a socket would.
        send: (text) => { if (!self.closed && !closing) queueMicrotask(() => { if (!peer.closed) for (const l of [...peer.message]) l(text); }); },
        onMessage: (l) => { self.message.add(l); return () => self.message.delete(l); },
        onClose: (l) => { self.close.add(l); return () => self.close.delete(l); },
        close: closeBoth,
    });
    return [end(a, b), end(b, a)];
}
