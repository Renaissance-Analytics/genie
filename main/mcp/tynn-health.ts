/**
 * "Can the agents in this workspace actually reach Tynn — and if not, WHY?"
 *
 * ## The incident this exists for
 *
 * A workspace's `.mcp.json` carried `http://tynn.ai/mcp/tynn` instead of
 * `https://`. Plain http answers **301**. An MCP client follows the redirect,
 * and a followed redirect turns the **POST into a GET** — which `laravel/mcp`
 * answers with a hardcoded **405**. Every agent in that workspace could neither
 * connect nor list a single tool, and the only thing anybody ever saw was
 * "error 405". Genie showed nothing at all. One character.
 *
 * So this module does not report "failed". Each of the three rows it produces
 * carries the CAUSE and the FIX, and the redirect/405 pair above is named
 * explicitly, because that is the failure a human cannot diagnose from the
 * symptom.
 *
 * ## Three rows, because there are three different things to be wrong
 *
 *   - **transport** — did the endpoint answer a POST at all? (redirect / 405 /
 *     DNS / TLS / 5xx). A url problem.
 *   - **auth** — did the bearer token in `.mcp.json` get accepted? (401/403).
 *     A token problem, fixed by reconnecting the workspace.
 *   - **permission** — what did `tools/list` return? That list IS the
 *     permission surface: it is exactly what this token may call. Zero tools is
 *     a connected agent that sees Tynn as empty — a different bug from "cannot
 *     connect", and one that also used to be invisible.
 *
 * ## Read-only, because the endpoint is PRODUCTION
 *
 * The workspace's Tynn MCP points at the user's real work-management. The probe
 * therefore issues exactly {@link READ_ONLY_PROBE_METHODS} — `initialize` and
 * `tools/list` — and never a `tools/call`. A health check must not be able to
 * create, update or touch a work item.
 *
 * ## Never throws
 *
 * Same contract as `dev-server/runtime-detect.ts`: an unreachable Tynn is an
 * ordinary state to REPORT, and an exception escaping a probe is precisely how
 * that ordinary state becomes a crash in whichever handler called it. All
 * judgement is pure and the HTTP sits behind {@link TynnProbeHttp}, so every
 * branch below is tested without touching the network.
 */

/** The ONLY JSON-RPC methods the probe is allowed to send. */
export const READ_ONLY_PROBE_METHODS = ['initialize', 'tools/list'] as const;

export type TransportState =
    | 'ok'
    /** Answered, but over plain http:// — one redirect away from the incident. */
    | 'insecure'
    | 'redirect'
    | 'method-not-allowed'
    | 'unreachable'
    | 'bad-response'
    /** No `tynn` server in this workspace's `.mcp.json`. */
    | 'not-configured'
    /** Not tested — something earlier made the answer meaningless. */
    | 'unknown';

export type AuthState = 'ok' | 'unauthorized' | 'no-token' | 'unknown';
export type PermissionState = 'ok' | 'none' | 'error' | 'unknown';
export type TynnHealthState = 'healthy' | 'degraded' | 'broken' | 'unconfigured' | 'checking';

/** How a row should read at a glance: green / amber / red / not-known. */
export type HealthTone = 'ok' | 'warn' | 'bad' | 'idle';

interface RowBase {
    /** False only for a HARD failure — `insecure` is a warning, not a failure. */
    ok: boolean;
    tone: HealthTone;
    /** One glanceable line. */
    label: string;
    /** The cause AND the fix — never just "failed". */
    detail: string;
}

export interface TransportRow extends RowBase {
    state: TransportState;
}
export interface AuthRow extends RowBase {
    state: AuthState;
}
export interface PermissionRow extends RowBase {
    state: PermissionState;
    /** The tool names `tools/list` returned — the permission surface itself. */
    tools: string[];
    count: number;
}

export interface TynnHealth {
    workspaceId: string;
    workspaceName: string;
    /** The resolved url from `.mcp.json`, or null when unconfigured. */
    url: string | null;
    state: TynnHealthState;
    checkedAt: number;
    transport: TransportRow;
    auth: AuthRow;
    permission: PermissionRow;
}

