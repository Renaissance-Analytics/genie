import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
    closeAllStreams,
    openGetStream,
    pushNotification,
    serverPushStats,
    type GetStreamLog,
    type ServerNotification,
    type ServerPushStats,
} from './server-push';
import {
    handleMcpMessage,
    type ForceQuestion,
    type ForceQuestionResult,
    type JsonRpcRequest,
    type JsonRpcResponse,
    type ManageProcessRequest,
    type ManageProcessResult,
    type ProvisionWorkspacesRequest,
    type ProvisionWorkspacesResult,
    type ManageTerminalsRequest,
    type ManageTerminalsResult,
    type RunAgentRequest,
    type RunAgentResult,
    type ManageWorkspacesRequest,
    type ManageWorkspacesResult,
    type AgentInboxRequest,
    type AgentInboxResult,
    type KnowledgeToolRequest,
    type KnowledgeToolResult,
    type OpenFileRequest,
    type OpenFileResult,
    type SetEnvRequest,
    type SetEnvResult,
    type CheckEnvRequest,
    type CheckEnvResult,
    type WorkspaceMap,
    type IssueWatchSnapshot,
    type McpToolDescriptor,
    type McpToolCallResult,
} from './protocol';

/**
 * Genie's local MCP server — a tiny HTTP/JSON-RPC endpoint that lets agents
 * running in Genie terminals drive the Genie UI. Bound to 127.0.0.1 on a
 * FIXED, user-settable port (loopback-only; never exposed off-box).
 *
 * CONNECTION MODEL (as of the fixed-port rework):
 *   - The server binds a single, stable port (the `mcp_port` setting, default
 *     51717) so the URL baked into a workspace's `.mcp.json` is a HARD-CODED
 *     literal — `http://127.0.0.1:<port>/mcp/<workspace-token>` — with NO
 *     `${ENV}` expansion. (The old `${GENIE_MCP_URL}` env-ref was unreliable:
 *     Claude Code FAILS TO PARSE the whole config if the var is unset, and
 *     Cursor uses a different `${env:NAME}` syntax — so agents launched
 *     outside a Genie terminal, or in Cursor, simply couldn't connect.)
 *   - Each WORKSPACE gets one stable token (token → workspaceId), minted once
 *     and persisted. The `.mcp.json` URL carries it.
 *   - Per-terminal resolution for imDone/ForceTheQuestion is preserved without
 *     env expansion in the URL: the tools take an OPTIONAL `terminalId` arg
 *     (the agent reads it from its `GENIE_TERMINAL_ID` env, documented in the
 *     guide). When omitted, the server falls back to the workspace's
 *     most-recently-active terminal.
 *   - Legacy per-terminal tokens still resolve (so URLs baked into older
 *     terminals keep working through a transition).
 */

const SERVER_NAME = 'genie';

/** The default fixed port — obscure, outside the OS ephemeral range. */
export const DEFAULT_MCP_PORT = 51717;

