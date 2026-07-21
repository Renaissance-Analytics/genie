import type http from 'http';

/**
 * The MCP "Listening for Messages from the Server" GET SSE stream — the
 * Streamable HTTP transport's server->client push channel (spec 2025-11-25).
 *
 * Genie was a "basic" MCP server: it 405'd a GET to /mcp, so the server could
 * only ever answer a client request, never push. This registry opens the GET
 * stream so the server can push a notification the instant something happens
 * server-side (an AgentInbox DM arriving), instead of an agent holding a
 * blocking `receive` open.
 *
 * PROBE STAGE — the first increment exists to MEASURE, not to assume:
 *   1. does a real MCP client (claude / codex / cursor) actually OPEN this
 *      stream? (`openStreamCount`, and the reach count from `pushNotification`
 *      — 0 reached means the client never connected);
 *   2. does it carry `Mcp-Session-Id`, without which the chosen per-agent
 *      routing is impossible? (logged on open);
 *   3. does pushing a notification make the agent DO anything? (observed live).
 *
 * Everything here is additive — nothing that worked before changes, because a
 * GET simply had no handler.
 */

interface OpenStream {
    id: number;
    res: http.ServerResponse;
    /** The per-workspace endpoint token the stream was opened on. */
    token: string;
    /** The client-echoed Mcp-Session-Id, if any — the per-agent routing key. */
    sessionId?: string;
    beat: ReturnType<typeof setInterval>;
}

/** What a client presented when it opened the stream — pure measurement. */
export interface GetStreamLog {
    token: string;
    accept: string | undefined;
    sessionId: string | undefined;
    lastEventId: string | undefined;
}

/** A JSON-RPC notification pushed down the server->client stream. */
export interface ServerNotification {
    method: string;
    params?: Record<string, unknown>;
}

let seq = 0;
const streams = new Map<number, OpenStream>();

/**
 * Cumulative counters for the diagnostic readout — the whole point of the probe.
 * `streamsOpened` > 0 answers "does a real client open the GET stream?";
 * `streamsWithSession` > 0 answers "does it echo Mcp-Session-Id?" (per-agent
 * routing viability); `pushesReached` vs `pushesSent` answers "did a push land?".
 */
const stats = {
    streamsOpened: 0,
    streamsWithSession: 0,
    pushesSent: 0,
    pushesReached: 0,
};

/** A snapshot of the server-push measurement for the diagnostic surface. */
export interface ServerPushStats {
    /** Streams open right now. */
    open: number;
    /** Streams ever opened this session — >0 means a client opened the GET stream. */
    streamsOpened: number;
    /** Of those, how many carried an Mcp-Session-Id — >0 means the client echoes it. */
    streamsWithSession: number;
    /** Notifications the server tried to push. */
    pushesSent: number;
    /** Push deliveries that reached an open stream (sum of reach counts). */
    pushesReached: number;
}

export function serverPushStats(): ServerPushStats {
    return { open: streams.size, ...stats };
}

/** Reset counters (server stop / tests). */
export function resetServerPushStats(): void {
    stats.streamsOpened = 0;
    stats.streamsWithSession = 0;
    stats.pushesSent = 0;
    stats.pushesReached = 0;
}

function headerOf(req: http.IncomingMessage, name: string): string | undefined {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
}

/**
 * Open a server->client SSE stream for a GET on /mcp/<token>. The caller has
 * already validated the token. Registers the stream, primes it with an event id
 * (so the client can resume with Last-Event-ID), heartbeats it so an idle stream
 * isn't reaped, and unregisters on socket close.
 */
export function openGetStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    token: string,
    opts: { heartbeatMs: number; log?: (l: GetStreamLog) => void },
): void {
    const id = ++seq;
    const sessionId = headerOf(req, 'mcp-session-id');

    stats.streamsOpened += 1;
    if (sessionId) stats.streamsWithSession += 1;

    opts.log?.({
        token,
        accept: headerOf(req, 'accept'),
        sessionId,
        lastEventId: headerOf(req, 'last-event-id'),
    });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Loopback only; explicit like the JSON path.
        'Access-Control-Allow-Origin': '127.0.0.1',
    });

    // Spec: SHOULD send an event id + empty data first, priming the client to
    // reconnect with that id as Last-Event-ID.
    safeWrite(res, `id: ${id}\ndata: \n\n`);
    safeWrite(res, ': open\n\n');

    const beat = setInterval(() => {
        // A comment line carries no JSON-RPC meaning but counts as activity, so
        // the client's idle timer resets and the stream stays warm.
        safeWrite(res, ': heartbeat\n\n');
    }, opts.heartbeatMs);
    if (typeof beat.unref === 'function') beat.unref();

    streams.set(id, { id, res, token, sessionId, beat });

    const cleanup = (): void => {
        const s = streams.get(id);
        if (!s) return;
        clearInterval(s.beat);
        streams.delete(id);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
}

/**
 * Push a notification to every open stream matching the target (by workspace
 * `token`, by `sessionId`, or both). Returns how many streams it reached — 0 is
 * the load-bearing measurement: a push with no open stream means the client
 * never opened one, so server-push delivers nothing to it.
 */
export function pushNotification(
    target: { token?: string; sessionId?: string },
    notification: ServerNotification,
): number {
    const payload = JSON.stringify({ jsonrpc: '2.0', ...notification });
    let reached = 0;
    for (const s of streams.values()) {
        if (target.token && s.token !== target.token) continue;
        if (target.sessionId && s.sessionId !== target.sessionId) continue;
        if (s.res.writableEnded || s.res.destroyed) continue;
        if (safeWrite(s.res, `event: message\ndata: ${payload}\n\n`)) reached++;
    }
    stats.pushesSent += 1;
    stats.pushesReached += reached;
    return reached;
}

/** How many streams are open (all, or for one token). Observability + tests. */
export function openStreamCount(target?: { token?: string }): number {
    if (!target?.token) return streams.size;
    let n = 0;
    for (const s of streams.values()) if (s.token === target.token) n++;
    return n;
}

/** Close every open stream — server stop / test teardown. */
export function closeAllStreams(): void {
    for (const s of streams.values()) {
        clearInterval(s.beat);
        try {
            if (!s.res.writableEnded) s.res.end();
        } catch {
            /* socket already gone */
        }
    }
    streams.clear();
    resetServerPushStats();
}

function safeWrite(res: http.ServerResponse, chunk: string): boolean {
    if (res.writableEnded || res.destroyed) return false;
    try {
        res.write(chunk);
        return true;
    } catch {
        return false;
    }
}
