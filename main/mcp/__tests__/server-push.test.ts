import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type http from 'node:http';
import {
    closeAllStreams,
    openGetStream,
    openStreamCount,
    pushNotification,
    type GetStreamLog,
} from '../server-push';

// The registry only touches `.headers` / `.on` on the req and
// `.writeHead/.write/.end/.on/.writableEnded/.destroyed` on the res, so a tiny
// EventEmitter-backed fake stands in for a live socket without a real server.
const asReq = (r: EventEmitter & { headers: Record<string, string> }) =>
    r as unknown as http.IncomingMessage;
const asRes = (r: EventEmitter) => r as unknown as http.ServerResponse;

/**
 * The server->client GET SSE stream registry (MCP Streamable HTTP §"Listening
 * for Messages from the Server"). PROBE stage: prove the registry opens streams,
 * routes a push by token AND by session id, reports how many streams a push
 * actually reached (0 = the client never opened one — the key measurement), and
 * logs the client's Accept / Mcp-Session-Id so per-agent routing can be
 * validated against real client behaviour.
 */

/** A fake req/res pair standing in for a live SSE socket. */
function fakeConn(headers: Record<string, string> = {}) {
    const req = new EventEmitter() as EventEmitter & { headers: Record<string, string> };
    req.headers = headers;
    const chunks: string[] = [];
    const res = new EventEmitter() as EventEmitter & {
        writableEnded: boolean;
        destroyed: boolean;
        headers?: Record<string, string>;
        status?: number;
        writeHead: (s: number, h: Record<string, string>) => void;
        write: (c: string) => boolean;
        end: () => void;
    };
    res.writableEnded = false;
    res.destroyed = false;
    res.writeHead = (s, h) => {
        res.status = s;
        res.headers = h;
    };
    res.write = (c) => {
        chunks.push(c);
        return true;
    };
    res.end = () => {
        res.writableEnded = true;
    };
    return { req, res, chunks };
}

afterEach(() => closeAllStreams());

const HB = { heartbeatMs: 10_000 };

describe('server-push GET stream registry', () => {
    it('opens an SSE stream with the right headers and primes a resume id', () => {
        const { req, res, chunks } = fakeConn({ accept: 'text/event-stream' });
        openGetStream(asReq(req), asRes(res), 'tok-1', HB);

        expect(res.status).toBe(200);
        expect(res.headers?.['Content-Type']).toBe('text/event-stream');
        // Spec: an event id + empty data first, so the client can reconnect with
        // Last-Event-ID.
        expect(chunks.join('')).toMatch(/^id: \d+\ndata: *\n\n/);
        expect(openStreamCount()).toBe(1);
    });

    it('reports how many streams a token-targeted push reached', () => {
        const a = fakeConn();
        const b = fakeConn();
        openGetStream(asReq(a.req), asRes(a.res), 'tok-1', HB);
        openGetStream(asReq(b.req), asRes(b.res), 'tok-2', HB);

        const reached = pushNotification(
            { token: 'tok-1' },
            { method: 'notifications/message', params: { data: 'ping' } },
        );

        expect(reached).toBe(1); // only tok-1's stream
        expect(a.chunks.join('')).toContain('"method":"notifications/message"');
        expect(a.chunks.join('')).toContain('event: message');
        expect(b.chunks.join('')).not.toContain('notifications/message');
    });

    it('returns 0 when nobody has an open stream — the "client never connected" signal', () => {
        const reached = pushNotification(
            { token: 'tok-nobody' },
            { method: 'notifications/message' },
        );
        expect(reached).toBe(0);
    });

    it('routes per-agent by Mcp-Session-Id (the chosen routing model)', () => {
        const a = fakeConn({ 'mcp-session-id': 'sess-A' });
        const b = fakeConn({ 'mcp-session-id': 'sess-B' });
        openGetStream(asReq(a.req), asRes(a.res), 'tok-1', HB);
        openGetStream(asReq(b.req), asRes(b.res), 'tok-1', HB); // same workspace token

        const reached = pushNotification(
            { sessionId: 'sess-B' },
            { method: 'notifications/message', params: { data: 'for B only' } },
        );

        expect(reached).toBe(1);
        expect(b.chunks.join('')).toContain('for B only');
        expect(a.chunks.join('')).not.toContain('for B only');
    });

    it('captures the client Accept + session + last-event-id for measurement', () => {
        const logs: GetStreamLog[] = [];
        const { req, res } = fakeConn({
            accept: 'text/event-stream',
            'mcp-session-id': 'sess-A',
            'last-event-id': '7',
        });
        openGetStream(asReq(req), asRes(res), 'tok-1', { ...HB, log: (l) => logs.push(l) });

        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({
            token: 'tok-1',
            accept: 'text/event-stream',
            sessionId: 'sess-A',
            lastEventId: '7',
        });
    });

    it('unregisters a stream when the socket closes', () => {
        const { req, res } = fakeConn();
        openGetStream(asReq(req), asRes(res), 'tok-1', HB);
        expect(openStreamCount()).toBe(1);

        req.emit('close');
        expect(openStreamCount()).toBe(0);
    });

    it('does not write to an ended stream', () => {
        const { req, res, chunks } = fakeConn();
        openGetStream(asReq(req), asRes(res), 'tok-1', HB);
        res.writableEnded = true;
        const before = chunks.length;

        const reached = pushNotification({ token: 'tok-1' }, { method: 'notifications/message' });
        expect(reached).toBe(0);
        expect(chunks.length).toBe(before);
    });
});