export interface ServerDeps {
    serverVersion: string;
    /** Persist the port + token maps here so endpoints survive a Genie restart. */
    userDataDir: string;
    /** The user-configured fixed port (Settings → Agent MCP). */
    configuredPort: () => number;
    /** Resolve a workspace's terminals + the most-recently-active one. */
    workspaceTerminals: (workspaceId: string) => {
        ids: string[];
        lastActive: string | null;
    };
    /** Pulse the given terminal's attention glow (imDone). */
    onImDone: (terminalId: string) => void;
    /** Resolve the caller's workspace IssueWatch snapshot (checkIssues + imDone counts). */
    checkIssues: (terminalId: string) => Promise<IssueWatchSnapshot>;
    /** A "you have N unread AgentInbox messages" nudge for the caller's terminal, folded into
     *  imDone (Track A turn-boundary delivery). Optional. */
    agentInboxMailLine?: (terminalId: string) => string | null;
    /** Raise the OS-level question modal (ForceTheQuestion). */
    onForceQuestion: (
        terminalId: string,
        questions: ForceQuestion[],
    ) => Promise<ForceQuestionResult>;
    /** Map the caller's workspace for the initializeWorkspace prompt. */
    describeWorkspace: (terminalId: string) => Promise<WorkspaceMap | null>;
    /** Manage the caller's workspace background processes (manageProcess tool). */
    manageProcess: (
        terminalId: string,
        req: ManageProcessRequest,
    ) => Promise<ManageProcessResult>;
    /** Provision child-project workspaces for an Ops project (provisionWorkspaces tool). */
    provisionWorkspaces: (
        terminalId: string,
        req: ProvisionWorkspacesRequest,
    ) => Promise<ProvisionWorkspacesResult>;
    /** Spawn/drive terminals in the caller's or a governed workspace (manageTerminals tool). */
    manageTerminals: (
        terminalId: string,
        req: ManageTerminalsRequest,
    ) => Promise<ManageTerminalsResult>;
    /** Launch + control a coding agent inside a terminal (runAgent tool). */
    runAgent: (
        terminalId: string,
        req: RunAgentRequest,
    ) => Promise<RunAgentResult>;
    /** Open/activate/remove + status the caller's or a governed workspace (manageWorkspaces tool). */
    manageWorkspaces: (
        terminalId: string,
        req: ManageWorkspacesRequest,
    ) => Promise<ManageWorkspacesResult>;
    /** Local inter-agent messaging (agentinbox tool). `receive`+`wait` long-polls. */
    agentInbox: (terminalId: string, req: AgentInboxRequest) => Promise<AgentInboxResult>;
    /** Workstation Knowledge Graph — the shared local memory store (knowledge tool). */
    knowledge: (terminalId: string, req: KnowledgeToolRequest) => Promise<KnowledgeToolResult>;
    /** Open a file in Genie's built-in editor for the user (openFileForUser tool). */
    openFileForUser: (
        terminalId: string,
        req: OpenFileRequest,
    ) => Promise<OpenFileResult>;
    /** Upsert a KEY=value into the caller's workspace/repo `.env` (setEnv tool). */
    setEnv: (terminalId: string, req: SetEnvRequest) => SetEnvResult;
    /** Look up a key in the caller's workspace/repo `.env` (checkEnv tool). */
    checkEnv: (terminalId: string, req: CheckEnvRequest) => CheckEnvResult;
    /** True when the caller's workspace is an Ops project. Gates the ops-only
     *  `provisionWorkspaces` tool OUT of tools/list for non-Ops workspaces. */
    isOpsProject: (terminalId: string) => Promise<boolean>;
    /** Namespaced tool descriptors from enabled plugins (Plugin System seam).
     *  Optional + fail-closed — see McpContext.pluginTools. */
    pluginTools?: () => McpToolDescriptor[];
    /** Dispatch a namespaced plugin tool call (Plugin System seam). */
    dispatchPluginTool?: (
        name: string,
        args: Record<string, unknown>,
        terminalId: string,
    ) => Promise<McpToolCallResult>;
}

let server: http.Server | null = null;
let port: number | null = null;
/** True when the configured port was taken and we fell back to ephemeral. */
let conflict = false;
let deps: ServerDeps | null = null;

/**
 * Persisted MCP endpoint state (`<userData>/genie-mcp.json`). Holds the port
 * plus BOTH token maps (per-terminal legacy tokens + per-workspace tokens) so
 * URLs already baked into `.mcp.json` / terminal env keep resolving across a
 * Genie restart (e.g. an auto-update). With a fixed configured port the rebind
 * is reliable, so restored tokens almost always keep serving.
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
        const ws: Record<string, string> = {};
        for (const [t, id] of workspaceTokens) ws[t] = id;
        fs.writeFileSync(
            p,
            JSON.stringify({ port, tokens: tok, workspaceTokens: ws }) + '\n',
            { mode: 0o600 },
        );
    } catch {
        /* best-effort */
    }
}
function loadState(): {
    port: number | null;
    tokens: Record<string, string>;
    workspaceTokens: Record<string, string>;
} {
    const p = statePath();
    if (!p) return { port: null, tokens: {}, workspaceTokens: {} };
    try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        return {
            port: typeof j.port === 'number' ? j.port : null,
            tokens: j.tokens && typeof j.tokens === 'object' ? j.tokens : {},
            workspaceTokens:
                j.workspaceTokens && typeof j.workspaceTokens === 'object'
                    ? j.workspaceTokens
                    : {},
        };
    } catch {
        return { port: null, tokens: {}, workspaceTokens: {} };
    }
}