/** What one HTTP attempt came back as. A network failure is an ANSWER, not a throw. */
export type HttpObservation =
    | { kind: 'response'; status: number; headers: Record<string, string>; bodyText: string }
    | { kind: 'error'; message: string };

/** The injected HTTP seam — resolves, never rejects (the probe guards anyway). */
export interface TynnProbeHttp {
    post(
        url: string,
        headers: Record<string, string>,
        body: string,
    ): Promise<HttpObservation>;
}

// --- body parsing ----------------------------------------------------------

/**
 * Read a JSON-RPC response out of a body that may be EITHER `application/json`
 * or an SSE stream.
 *
 * The MCP streamable-HTTP transport is free to answer a POST with
 * `text/event-stream` (and `laravel/mcp` does when the client accepts it), so a
 * bare `JSON.parse` would report a perfectly healthy server as "bad response".
 * The last `data:` frame is the reply to the request we sent.
 *
 * Returns null for anything that is not a JSON object — an HTML error page, an
 * empty body — so callers can say "the server answered, but not with MCP".
 */
export function parseJsonRpcBody(text: string): Record<string, unknown> | null {
    const raw = (text ?? '').trim();
    if (!raw) return null;

    const dataFrames = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim());

    const candidates = dataFrames.length ? dataFrames : [raw];
    let last: Record<string, unknown> | null = null;
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                last = parsed as Record<string, unknown>;
            }
        } catch {
            /* not this frame — keep whatever earlier frame parsed */
        }
    }
    return last;
}

// --- url helpers -----------------------------------------------------------

function parseUrl(url: string): URL | null {
    try {
        return new URL(url);
    } catch {
        return null;
    }
}

function hostOf(url: string | null): string {
    return (url && parseUrl(url)?.host) || 'the Tynn host';
}

/** The corrected url to PRESCRIBE — the same endpoint over https. */
export function httpsVariant(url: string): string {
    return url.replace(/^http:\/\//i, 'https://');
}

/**
 * True for an http url pointed at THIS machine. A loopback server has no https
 * to be redirected to, so "you are on plain http" would be noise there.
 */
export function isLoopbackHttp(url: string): boolean {
    const parsed = parseUrl(url);
    if (!parsed || parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    return (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host === '::1' ||
        /^127\./.test(host)
    );
}

function isPlainHttp(url: string): boolean {
    return parseUrl(url)?.protocol === 'http:';
}

function header(headers: Record<string, string> | undefined, name: string): string {
    if (!headers) return '';
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === wanted) return value;
    }
    return '';
}

// --- classification --------------------------------------------------------

