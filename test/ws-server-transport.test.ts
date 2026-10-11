import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { fancyWsTransport, type AttachWebSocketServer, type FancyWsSocket } from '../src/main/ws-server-transport.js';

/**
 * THE HOST'S SOCKET TRANSPORT (§6.8) — fancy-ws behind Genie's `ServerTransport` port. The attach
 * function is injected (fancy-ws 0.1.0's `attachWebSocketServer`), so this is tested with a fake that
 * speaks its shape: `connection(socket, req, verified)`, `socket.on('message', (data, isBinary))`,
 * `on('close')`, boolean `send`, `close(code, reason)`, `remoteAddress`. Text frames cross as strings;
 * binary frames are dropped (Genie's wire is text); the advertised address is what a device types.
 */

function fakeSocket(remoteAddress = '100.64.0.7') {
    const em = new EventEmitter();
    const sent: string[] = [];
    let open = true;
    const socket = Object.assign(em, {
        readyState: 1,
        remoteAddress,
        send: (data: string | Uint8Array) => { if (!open) return false; sent.push(String(data)); return true; },
        close: (code?: number, reason?: string) => { open = false; em.emit('close', code ?? 1000, reason ?? ''); },
    }) as unknown as FancyWsSocket & EventEmitter;
    return { socket, sent };
}

describe('fancyWsTransport', () => {
    it('attaches once at the path, hands each connection to the listener as a ServerConnection, relays text frames in and out, and reports close once', () => {
        const attached: Array<{ server: unknown; options: unknown }> = [];
    const emitter = new EventEmitter();
        const attach: AttachWebSocketServer = (server, options) => { attached.push({ server, options }); return emitter as never; };
        const transport = fancyWsTransport({ attach, server: { kind: 'http' } as never, path: '/genie', address: () => 'ws://alphar.tailnet.invalid:7421/genie' });
        expect(attached).toEqual([{ server: { kind: 'http' }, options: expect.objectContaining({ path: '/genie', onPathMismatch: 'ignore' }) }]);
        expect(transport.address?.()).toBe('ws://alphar.tailnet.invalid:7421/genie');

        const connections: Array<{ remoteAddress: string; got: string[]; closes: number }> = [];
        transport.onConnection((c) => {
            const entry = { remoteAddress: c.remoteAddress, got: [] as string[], closes: 0 };
            c.onMessage((t) => entry.got.push(t));
            c.onClose(() => { entry.closes += 1; });
            connections.push(entry);
            c.send('welcome');
        });

        const { socket, sent } = fakeSocket();
        emitter.emit('connection', socket, {}, {});
        expect(connections).toHaveLength(1);
        expect(connections[0]!.remoteAddress).toBe('100.64.0.7');
        expect(sent).toEqual(['welcome']);
        socket.emit('message', '{"kind":"hello"}', false);
        socket.emit('message', Buffer.from([1, 2]), true);
        expect(connections[0]!.got).toEqual(['{"kind":"hello"}']);
        socket.emit('close', 1000, '');
        socket.emit('close', 1000, '');
        expect(connections[0]!.closes).toBe(1);
    });

    it('closing from Genie’s side closes the socket with 1000 and a send after that is dropped', () => {
        const emitter = new EventEmitter();
        const transport = fancyWsTransport({ attach: () => emitter as never, server: {} as never, path: '/genie', address: () => null });
        let conn: { close: () => void; send: (t: string) => void } | null = null;
        transport.onConnection((c) => { conn = c; });
        const { socket, sent } = fakeSocket();
        emitter.emit('connection', socket, {}, {});
        conn!.close();
        conn!.send('late');
        expect(sent).toEqual([]);
        expect(transport.address?.()).toBeNull();
    });
});