/** token → terminalId. Legacy per-terminal tokens (kept resolving). */
const tokens = new Map<string, string>();
/** terminalId → token, so re-registering a terminal reuses its token. */
const byTerminal = new Map<string, string>();
/** token → workspaceId. The stable per-workspace endpoint baked into .mcp.json. */
const workspaceTokens = new Map<string, string>();
/** workspaceId → token, so re-resolving a workspace reuses its token. */
const byWorkspace = new Map<string, string>();

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

function send(
    res: http.ServerResponse,
    status: number,
    body?: unknown,
    extraHeaders?: Record<string, string>,
): void {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        // Loopback only; no cross-origin use, but be explicit.
        'Access-Control-Allow-Origin': '127.0.0.1',
        ...(extraHeaders ?? {}),
    });
    res.end(body === undefined ? undefined : JSON.stringify(body));
}

/**
 * PROBE: mint an `Mcp-Session-Id` at initialize and remember which workspace
 * token it belongs to. A spec-compliant client MUST then echo it on subsequent
 * requests — including the GET stream — which is exactly what makes per-agent
 * routing possible. We assign but do NOT require it, so a client that ignores it
 * keeps working unchanged; we just learn whether the real client honours it.
 */
const sessionToken = new Map<string, string>();
function mintSessionId(token: string): string {
    const id = crypto.randomUUID();
    sessionToken.set(id, token);
    return id;
}

/**
 * PROBE + routing: which TERMINAL an Mcp-Session-Id belongs to. Learned when a
 * POST tool call carries BOTH the echoed session id (header) and a resolved
 * terminalId (GENIE_TERMINAL_ID arg) — the moment the two are correlated. This
 * is what lets a DM to one agent push to exactly that agent's GET stream
 * (per-agent routing) instead of every agent in the workspace. If a client never
 * echoes the session id, this map stays empty and callers fall back to
 * workspace-wide — so routing degrades gracefully to what the client supports.
 */
const sessionTerminal = new Map<string, string>();

/** PROBE log: what a client presented when it opened the GET stream. */
function logGetStream(l: GetStreamLog): void {
    const tok = l.token.length > 8 ? l.token.slice(0, 8) + '…' : l.token;
    // eslint-disable-next-line no-console
    console.log(
        `[mcp-get-stream] opened token=${tok} accept=${l.accept ?? '(none)'} ` +
            `session=${l.sessionId ?? '(none)'} lastEventId=${l.lastEventId ?? '(none)'}`,
    );
}

/**
 * Push a server->client notification to a workspace's open GET stream(s).
 * Returns how many streams it reached (0 = no client has an open stream for that
 * workspace). The AgentInbox broker calls this on DM arrival so a waiting agent
 * can be nudged over the stream instead of holding a blocking `receive`.
 */
export function pushToWorkspace(workspaceId: string, notification: ServerNotification): number {
    const token = byWorkspace.get(workspaceId);
    if (!token) return 0;
    return pushNotification({ token }, notification);
}

/**
 * Push to a SPECIFIC agent's GET stream(s), routed by the Mcp-Session-Id(s)
 * correlated to its terminal. Returns 0 when no session maps to that terminal
 * (client never echoed one, or the agent has no open stream) — the caller then
 * falls back to {@link pushToWorkspace}.
 */