export interface ClassifyInput {
    workspaceId: string;
    workspaceName: string;
    url: string | null;
    token: string | null;
    /** The `initialize` attempt. Absent when it was never made. */
    initialize?: HttpObservation;
    /** The `tools/list` attempt. Absent when the handshake never got that far. */
    toolsList?: HttpObservation;
    checkedAt?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function transportRow(input: ClassifyInput): TransportRow {
    const { url, initialize } = input;

    if (!url) {
        return {
            state: 'not-configured',
            ok: false,
            tone: 'idle',
            label: 'No Tynn server configured',
            detail:
                "This workspace has no `tynn` server in its .mcp.json, so no agent here can " +
                'reach Tynn at all. Connect the workspace to a Tynn project to provision one.',
        };
    }

    if (!initialize) {
        return {
            state: 'unknown',
            ok: false,
            tone: 'idle',
            label: 'Not checked',
            detail: 'The endpoint was not contacted, so nothing is known about it yet.',
        };
    }

    if (initialize.kind === 'error') {
        return {
            state: 'unreachable',
            ok: false,
            tone: 'bad',
            label: `Cannot reach ${hostOf(url)}`,
            detail:
                `Could not reach ${hostOf(url)}: ${initialize.message}. Check the url in this ` +
                `workspace's .mcp.json, and that this machine has DNS and network access to ` +
                `${hostOf(url)}.`,
        };
    }

    const { status, headers } = initialize;

    if (REDIRECT_STATUSES.has(status)) {
        const target = header(headers, 'location') || httpsVariant(url);
        return {
            state: 'redirect',
            ok: false,
            tone: 'bad',
            label: `${status} redirect — agents get 405`,
            detail:
                `The endpoint answered ${status} and redirected to ${target}. An MCP client ` +
                'FOLLOWS that redirect, and a followed redirect turns the POST into a GET — ' +
                'which laravel/mcp answers with a hardcoded 405, so agents here can neither ' +
                'connect nor list a single tool. Fix: change the `tynn` url in this ' +
                `workspace's .mcp.json to ${httpsVariant(url)}.`,
        };
    }

    if (status === 405) {
        // The SAME incident seen one hop later: whatever produced this turned
        // our POST into a GET. Only blame http:// when the url actually is.
        const detail = isPlainHttp(url)
            ? 'The endpoint answered 405 Method Not Allowed. laravel/mcp only answers a POST, ' +
              'so a 405 means the POST arrived as a GET — which is exactly what happens when a ' +
              'plain-http url is redirected to https and the client follows it. Fix: change the ' +
              `\`tynn\` url in this workspace's .mcp.json to ${httpsVariant(url)}.`
            : 'The endpoint answered 405 Method Not Allowed. laravel/mcp only answers a POST ' +
              `there, so something in front of ${hostOf(url)} turned this POST into a GET — ` +
              'look for a proxy or a redirect on that host, and check the path really is the ' +
              '/mcp/<server> endpoint.';
        return {
            state: 'method-not-allowed',
            ok: false,
            tone: 'bad',
            label: '405 Method Not Allowed',
            detail,
        };
    }

    // 401/403 ARE a valid transport answer — the endpoint is right, the token
    // is not. That distinction is the whole reason auth is its own row.
    if (status === 401 || status === 403) {
        return {
            state: 'ok',
            ok: true,
            tone: 'ok',
            label: `Reached ${hostOf(url)}`,
            detail: `The endpoint answered a POST — the url is right (see the token row below).`,
        };
    }

    if (status < 200 || status >= 300) {
        return {
            state: 'bad-response',
            ok: false,
            tone: 'bad',
            label: `${status} from ${hostOf(url)}`,
            detail:
                `The endpoint answered ${status}, which is not an MCP response. If this is a 5xx ` +
                `the Tynn server itself is unhealthy; a 404 means the url points at the wrong ` +
                `path — the endpoint is /mcp/<server>. Check the \`tynn\` url in this workspace's ` +
                '.mcp.json.',
        };
    }

    if (!parseJsonRpcBody(initialize.bodyText)) {
        return {
            state: 'bad-response',
            ok: false,
            tone: 'bad',
            label: 'Not an MCP endpoint',
            detail:
                `${hostOf(url)} answered ${status}, but the body is not a JSON-RPC message — this ` +
                'url is not an MCP endpoint. Check the `tynn` url in this ' +
                "workspace's .mcp.json points at /mcp/<server>.",
        };
    }

    if (isPlainHttp(url) && !isLoopbackHttp(url)) {
        return {
            state: 'insecure',
            ok: true,
            tone: 'warn',
            label: 'Connected over plain http://',
            detail:
                'The endpoint answers, but over plain http://. This is one server-side redirect ' +
                'away from silently breaking every agent here: a redirect turns the POST into a ' +
                'GET and laravel/mcp answers 405. Change the `tynn` url in this ' +
                `workspace's .mcp.json to ${httpsVariant(url)}.`,
        };
    }

    return {
        state: 'ok',
        ok: true,
        tone: 'ok',
        label: `Reached ${hostOf(url)}`,
        detail: 'The endpoint answered a POST with a JSON-RPC message.',
    };
}

function authRow(input: ClassifyInput, transport: TransportRow): AuthRow {
    if (input.url && !input.token) {
        return {
            state: 'no-token',
            ok: false,
            tone: 'bad',
            label: 'No bearer token',
            detail:
                "The `tynn` entry in this workspace's .mcp.json has no literal " +
                '`Authorization: Bearer <token>` header, so every agent call arrives ' +
                'unauthenticated. Reconnect the workspace to Tynn to provision a token.',
        };
    }

    if (transport.state !== 'ok' && transport.state !== 'insecure') {
        return {
            state: 'unknown',
            ok: false,
            tone: 'idle',
            label: 'Not checked',
            detail: 'The endpoint never answered, so the token was never tested.',
        };
    }

    const init = input.initialize;
    if (init?.kind === 'response' && (init.status === 401 || init.status === 403)) {
        return {
            state: 'unauthorized',
            ok: false,
            tone: 'bad',
            label: `Token rejected (${init.status})`,
            detail:
                `Tynn rejected the bearer token with ${init.status}. The token in this ` +
                "workspace's .mcp.json is not valid for this Tynn project — reconnect the " +
                'workspace to Tynn to mint a fresh agent token.',
        };
    }

    return {
        state: 'ok',
        ok: true,
        tone: 'ok',
        label: 'Token accepted',
        detail: 'Tynn accepted the bearer token for this project.',
    };
}

function permissionRow(input: ClassifyInput, auth: AuthRow): PermissionRow {
    const idle = (label: string, detail: string): PermissionRow => ({
        state: 'unknown',
        ok: false,
        tone: 'idle',
        label,
        detail,
        tools: [],
        count: 0,
    });

    if (auth.state !== 'ok') {
        return idle('Not checked', 'The token was not accepted, so its tools were never listed.');
    }

    const observation = input.toolsList;
    if (!observation) {
        return idle('Not checked', 'tools/list was not called.');
    }

    const fail = (label: string, detail: string): PermissionRow => ({
        state: 'error',
        ok: false,
        tone: 'bad',
        label,
        detail,
        tools: [],
        count: 0,
    });

    if (observation.kind === 'error') {
        return fail('tools/list failed', `tools/list could not be sent: ${observation.message}.`);
    }
    if (observation.status < 200 || observation.status >= 300) {
        return fail(
            `tools/list answered ${observation.status}`,
            `tools/list answered ${observation.status}. The handshake succeeded, so this is the ` +
                'Tynn server failing on the listing itself rather than a url or token problem.',
        );
    }

    const body = parseJsonRpcBody(observation.bodyText);
    if (!body) {
        return fail(
            'tools/list gave no MCP reply',
            'tools/list answered, but the body is not a JSON-RPC message.',
        );
    }

    const rpcError = body.error as { message?: unknown } | undefined;
    if (rpcError) {
        const message =
            typeof rpcError.message === 'string' ? rpcError.message : JSON.stringify(rpcError);
        return fail('tools/list returned an error', `Tynn answered tools/list with: ${message}.`);
    }

    const result = (body.result ?? {}) as { tools?: unknown };
    const tools = Array.isArray(result.tools)
        ? result.tools
              .map((t) => (t && typeof t === 'object' ? (t as { name?: unknown }).name : null))
              .filter((n): n is string => typeof n === 'string' && !!n)
        : [];

    if (!tools.length) {
        return {
            state: 'none',
            ok: false,
            tone: 'warn',
            label: '0 tools available',
            detail:
                'Connected and authenticated, but Tynn returned no tools for this token — so an ' +
                'agent here sees Tynn as empty. The tool list IS the permission surface: check ' +
                "this token's scopes and the agent's access to the project.",
            tools: [],
            count: 0,
        };
    }

    return {
        state: 'ok',
        ok: true,
        tone: 'ok',
        label: `${tools.length} tools available`,
        detail: `This token may call: ${tools.join(', ')}.`,
        tools,
        count: tools.length,
    };
}

function overallState(
    url: string | null,
    transport: TransportRow,
    auth: AuthRow,
    permission: PermissionRow,
): TynnHealthState {
    if (!url) return 'unconfigured';
    if (!transport.ok || !auth.ok || permission.state === 'error') return 'broken';
    if (transport.state === 'insecure' || permission.state === 'none') return 'degraded';
    if (permission.state !== 'ok') return 'broken';
    return 'healthy';
}

/**
 * The pure judgement: raw observations in, the three explained rows + an overall
 * state out. Everything a human reads about Tynn health is decided HERE, so it
 * is all reachable from a unit test with no network and no DOM.
 */
export function classifyTynnHealth(input: ClassifyInput): TynnHealth {
    const transport = transportRow(input);
    const auth = authRow(input, transport);
    const permission = permissionRow(input, auth);
    return {
        workspaceId: input.workspaceId,
        workspaceName: input.workspaceName,
        url: input.url,
        state: overallState(input.url, transport, auth, permission),
        checkedAt: input.checkedAt ?? Date.now(),
        transport,
        auth,
        permission,
    };
}

// --- the probe -------------------------------------------------------------

export interface ProbeInput {
    workspaceId: string;
    workspaceName: string;
    url: string | null;
    token: string | null;
    http: TynnProbeHttp;
    now?: () => number;
}

/** MCP's streamable HTTP transport: a server may answer with either of these. */
const ACCEPT = 'application/json, text/event-stream';

function rpc(id: number, method: (typeof READ_ONLY_PROBE_METHODS)[number], params: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

/** Resolve one attempt, turning ANY throw from the seam into an observation. */
async function attempt(
    http: TynnProbeHttp,
    url: string,
    headers: Record<string, string>,
    body: string,
): Promise<HttpObservation> {
    try {
        return await http.post(url, headers, body);
    } catch (e) {
        return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * Probe one workspace's Tynn MCP endpoint. Read-only, never throws, and makes NO
 * request at all when there is nothing configured to probe.
 */
export async function probeTynnMcp(input: ProbeInput): Promise<TynnHealth> {
    const { url, token, http } = input;
    const checkedAt = (input.now ?? Date.now)();
    const base = {
        workspaceId: input.workspaceId,
        workspaceName: input.workspaceName,
        url,
        token,
        checkedAt,
    };

    // Nothing configured, or nothing to authenticate with: there is no question
    // the network could answer, so don't ask it one.
    if (!url || !token) return classifyTynnHealth(base);

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: ACCEPT,
        Authorization: `Bearer ${token}`,
    };

    const initialize = await attempt(
        http,
        url,
        headers,
        rpc(1, 'initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'genie-tynn-health', version: '1' },
        }),
    );

    // A transport that never answered makes tools/list meaningless — and a
    // second request to a dead/redirecting endpoint buys nothing.
    const probe = classifyTynnHealth({ ...base, initialize });
    if (probe.transport.state !== 'ok' && probe.transport.state !== 'insecure') return probe;
    if (probe.auth.state !== 'ok') return probe;

    // The streamable transport binds the handshake to a session id; carry it.
    const sessionId =
        initialize.kind === 'response' ? header(initialize.headers, 'mcp-session-id') : '';
    const toolsList = await attempt(
        http,
        url,
        sessionId ? { ...headers, 'Mcp-Session-Id': sessionId } : headers,
        rpc(2, 'tools/list', {}),
    );

    return classifyTynnHealth({ ...base, initialize, toolsList });
}

// --- the real HTTP ---------------------------------------------------------

/** A health check must not hang a workspace open. */
const PROBE_TIMEOUT_MS = 12_000;

/**
 * The production seam. `redirect: 'manual'` is the load-bearing option: the
 * default follows redirects, which is exactly how the original incident hid —
 * the probe would have seen the same 405 as the agents did, with no clue that a
 * 301 caused it. Manual keeps the 301 visible so we can NAME it.
 */
export const defaultTynnProbeHttp: TynnProbeHttp = {
    async post(url, headers, body) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body,
                redirect: 'manual',
                signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            });
            const collected: Record<string, string> = {};
            response.headers.forEach((value, key) => {
                collected[key] = value;
            });
            let bodyText = '';
            try {
                bodyText = await response.text();
            } catch {
                /* an opaque/empty body is still an observation */
            }
            return { kind: 'response', status: response.status, headers: collected, bodyText };
        } catch (e) {
            return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
        }
    },
};
