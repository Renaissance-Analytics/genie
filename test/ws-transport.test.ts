import { describe, expect, it } from 'vitest';
import { webSocketTransport, type WebSocketLike } from '../src/renderer/ws-transport.js';

/**
 * THE CLIENT TRANSPORT over a WebSocket (§6.8) — the renderer has the browser's own `WebSocket`, so
 * a window can drive a remote host as soon as that host listens. Frames sent before the socket is
 * open are QUEUED and flushed on open (the hello is sent at construction time, before any open
 * event could have fired); a close reaches the listeners once; a socket error that closes the
 * connection is reported as a close, never swallowed. Tested with a fake socket — no network.
 */

class FakeSocket implements WebSocketLike {
    readyState = 0;
    sent: string[] = [];
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    closed = 0;
    send(data: string): void { if (this.readyState !== 1) throw new Error('not open'); this.sent.push(data); }
    close(): void { this.closed += 1; this.readyState = 3; this.onclose?.({}); }
    open(): void { this.readyState = 1; this.onopen?.({}); }
}

describe('webSocketTransport', () => {
    it('queues frames until open, then flushes them in order; delivers text messages; a close reaches listeners once', () => {
        const socket = new FakeSocket();
        const t = webSocketTransport(socket);
        t.send('a');
        t.send('b');
        expect(socket.sent).toEqual([]);
        socket.open();
        expect(socket.sent).toEqual(['a', 'b']);
        t.send('c');
        expect(socket.sent).toEqual(['a', 'b', 'c']);

        const got: string[] = [];
        t.onMessage((text) => got.push(text));
        socket.onmessage?.({ data: 'hello' });
        socket.onmessage?.({ data: new ArrayBuffer(2) });
        expect(got).toEqual(['hello']);

        let closes = 0;
        t.onClose(() => { closes += 1; });
        t.close();
        t.close();
        expect(socket.closed).toBe(1);
        expect(closes).toBe(1);
        // After close, a send is dropped, not thrown.
        expect(() => t.send('late')).not.toThrow();
    });

    it('an error that ends the socket is reported as a close; a URL is turned into a socket by the factory', () => {
        const socket = new FakeSocket();
        const t = webSocketTransport(socket);
        let closes = 0;
        t.onClose(() => { closes += 1; });
        socket.onerror?.({});
        socket.readyState = 3;
        socket.onclose?.({});
        expect(closes).toBe(1);

        const made: string[] = [];
        const t2 = webSocketTransport('wss://alphar.tailnet.invalid:7421/genie', (url) => { made.push(url); return new FakeSocket(); });
        expect(made).toEqual(['wss://alphar.tailnet.invalid:7421/genie']);
        expect(typeof t2.send).toBe('function');
    });
});