export function pushToTerminal(terminalId: string, notification: ServerNotification): number {
    let reached = 0;
    for (const [sessionId, term] of sessionTerminal) {
        if (term === terminalId) reached += pushNotification({ sessionId }, notification);
    }
    return reached;
}

/** The server-push measurement — the diagnostic surface's data. Adds the
 *  session↔terminal correlation count (per-agent routing readiness) to the
 *  stream/push counters. */
export interface ServerPushDiagnostics extends ServerPushStats {
    /** Distinct sessions correlated to a terminal — >0 means per-agent routing is live. */
    sessionsCorrelated: number;
}

export function serverPushDiagnostics(): ServerPushDiagnostics {
    return { ...serverPushStats(), sessionsCorrelated: sessionTerminal.size };
}

/**
 * How often we heartbeat a long-blocking request so the client doesn't time
 * out. ~25s sits comfortably under the common 30–60s client idle windows.
 * Read per request (not memoised) so GENIE_MCP_HEARTBEAT_MS can drive tests
 * without a 25s wait.
 */
function heartbeatMs(): number {
    const n = Number(process.env.GENIE_MCP_HEARTBEAT_MS);
    return Number.isFinite(n) && n > 0 ? n : 25_000;
}

/**
 * True for a `tools/call` that may BLOCK on the user — so it gets the SSE
 * keepalive path (heartbeat) below instead of a single JSON response, and never
 * times the client out while it waits:
 *  - ForceTheQuestion always blocks on an answer.
 *  - manageProcess create/start can block on the per-workspace process-approval
 *    gate (when OFF the handler resolves immediately, so the SSE path just sends
 *    the response at once — harmless). stop/restart/list never block.
 *  - provisionWorkspaces `provision` can block on the ops-auto-provision gate
 *    (same harmless fast-path when the toggle is ON). `status` never blocks.
 *  - manageTerminals create/write can block on the per-workspace terminal-
 *    approval gate (OFF resolves immediately). read/list/kill never block.
 *  - runAgent start/send can block on the same gate. read/stop never block.
 */
function isBlockingCall(msg: JsonRpcRequest): boolean {
    if (msg.method !== 'tools/call') return false;
    const params = msg.params as
        | { name?: unknown; arguments?: { action?: unknown } }
        | undefined;
    const name = params?.name;
    if (name === 'ForceTheQuestion') return true;
    if (name === 'manageProcess') {
        const action = params?.arguments?.action;
        return action === 'create' || action === 'start';
    }
    if (name === 'provisionWorkspaces') {
        return params?.arguments?.action === 'provision';
    }
    if (name === 'manageTerminals') {
        const action = params?.arguments?.action;
        return action === 'create' || action === 'write';
    }
    if (name === 'runAgent') {
        const action = params?.arguments?.action;
        return action === 'start' || action === 'send';
    }
    if (name === 'agentinbox') {
        // Only a long-polling receive blocks; every other agentinbox action is a
        // quick synchronous op that gets a single JSON response.
        const args = params?.arguments as { action?: unknown; wait?: unknown } | undefined;
        return args?.action === 'receive' && args?.wait === true;
    }
    return false;
}

/** The client's progress token for this request, if it asked for progress. */
function progressTokenOf(msg: JsonRpcRequest): string | number | undefined {
    const t = (msg.params as { _meta?: { progressToken?: unknown } } | undefined)
        ?._meta?.progressToken;
    return typeof t === 'string' || typeof t === 'number' ? t : undefined;
}

/**
 * Respond to a long-blocking request over an SSE stream (the MCP Streamable
 * HTTP transport's other allowed response shape for a POSTed request). While
 * the handler is pending we emit a heartbeat every HEARTBEAT_MS — an SSE
 * comment line always (resets the client's socket/idle timer) plus a spec
 * `notifications/progress` when the client supplied a progressToken. Each beat
 * keeps the call alive, so an unanswered ForceTheQuestion never times out. When
 * the handler settles we send the JSON-RPC response as a final SSE event and
 * end the stream.
 */
