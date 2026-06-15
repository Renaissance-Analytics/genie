import http from 'http';
import crypto from 'crypto';
import { handleMcpMessage, type JsonRpcRequest } from './protocol';

/**
 * Genie's local MCP server — a tiny HTTP/JSON-RPC endpoint that lets agents
 * running in Genie terminals drive the Genie UI. Bound to 127.0.0.1 on an
 * ephemeral port (loopback-only; never exposed off-box).
 *
 * Each terminal gets its OWN auto-wired endpoint:
 *   http://127.0.0.1:<port>/mcp/<token>
 * where <token> resolves to that terminal's id. Because the endpoint encodes
 * the terminal, tools like `imDone` take no argument — zero agent setup beyond
 * pointing an MCP client at GENIE_MCP_URL.
 */

const SERVER_NAME = 'genie';

interface ServerDeps {
    serverVersion: string;
    /** Pulse the given terminal's attention glow (imDone). */
    onImDone: (terminalId: string) => void;
}

let server: http.Server | null = null;
let port: number | null = null;
let deps: ServerDeps | null = null;
/** token → terminalId. A token is minted per terminal when MCP is enabled. */
const tokens = new Map<string, string>();
/** terminalId → token, so re-registering a terminal reuses its token. */
const byTerminal = new Map<string, string>();

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (c) => {
            data += c;
            if (data.length > 1_000_000) {
                reject(new Error('payload too large'));
                req.destroy();
            }
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

function send(res: http.ServerResponse, status: number, body?: unknown): void {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        // Loopback only; no cross-origin use, but be explicit.
        'Access-Control-Allow-Origin': '127.0.0.1',
    });
    res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<void> {
    if (!deps) {
        send(res, 503, { error: 'server not ready' });
        return;
    }
    // Route: /mcp/<token>
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const m = url.pathname.match(/^\/mcp\/([A-Za-z0-9_-]+)$/);
    if (!m) {
        send(res, 404, { error: 'not found' });
        return;
    }
    const terminalId = tokens.get(m[1]);
    if (!terminalId) {
        send(res, 404, { error: 'unknown endpoint' });
        return;
    }
    if (req.method !== 'POST') {
        send(res, 405, { error: 'method not allowed' });
        return;
    }

    let msg: JsonRpcRequest;
    try {
        msg = JSON.parse(await readBody(req)) as JsonRpcRequest;
    } catch {
        send(res, 400, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
        });
        return;
    }

    const response = handleMcpMessage(msg, {
        terminalId,
        serverName: SERVER_NAME,
        serverVersion: deps.serverVersion,
        onImDone: deps.onImDone,
    });
    // Notifications get a 202 with no body; requests get their JSON-RPC result.
    if (response === null) send(res, 202);
    else send(res, 200, response);
}

/** Start the loopback MCP server (idempotent). Resolves once listening. */
export function startMcpServer(d: ServerDeps): Promise<void> {
    deps = d;
    if (server) return Promise.resolve();
    return new Promise((resolve) => {
        server = http.createServer((req, res) => {
            void handle(req, res).catch(() => {
                try {
                    send(res, 500, { error: 'internal error' });
                } catch {
                    /* response already sent */
                }
            });
        });
        // Port 0 → OS picks a free ephemeral port. 127.0.0.1 → loopback only.
        server.listen(0, '127.0.0.1', () => {
            const addr = server!.address();
            port = typeof addr === 'object' && addr ? addr.port : null;
            resolve();
        });
    });
}

export function stopMcpServer(): void {
    server?.close();
    server = null;
    port = null;
    tokens.clear();
    byTerminal.clear();
}

/**
 * Mint (or reuse) a per-terminal endpoint and return its full URL, or null if
 * the server isn't listening yet. Idempotent per terminal id.
 */
export function registerTerminalEndpoint(terminalId: string): string | null {
    if (port === null) return null;
    let token = byTerminal.get(terminalId);
    if (!token) {
        token = crypto.randomBytes(18).toString('hex');
        tokens.set(token, terminalId);
        byTerminal.set(terminalId, token);
    }
    return `http://127.0.0.1:${port}/mcp/${token}`;
}

/** Drop a terminal's endpoint (on kill) so its token stops resolving. */
export function unregisterTerminalEndpoint(terminalId: string): void {
    const token = byTerminal.get(terminalId);
    if (token) tokens.delete(token);
    byTerminal.delete(terminalId);
}

/** Test/diagnostic accessor. */
export function mcpServerPort(): number | null {
    return port;
}
