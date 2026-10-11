import type { ClientTransport } from '../core/remote-protocol.js';

/**
 * THE CLIENT TRANSPORT over a WebSocket (§6.8). The renderer has the browser's own `WebSocket`, so a
 * window can drive a remote host as soon as that host listens. Frames sent before the socket opens
 * are queued and flushed on open (the hello goes out at construction, before any open event); a
 * close reaches the listeners exactly once; an error that ends the socket is a close, not silence.
 */

/** The slice of the DOM WebSocket this needs — so a test can hand in a fake. */
export interface WebSocketLike {
    readyState: number;
    onopen: ((ev: unknown) => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onclose: ((ev: unknown) => void) | null;
    onerror: ((ev: unknown) => void) | null;
    send(data: string): void;
    close(): void;
}

const OPEN = 1;

export function webSocketTransport(target: string | WebSocketLike, factory: (url: string) => WebSocketLike = (url) => new WebSocket(url) as unknown as WebSocketLike): ClientTransport {
    const socket = typeof target === 'string' ? factory(target) : target;
    const queue: string[] = [];
    const messages = new Set<(text: string) => void>();
    const closes = new Set<() => void>();
    let closed = false;

    const closeOnce = () => {
        if (closed) return;
        closed = true;
        for (const l of closes) l();
    };

    socket.onopen = () => {
        for (const text of queue.splice(0)) socket.send(text);
    };
    socket.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return; // Genie's wire is text frames only.
        for (const l of messages) l(ev.data);
    };
    socket.onclose = closeOnce;
    socket.onerror = () => {
        // A REFUSED handshake gives Node's client (and so Electron's) `error` with NO `close`, readyState
        // stuck at CONNECTING — measured by fancy on v22.23.2. An errored socket is done either way, so
        // error IS a close here; a later `close` event is absorbed by closeOnce.
        closeOnce();
    };

    return {
        send: (text) => {
            if (closed) return;
            if (socket.readyState === OPEN) socket.send(text);
            else queue.push(text);
        },
        onMessage: (l) => { messages.add(l); return () => { messages.delete(l); }; },
        onClose: (l) => { closes.add(l); return () => { closes.delete(l); }; },
        close: () => {
            if (closed) return;
            socket.close();
            closeOnce();
        },
    };
}