async function sendBlockingViaSse(
    res: http.ServerResponse,
    msg: JsonRpcRequest,
    run: () => Promise<JsonRpcResponse | null>,
): Promise<void> {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '127.0.0.1',
    });

    // Guard every write: if the client (the agent) disconnected mid-wait the
    // socket is gone, but force-question.ts keeps the modal open — we just stop
    // writing rather than crash.
    const write = (chunk: string): void => {
        if (res.writableEnded || res.destroyed) return;
        try {
            res.write(chunk);
        } catch {
            /* socket went away — nothing to do */
        }
    };
    const sseMessage = (obj: unknown): void =>
        write(`event: message\ndata: ${JSON.stringify(obj)}\n\n`);

    // Open the stream immediately so the client sees bytes and commits to it.
    write(': open\n\n');

    const token = progressTokenOf(msg);
    let progress = 0;
    const beat = setInterval(() => {
        // Transport-level keepalive — a comment line carries no JSON-RPC
        // meaning but counts as activity, so the client's idle timeout resets.
        write(': heartbeat\n\n');
        // Spec-level progress, only when the client opted in with a token. The
        // total is left open-ended (we genuinely don't know when the user will
        // answer); the rising `progress` value satisfies the monotonic rule.
        if (token !== undefined) {
            progress += 1;
            sseMessage({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: {
                    progressToken: token,
                    progress,
                    message: 'Waiting for the user to answer…',
                },
            });
        }
    }, heartbeatMs());
    // Don't let the heartbeat keep the process alive on its own.
    if (typeof beat.unref === 'function') beat.unref();

    try {
        const response = await run();
        // The final JSON-RPC response rides the stream as the last event.
        if (response !== null) sseMessage(response);
    } finally {
        clearInterval(beat);
        if (!res.writableEnded) res.end();
    }
}

/**
 * Resolve which terminal a tool call should act on for a request that arrived
 * on a token. A per-terminal (legacy) token IS the terminal. A per-workspace
 * token resolves to the explicit `terminalId` arg if it's a valid member of
 * the workspace, else the workspace's most-recently-active terminal, else null.
 */
