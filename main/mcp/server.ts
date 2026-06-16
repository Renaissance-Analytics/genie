import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
    handleMcpMessage,
    type ForceQuestion,
    type ForceQuestionResult,
    type JsonRpcRequest,
} from './protocol';

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
    /** Persist the port + token map here so endpoints survive a Genie restart. */
    userDataDir: string;
    /** Pulse the given terminal's attention glow (imDone). */
    onImDone: (terminalId: string) => void;
    /** Raise the OS-level question modal (ForceTheQuestion). */
    onForceQuestion: (
        terminalId: string,
        questions: ForceQuestion[],
    ) => Promise<ForceQuestionResult>;
}

let server: http.Server | null = null;
let port: number | null = null;
let deps: ServerDeps | null = null;

/**
 * Persisted MCP endpoint state (`<userData>/genie-mcp.json` = {port, tokens}).
 *
 * WHY: each terminal's GENIE_MCP_URL is baked into its env at terminal-create
 * time as `http://127.0.0.1:<port>/mcp/<token>`. The server used to bind a
 * RANDOM port each launch and wipe its token map, so every Genie restart (e.g.
 * an auto-update) left every existing terminal pointing at a dead endpoint —
 * imDone/ForceTheQuestion would "fail to connect". Persisting {port, tokens} and
 * restoring them on launch (rebind the same port if free, restore the tokens)
 * keeps already-issued endpoints working across restarts.
 */
function statePath(): string | null {
    return deps?.userDataDir ? path.join(deps.userDataDir, 'genie-mcp.json') : null;
}
function persistState(): void {
    const p = statePath();
    if (!p || port === null) return;
    try {
        const tok: Record<string, string> = {};
        for (const [t, id] of tokens) tok[t] = id;
        fs.writeFileSync(p, JSON.stringify({ port, tokens: tok }) + '\n', {
            mode: 0o600,
        });
    } catch {
        /* best-effort */
    }
}
function loadState(): { port: number | null; tokens: Record<string, string> } {
    const p = statePath();
    if (!p) return { port: null, tokens: {} };
    try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        return {
            port: typeof j.port === 'number' ? j.port : null,
            tokens: j.tokens && typeof j.tokens === 'object' ? j.tokens : {},
        };
    } catch {
        return { port: null, tokens: {} };
    }
}

/**
 * The deterministic, stable port this user's MCP server prefers EVERY launch —
 * derived from the userData path so it's the same across restarts/updates (and
 * distinct per OS user, so two users don't collide). Range 20000–29999: the
 * registered range, outside Windows' default ephemeral range (49152–65535), so
 * the OS won't hand it to something else. We only fall back to an ephemeral port
 * if this exact one is genuinely occupied.
 */
function preferredPort(): number {
    try {
        const seed = deps?.userDataDir ?? 'genie';
        const h = crypto.createHash('sha256').update(seed).digest();
        return 20000 + (h.readUInt16BE(0) % 10000);
    } catch {
        return 0; // ephemeral
    }
}
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

    const response = await handleMcpMessage(msg, {
        terminalId,
        serverName: SERVER_NAME,
        serverVersion: deps.serverVersion,
        onImDone: deps.onImDone,
        onForceQuestion: deps.onForceQuestion,
    });
    // Notifications get a 202 with no body; requests get their JSON-RPC result.
    if (response === null) send(res, 202);
    else send(res, 200, response);
}

/** Start the loopback MCP server (idempotent). Resolves once listening. */
export function startMcpServer(d: ServerDeps): Promise<void> {
    deps = d;
    if (server) return Promise.resolve();

    // Restore the previous run's tokens so endpoints baked into existing
    // terminals' GENIE_MCP_URL keep resolving (provided we get the same port).
    const prev = loadState();
    tokens.clear();
    byTerminal.clear();
    for (const [t, id] of Object.entries(prev.tokens)) {
        tokens.set(t, id);
        byTerminal.set(id, t);
    }

    const makeServer = () =>
        http.createServer((req, res) => {
            void handle(req, res).catch(() => {
                try {
                    send(res, 500, { error: 'internal error' });
                } catch {
                    /* response already sent */
                }
            });
        });

    return new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        const listen = (tryPort: number, restoredTokens: boolean) => {
            const s = makeServer();
            s.once('error', (e: NodeJS.ErrnoException) => {
                // Persisted port is taken → fall back to an ephemeral port. The
                // restored tokens can't be served on a different port (old URLs
                // carry the old port), so drop them; new terminals re-register.
                if (e.code === 'EADDRINUSE' && tryPort !== 0) {
                    if (restoredTokens) {
                        tokens.clear();
                        byTerminal.clear();
                    }
                    listen(0, false);
                } else {
                    done(); // give up; no MCP this run (best-effort feature)
                }
            });
            s.listen(tryPort, '127.0.0.1', () => {
                server = s;
                const addr = s.address();
                port = typeof addr === 'object' && addr ? addr.port : null;
                persistState();
                done();
            });
        };
        // Prefer the deterministic per-user port so the baked URLs are stable
        // every launch. (prev.port is kept in state only for diagnostics.)
        void prev.port;
        listen(preferredPort(), true);
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
        persistState(); // so the endpoint survives the next Genie restart
    }
    return `http://127.0.0.1:${port}/mcp/${token}`;
}

/** Drop a terminal's endpoint (on kill) so its token stops resolving. */
export function unregisterTerminalEndpoint(terminalId: string): void {
    const token = byTerminal.get(terminalId);
    if (token) tokens.delete(token);
    byTerminal.delete(terminalId);
    persistState();
}

/** Test/diagnostic accessor. */
export function mcpServerPort(): number | null {
    return port;
}
