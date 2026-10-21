import { createServer, connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * ANOTHER WORKSTATION'S `.gen` SITES OVER THE TYNN RELAY (browser rebuild step 4) — a byte pipe on the relay's `site`
 * channel, which genie-cloud forwards reliably and never reads.
 *
 *   browser ──CONNECT app.gen:443──▶ siteDoor (client, loopback) ══ site stream ══▶ host ──CONNECT──▶ its front door
 *
 * Unlike Genie 1 (which decrypted on the client with a throwaway CA and re-sent HTTP), the client never sees inside:
 * the TLS runs from the browser to the HOST's own front door, with the host's own certificate, so the relay and the
 * client's main process carry ciphertext only.
 *
 * The frames, all on `site` and keyed by `reqId` (Genie 2's own payloads; both ends are Genie 2):
 *   member → host  open  {host}               open a stream to one of the host's `.gen` names
 *   host → member  data  {t:'open'}           the host's front door accepted; bytes may flow
 *   either way     data  {t:'bytes', data}    a chunk, base64
 *   either way     data  {t:'ack', n}         n bytes were written out at this end
 *   either way     close                      the stream ended
 *   either way     error {reason}             it failed, in words
 *
 * FLOW CONTROL: at most {@link SITE_WINDOW} unacknowledged bytes per stream, each way. genie-cloud closes the WHOLE
 * member session when a reliable channel backs up past its watermark (`relay-server/backpressure.ts`), so a large
 * download must stall its own stream, never end the window's connection.
 */

export const SITE_WINDOW = 512 * 1024;
const SITE_CHUNK = 64 * 1024;

/** A frame for one stream, before the link stamps `channel`, `sid` and `reqId` on it. */
export interface SiteFrame {
    kind: 'open' | 'data' | 'close' | 'error';
    payload?: unknown;
    reason?: string;
}

export interface SitePipe {
    /** A frame from the far end for this stream. */
    receive(frame: SiteFrame): void;
    /** End it from this side without a word to the far end (the session that carried it is gone). */
    destroy(): void;
}

/**
 * Pipe a local socket into a site stream. `send` puts a frame on the wire; `done` runs once, however it ended.
 */
export function pipeSiteStream(socket: Duplex, send: (frame: SiteFrame) => void, done: () => void): SitePipe {
    let inFlight = 0;
    let ended = false;
    /** Read from the socket, not yet sent: it would have gone past the window. */
    const held: Buffer[] = [];
    let endAfterHeld = false;

    const finish = (frame: SiteFrame | null) => {
        if (ended) return;
        ended = true;
        if (frame) send(frame);
        socket.destroy();
        done();
    };
    // The local end finished: say so once everything read was sent, and let what is queued for it drain first.
    const endLocal = () => {
        if (ended) return;
        ended = true;
        send({ kind: 'close' });
        socket.end();
        done();
    };

    /** Send what is held, up to the window; reading stops while anything is held or the window is full. */
    const pump = () => {
        while (!ended && held.length > 0 && inFlight < SITE_WINDOW) {
            const head = held[0]!;
            const take = Math.min(SITE_CHUNK, SITE_WINDOW - inFlight, head.length);
            inFlight += take;
            send({ kind: 'data', payload: { t: 'bytes', data: head.subarray(0, take).toString('base64') } });
            if (take === head.length) held.shift();
            else held[0] = head.subarray(take);
        }
        if (ended) return;
        if (held.length > 0 || inFlight >= SITE_WINDOW) socket.pause();
        else if (endAfterHeld) endLocal();
        else if (socket.isPaused()) socket.resume();
    };

    socket.on('data', (chunk: Buffer) => {
        if (ended) return;
        held.push(chunk);
        pump();
    });
    socket.on('end', () => {
        endAfterHeld = true;
        if (held.length === 0) endLocal();
    });
    socket.on('close', () => { if (!endAfterHeld) finish({ kind: 'close' }); });
    socket.on('error', (error: Error) => finish({ kind: 'error', reason: error.message }));
    // A socket handed over paused (dialFrontDoor, siteDoor) starts flowing only now that every listener is on.
    if (socket.isPaused()) socket.resume();

    return {
        receive: (frame) => {
            if (ended) return;
            if (frame.kind === 'close') {
                ended = true;
                socket.end();
                done();
                return;
            }
            if (frame.kind === 'error') {
                finish(null);
                return;
            }
            const p = frame.payload as { t?: unknown; data?: unknown; n?: unknown } | undefined;
            if (frame.kind === 'data' && p?.t === 'bytes' && typeof p.data === 'string') {
                const bytes = Buffer.from(p.data, 'base64');
                socket.write(bytes, () => { if (!ended) send({ kind: 'data', payload: { t: 'ack', n: bytes.length } }); });
                return;
            }
            if (frame.kind === 'data' && p?.t === 'ack' && typeof p.n === 'number' && Number.isInteger(p.n) && p.n > 0) {
                inFlight = Math.max(0, inFlight - p.n);
                pump();
                return;
            }
            finish({ kind: 'error', reason: 'malformed site frame' });
        },
        destroy: () => finish(null),
    };
}

/** A `.gen` name as the front door serves it: labels of letters, digits and hyphens, ending `.gen`. */
export function isGenHost(host: unknown): host is string {
    return typeof host === 'string' && host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+gen$/i.test(host);
}

export type SiteDial = { ok: true; socket: Socket } | { ok: false; reason: string };

/**
 * The HOST's side: CONNECT its own front door (`gen-router-server.ts`, loopback) for `host`, and hand back the socket
 * once it answered 200 — or the front door's own words when it refused.
 */
export function dialFrontDoor(port: number, host: string, timeoutMs = 10_000): Promise<SiteDial> {
    return new Promise((resolve) => {
        if (!isGenHost(host)) { resolve({ ok: false, reason: `${JSON.stringify(host)} is not a .gen name` }); return; }
        const socket = connect(port, '127.0.0.1');
        let head = Buffer.alloc(0);
        let settled = false;
        const settle = (r: SiteDial) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.off('data', onData);
            if (!r.ok) socket.destroy();
            resolve(r);
        };
        const timer = setTimeout(() => settle({ ok: false, reason: 'the front door did not answer' }), timeoutMs);
        const onData = (chunk: Buffer) => {
            head = Buffer.concat([head, chunk]);
            const end = head.indexOf('\r\n\r\n');
            if (end < 0) {
                if (head.length > 16 * 1024) settle({ ok: false, reason: 'the front door answered with something that is not HTTP' });
                return;
            }
            const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.toString('latin1'))?.[1];
            if (status !== '200') {
                // A refusal's body is the front door's reason; read what is there now, and the rest until it closes.
                let body = head.subarray(end + 4).toString('utf8');
                socket.on('data', (more: Buffer) => { body += more.toString('utf8'); });
                const said = () => settle({ ok: false, reason: body.trim() || `the front door refused ${host} (${status ?? 'no status'})` });
                socket.once('end', said);
                socket.once('close', said);
                setTimeout(said, 1_000);
                return;
            }
            // Paused until it is piped: nothing the front door sends in between is lost.
            socket.pause();
            const rest = head.subarray(end + 4);
            if (rest.length > 0) socket.unshift(rest);
            settle({ ok: true, socket });
        };
        socket.on('data', onData);
        socket.on('connect', () => socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
        socket.on('error', (error) => settle({ ok: false, reason: `the front door is not reachable: ${error.message}` }));
    });
}

/** What opening a site stream over the relay came to: a stream to pipe a socket into, or the host's refusal. */
export type SiteOpen = { ok: true; pipe(socket: Duplex): void } | { ok: false; reason: string };

/**
 * The CLIENT's side: a loopback door the browser's PAC points at. It takes `CONNECT <name>:443` for the names it was
 * given, opens a stream over the relay, and answers the browser only once the host did — 200, or 502 with the host's
 * words. Anything else is refused here, before a frame is sent.
 */
export async function siteDoor(input: { allowed(host: string): boolean; open(host: string): Promise<SiteOpen> }): Promise<{ port: number; close(): void }> {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        let head = Buffer.alloc(0);
        const refuse = (status: string, reason: string) => socket.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${reason}`);
        const onData = (chunk: Buffer) => {
            head = Buffer.concat([head, chunk]);
            const end = head.indexOf('\r\n\r\n');
            if (end < 0) {
                if (head.length > 16 * 1024) { socket.off('data', onData); refuse('431 Request Header Fields Too Large', 'request head too large'); }
                return;
            }
            socket.off('data', onData);
            socket.pause();
            const m = /^CONNECT ([^\s:]+):(\d{1,5}) HTTP\/1\.[01]\r\n/.exec(head.toString('latin1'));
            const host = m?.[1]?.toLowerCase();
            if (!m || !host || m[2] !== '443' || !isGenHost(host) || !input.allowed(host)) {
                refuse('403 Forbidden', m ? `${m[1]}:${m[2]} is not one of this workstation's sites` : 'only CONNECT to a .gen site on 443');
                return;
            }
            const rest = head.subarray(end + 4);
            void input.open(host).then(
                (opened) => {
                    if (socket.destroyed) return;
                    if (!opened.ok) { refuse('502 Bad Gateway', opened.reason); return; }
                    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                    if (rest.length > 0) socket.unshift(rest);
                    opened.pipe(socket);
                },
                (error: unknown) => refuse('502 Bad Gateway', error instanceof Error ? error.message : String(error)),
            );
        };
        socket.on('data', onData);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    return {
        port: (server.address() as { port: number }).port,
        close: () => {
            server.close();
            for (const s of sockets) s.destroy();
        },
    };
}