function resolveTerminal(
    token: string,
    argTerminalId: string | undefined,
): string | null {
    const direct = tokens.get(token);
    if (direct) return direct; // legacy per-terminal endpoint — unambiguous

    const workspaceId = workspaceTokens.get(token);
    if (!workspaceId || !deps) return null;
    const { ids } = deps.workspaceTerminals(workspaceId);

    // An explicit id must be a MEMBER of this token's workspace. A stale id from
    // elsewhere resolves to nothing rather than silently landing on a local
    // terminal — that would be the same wrong-pane bug by another route.
    if (argTerminalId) return ids.includes(argTerminalId) ? argTerminalId : null;

    // Exactly one terminal is not a guess; keep working for the common case.
    if (ids.length === 1) return ids[0];

    // Otherwise REFUSE. This used to fall back to the workspace's last-active
    // terminal, which is nondeterministic precisely when orchestration is busy —
    // "last active" is whatever some other agent touched most recently. Since
    // `agentinbox` mints an agent's durable identity onto whatever resolves here,
    // that fallback could attach identity to a stranger's pane (genie#17). Every
    // pty carries GENIE_TERMINAL_ID, so a caller that lands here needs fixing.
    return null;
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
    const token = m[1];
    // The token must resolve to either a terminal (legacy) or a workspace.
    if (!tokens.has(token) && !workspaceTokens.has(token)) {
        send(res, 404, { error: 'unknown endpoint' });
        return;
    }
    // GET opens the server->client SSE stream (MCP Streamable HTTP §"Listening
    // for Messages from the Server"). Previously 405 — additive, so no existing
    // client behaviour changes. PROBE: log every open so we can see whether a
    // real client connects and whether it echoes the Mcp-Session-Id from
    // initialize (the per-agent routing key).
    if (req.method === 'GET') {
        openGetStream(req, res, token, { heartbeatMs: heartbeatMs(), log: logGetStream });
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

    // Per-call terminal resolution: the tool's `terminalId` arg picks the target.
    // Ambiguity is an ERROR, never a guess — see resolveTerminal.
    const argTerminalId = ((msg.params as { arguments?: { terminalId?: unknown } })
        ?.arguments?.terminalId);
    const resolved = resolveTerminal(
        token,
        typeof argTerminalId === 'string' ? argTerminalId : undefined,
    );
    if (resolved === null && msg.method === 'tools/call') {
        // Actionable on purpose: name the env var that fixes it. Silently acting
        // on the wrong terminal is worse than a call the agent can retry.
        send(res, 200, {
            jsonrpc: '2.0',
            id: msg.id ?? null,
            error: {
                code: -32602,
                message:
                    'Could not determine which terminal to act on. Pass `terminalId` — ' +
                    'its value is in your GENIE_TERMINAL_ID environment variable. ' +
                    '(This workspace has several terminals, or the id given is not one ' +
                    'of them, so Genie will not guess.)',
            },
        });
        return;
    }
    const terminalId = resolved ?? '';

    // Correlate the client-echoed session id with the terminal it's acting as, so
    // a DM to this agent can push to exactly its GET stream. Also the live
    // measurement of whether the client echoes Mcp-Session-Id on POSTs at all.
    const sid = req.headers['mcp-session-id'];
    if (typeof sid === 'string' && terminalId && msg.method === 'tools/call') {
        if (sessionTerminal.get(sid) !== terminalId) {
            sessionTerminal.set(sid, terminalId);
            // eslint-disable-next-line no-console
            console.log(
                `[mcp-get-stream] session ${sid.slice(0, 8)}… ↔ terminal ${terminalId}`,
            );
        }
    }

    const mcpCtx = {
        terminalId,
        serverName: SERVER_NAME,
        serverVersion: deps.serverVersion,
        onImDone: deps.onImDone,
        checkIssues: deps.checkIssues,
        agentInboxMailLine: deps.agentInboxMailLine,
        onForceQuestion: deps.onForceQuestion,
        describeWorkspace: deps.describeWorkspace,
        manageProcess: deps.manageProcess,
        provisionWorkspaces: deps.provisionWorkspaces,
        manageTerminals: deps.manageTerminals,
        runAgent: deps.runAgent,
        manageWorkspaces: deps.manageWorkspaces,
        agentInbox: deps.agentInbox,
        knowledge: deps.knowledge,
        openFileForUser: deps.openFileForUser,
        setEnv: deps.setEnv,
        checkEnv: deps.checkEnv,
        isOpsProject: deps.isOpsProject,
        pluginTools: deps.pluginTools,
        dispatchPluginTool: deps.dispatchPluginTool,
    };

    // A blocking call (ForceTheQuestion) can sit pending indefinitely while the
    // user decides. Answer it over an SSE stream with a heartbeat so the MCP
    // client never times the request out; everything else gets a single JSON
    // response as before.
    if (isBlockingCall(msg)) {
        await sendBlockingViaSse(res, msg, () => handleMcpMessage(msg, mcpCtx));
        return;
    }

    const response = await handleMcpMessage(msg, mcpCtx);
    // Notifications get a 202 with no body; requests get their JSON-RPC result.
    if (response === null) {
        send(res, 202);
        return;
    }
    if (msg.method === 'initialize') {
        // Hand the client a session id it can echo on the GET stream (PROBE —
        // additive header; unknown to older clients, honoured by compliant ones).
        send(res, 200, response, { 'Mcp-Session-Id': mintSessionId(token) });
        return;
    }
    send(res, 200, response);
}

/**
 * Bind the server on `wantPort`, falling back to an ephemeral port (and
 * flagging a conflict) if it's taken. Resolves once listening (or once we've
 * given up — best-effort feature). Restores persisted tokens first.
 */
function bind(wantPort: number): Promise<void> {
    const prev = loadState();
    tokens.clear();
    byTerminal.clear();
    workspaceTokens.clear();
    byWorkspace.clear();
    for (const [t, id] of Object.entries(prev.tokens)) {
        tokens.set(t, id);
        byTerminal.set(id, t);
    }
    for (const [t, id] of Object.entries(prev.workspaceTokens)) {
        workspaceTokens.set(t, id);
        byWorkspace.set(id, t);
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
        const listen = (tryPort: number, isConfigured: boolean) => {
            const s = makeServer();
            s.once('error', (e: NodeJS.ErrnoException) => {
                // Configured port taken → fall back to an ephemeral port and
                // flag the conflict so Settings can prompt a restart. The baked
                // URLs carry the configured port, so they won't resolve on the
                // fallback — but the user is told, and a restart on a freed
                // port fixes it.
                if (e.code === 'EADDRINUSE' && tryPort !== 0) {
                    conflict = true;
                    listen(0, false);
                } else {
                    done(); // give up; no MCP this run
                }
            });
            s.listen(tryPort, '127.0.0.1', () => {
                server = s;
                const addr = s.address();
                port = typeof addr === 'object' && addr ? addr.port : null;
                if (isConfigured) conflict = false;
                persistState();
                done();
            });
        };
        listen(wantPort > 0 ? wantPort : 0, wantPort > 0);
    });
}

