import { LoopbackHttpTransport, Server, type ServerTransport } from '@particle-academy/prism-mcp-server';
import type { Registration } from './mcp-tools.js';

/**
 * GENIE'S OWN MCP SERVER (§6.9): prism-mcp-server on a loopback HTTP transport — a literal 127.0.0.1 address,
 * POST-only, stateless, a 256-bit bearer minted at listen — serving every Genie tool registration.
 *
 * A LONG CALL IS A STREAM (genie#1360, prism-mcp-server 0.4.0+): a `tools/call` that accepts `text/event-stream` is
 * answered as SSE — opened at once, a heartbeat every 10 s, the result as the last event. Claude Code drops any call
 * whose response says nothing for 60 s (measured: every wait past 60 s failed at 61.9 s on one held JSON body), so a
 * 10-minute `agentinbox receive wait` or a 30-minute approval needs the stream. A JSON-only client (Codex) keeps its
 * one JSON body.
 *
 * A WAITING CALL KEEPS SAYING SO — PRISM DOES IT (prism-mcp-server 0.5.0). Claude Code also aborts a call that "sent no
 * response or progress for 302s" (measured, claude 2.1.314), and heartbeat comments do not count. prism sends a
 * keepalive `notifications/progress` every 30 s on a streamed call that carries a progressToken, repeating the
 * handler's latest message. Genie relies on that and repeats nothing itself: a wait reports what it waits for once
 * (`ToolProgress`). Genie used to wrap every handler in its own 30 s repeat (#1364); a test fails if one comes back.
 *
 * The URL and the token become `GENIE_MCP_URL` / `GENIE_MCP_TOKEN` in every terminal's environment and the endpoint
 * config sync writes into a workspace.
 *
 * "Native transport verified at boot" (§6.4): `verify()` is a REAL `server/discover` through the server's
 * own door — over the loopback it is an HTTP request with the bearer, like a client's first probe; over an
 * in-memory transport it is the transport's own request. The answer is the one revision served, or a reason.
 */

export interface GenieMcpServerInput {
    readonly registrations: readonly Registration[];
    /** An in-memory transport for tests; absent = the real loopback. */
    readonly transport?: ServerTransport | undefined;
    /** 0 lets the OS pick; the URL carries the port actually bound. */
    readonly port?: number | undefined;
    /**
     * The endpoint remembered across launches (a private file in Genie's home). Reused when present, so the URLs and
     * tokens config sync wrote stay valid; written when a new port or token had to be taken. Absent = random each time.
     */
    readonly remember?: { read(): { port: number; token: string } | null; write(value: { port: number; token: string }): void } | undefined;
}

export type Verification = { ok: true; versions: readonly string[] } | { ok: false; reason: string };

export interface GenieMcpServer {
    start(): Promise<{ url: string; token: string }>;
    stop(): Promise<void>;
    /** `null` until started and after stopped — config sync and terminals read this, never a stale URL. */
    endpoint(): { url: string; token: string } | null;
    verify(): Promise<Verification>;
}

const NOT_LISTENING = 'the MCP server is not listening';

export function genieMcpServer(input: GenieMcpServerInput): GenieMcpServer {
    const build = (options: { port: number; token?: string }): Server => {
        // `abortOnDisconnect` (genie#1360): a client that goes away fires its call's signal, so the wait behind it — an
        // approval, `services exec`, `agentinbox receive wait` — is withdrawn instead of running on for nobody.
        const s = new Server({ server: 'genie', transport: input.transport ?? new LoopbackHttpTransport({ ...options, abortOnDisconnect: true }) });
        for (const r of input.registrations) {
            const visible = r.visible;
            if (visible) s.register(r.definition, r.handler as never, { visible: (context: { headers: Record<string, string> }) => visible(context) });
            else s.register(r.definition, r.handler as never);
        }
        return s;
    };
    const remembered = input.remember?.read() ?? null;
    let server = build(remembered ? { port: remembered.port, token: remembered.token } : { port: input.port ?? 0 });
    let endpoint: { url: string; token: string } | null = null;

    const discover = async (): Promise<unknown> => {
        if (!endpoint) throw new Error(NOT_LISTENING);
        if (input.transport && 'request' in input.transport && typeof (input.transport as { request?: unknown }).request === 'function') {
            return (input.transport as { request: (r: { method: string }) => Promise<unknown> }).request({ method: 'server/discover' });
        }
        const res = await fetch(endpoint.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.token}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }),
        });
        if (!res.ok) throw new Error(`server/discover answered ${res.status}`);
        const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
        if (body.error) throw new Error(body.error.message ?? 'server/discover failed');
        return body.result;
    };

    return {
        start: async () => {
            let listening: { url: string; token?: string | null };
            try {
                listening = await server.listen();
            } catch (error) {
                // The remembered port is taken: a new one, the SAME token (so only the port in synced files changes).
                if (!remembered || input.transport) throw error;
                server = build({ port: 0, token: remembered.token });
                listening = await server.listen();
            }
            endpoint = { url: listening.url, token: listening.token ?? '' };
            const bound = Number(new URL(endpoint.url).port);
            if (input.remember && (!remembered || remembered.port !== bound || remembered.token !== endpoint.token)) input.remember.write({ port: bound, token: endpoint.token });
            return endpoint;
        },
        stop: async () => {
            endpoint = null;
            await server.close();
        },
        endpoint: () => endpoint,
        verify: async () => {
            try {
                const result = (await discover()) as { supportedVersions?: unknown };
                const versions = Array.isArray(result.supportedVersions) ? result.supportedVersions.filter((v): v is string => typeof v === 'string') : [];
                return versions.length > 0 ? { ok: true, versions } : { ok: false, reason: 'server/discover named no protocol version' };
            } catch (error) {
                return { ok: false, reason: error instanceof Error ? error.message : String(error) };
            }
        },
    };
}
