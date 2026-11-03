/**
 * A LOCAL REVERB WITH PRODUCTION'S ORIGIN RULE (genie#1478). Test VMs reach tynn.gen, whose WebSocket service allows every
 * Origin (core/websockets.ts `allowed_origins = ["*"]`), so nothing there could catch a socket production refuses. This
 * does what production was measured doing:
 *
 *  - an Origin it allows: `pusher:connection_established`, then a signed subscribe is answered;
 *  - no Origin, or any other: `pusher:error` 4009 `Origin not allowed`, and then NOTHING. The socket stays open and silent;
 *    it does not even answer a close (production closes it about 300 s later, which no test wants to wait for).
 *
 * The WebSocket is written by hand on purpose, so this runs with no dependency under plain Node and under Electron's own
 * binary, and what it records (`connections[n].origin`) is the header as it arrived on the wire.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function textFrame(text) {
    const payload = Buffer.from(text, 'utf8');
    const head = payload.length < 126 ? Buffer.from([0x81, payload.length])
        : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
    return Buffer.concat([head, payload]);
}

/** Reads the client's (masked) frames from `buffer`: what it holds whole, and what is left over. */
function readFrames(buffer) {
    const frames = [];
    let at = 0;
    while (buffer.length - at >= 2) {
        const opcode = buffer[at] & 0x0f;
        let length = buffer[at + 1] & 0x7f;
        let header = 2;
        if (length === 126) {
            if (buffer.length - at < 4) break;
            length = buffer.readUInt16BE(at + 2);
            header = 4;
        } else if (length === 127) {
            if (buffer.length - at < 10) break;
            length = Number(buffer.readBigUInt64BE(at + 2));
            header = 10;
        }
        if (buffer.length - at < header + 4 + length) break;
        const mask = buffer.subarray(at + header, at + header + 4);
        const payload = Buffer.from(buffer.subarray(at + header + 4, at + header + 4 + length));
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
        frames.push({ opcode, text: payload.toString('utf8') });
        at += header + 4 + length;
    }
    return { frames, rest: buffer.subarray(at) };
}

export const ORIGIN_NOT_ALLOWED = JSON.stringify({ event: 'pusher:error', data: JSON.stringify({ code: 4009, message: 'Origin not allowed' }) });

export async function startFakeReverb({ allowedOrigins }) {
    const connections = [];
    const open = new Set();
    let nextId = 1;
    const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    server.on('upgrade', (req, socket) => {
        open.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => { open.delete(socket); });
        const origin = req.headers.origin ?? null;
        const allowed = origin !== null && allowedOrigins.includes(origin);
        const connection = { origin, allowed, path: req.url ?? '', closeAsked: false, received: [] };
        connections.push(connection);
        const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}${WS_GUID}`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        socket.write(textFrame(allowed
            ? JSON.stringify({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: `${nextId++}.1`, activity_timeout: 30 }) })
            : ORIGIN_NOT_ALLOWED));
        let pending = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            const { frames, rest } = readFrames(Buffer.concat([pending, chunk]));
            pending = rest;
            for (const frame of frames) {
                if (frame.opcode === 8) {
                    connection.closeAsked = true;
                    // A refused socket is silent, to the end: a client that waits for this answer waits.
                    if (allowed) socket.end(Buffer.from([0x88, 0]));
                    continue;
                }
                if (frame.opcode !== 1) continue;
                connection.received.push(frame.text);
                if (!allowed) continue;
                const message = JSON.parse(frame.text);
                if (message.event !== 'pusher:subscribe') continue;
                socket.write(textFrame(typeof message.data?.auth === 'string' && message.data.auth !== ''
                    ? JSON.stringify({ event: 'pusher_internal:subscription_succeeded', channel: message.data.channel, data: '{}' })
                    : JSON.stringify({ event: 'pusher:subscription_error', channel: message.data?.channel, data: '{}' })));
            }
        });
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const { port } = server.address();
    return {
        connections,
        /** What Tynn's `/api/v1/broadcasting-config` would answer for this server. */
        config: (key = 'rk') => ({ broadcaster: 'reverb', key, host: '127.0.0.1', port, scheme: 'http' }),
        url: (key = 'rk') => `ws://127.0.0.1:${port}/app/${key}?protocol=7&client=genie&version=2.0`,
        close: () => new Promise((resolve) => {
            for (const socket of open) socket.destroy();
            server.close(() => { resolve(); });
        }),
    };
}