/** Start the loopback MCP server (idempotent). Resolves once listening. */
export function startMcpServer(d: ServerDeps): Promise<void> {
    deps = d;
    if (server) return Promise.resolve();
    conflict = false;
    return bind(d.configuredPort());
}

/**
 * Stop the server and re-bind on the currently-configured port. Used by the
 * Settings "Restart MCP server" action after the user changes `mcp_port`.
 * Tokens are restored from state so existing endpoints keep resolving (and on
 * a fresh free port the conflict clears). Resolves once re-listening.
 */
export async function restartMcpServer(): Promise<void> {
    if (!deps) return;
    if (server) {
        await new Promise<void>((r) => server!.close(() => r()));
        server = null;
        port = null;
    }
    conflict = false;
    await bind(deps.configuredPort());
}

export function stopMcpServer(): void {
    closeAllStreams();
    server?.close();
    server = null;
    port = null;
    conflict = false;
    tokens.clear();
    byTerminal.clear();
    workspaceTokens.clear();
    byWorkspace.clear();
    sessionToken.clear();
    sessionTerminal.clear();
}

/**
 * Mint (or reuse) the STABLE per-workspace endpoint URL, or null if the server
 * isn't listening. This is the URL baked into a workspace's `.mcp.json` — a
 * hard-coded literal, no env expansion. Idempotent per workspace id.
 */
export function workspaceEndpointUrl(workspaceId: string): string | null {
    if (port === null) return null;
    let token = byWorkspace.get(workspaceId);
    if (!token) {
        token = crypto.randomBytes(18).toString('hex');
        workspaceTokens.set(token, workspaceId);
        byWorkspace.set(workspaceId, token);
        persistState();
    }
    return `http://127.0.0.1:${port}/mcp/${token}`;
}

/**
 * Mint (or reuse) a per-terminal endpoint and return its full URL, or null if
 * the server isn't listening yet. Idempotent per terminal id. Retained for the
 * GENIE_MCP_URL env injection + backwards-compat with already-issued URLs.
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

/** Server status for Settings → Agent MCP. */
export interface McpServerState {
    running: boolean;
    /** The port actually bound (null when not running). */
    port: number | null;
    /** The port the user configured (what we TRY to bind). */
    configuredPort: number;
    /** True when the configured port was taken and we fell back to ephemeral. */
    conflict: boolean;
}
export function mcpServerState(): McpServerState {
    return {
        running: server !== null,
        port,
        configuredPort: deps?.configuredPort() ?? DEFAULT_MCP_PORT,
        conflict,
    };
}
