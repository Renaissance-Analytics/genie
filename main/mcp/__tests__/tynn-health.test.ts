import { describe, expect, it, vi } from 'vitest';
import {
    classifyTynnHealth,
    parseJsonRpcBody,
    probeTynnMcp,
    READ_ONLY_PROBE_METHODS,
    type HttpObservation,
    type TynnProbeHttp,
} from '../tynn-health';

const WS = { workspaceId: 'ws1', workspaceName: 'tynn.ai' };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): HttpObservation {
    return { kind: 'response', status, headers, bodyText: JSON.stringify(body) };
}

const INIT_OK = jsonResponse(200, {
    jsonrpc: '2.0',
    id: 1,
    result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'tynn' } },
});

function toolsOk(names: string[]): HttpObservation {
    return jsonResponse(200, {
        jsonrpc: '2.0',
        id: 2,
        result: { tools: names.map((name) => ({ name, description: `${name} tool` })) },
    });
}

describe('parseJsonRpcBody', () => {
    it('parses a plain application/json body', () => {
        expect(parseJsonRpcBody('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')).toEqual({
            jsonrpc: '2.0',
            id: 1,
            result: { ok: true },
        });
    });

    it('parses the JSON out of an SSE frame — the streamable-HTTP transport answers with one', () => {
        const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n';
        expect(parseJsonRpcBody(sse)).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [] } });
    });

    it('takes the LAST data frame when a stream carries several', () => {
        const sse =
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"first":true}}\n\n' +
            'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"last":true}}\n\n';
        expect(parseJsonRpcBody(sse)).toEqual({ jsonrpc: '2.0', id: 2, result: { last: true } });
    });

    it('returns null for a body that is not JSON-RPC at all (an HTML error page)', () => {
        expect(parseJsonRpcBody('<!doctype html><html><body>405</body></html>')).toBeNull();
        expect(parseJsonRpcBody('')).toBeNull();
    });
});

describe('classifyTynnHealth — transport', () => {
    it('names the http-to-https REDIRECT, its 405 consequence, and the exact fix', () => {
        const health = classifyTynnHealth({
            ...WS,
            url: 'http://tynn.ai/mcp/tynn',
            token: 'tok',
            initialize: {
                kind: 'response',
                status: 301,
                headers: { location: 'https://tynn.ai/mcp/tynn' },
                bodyText: '',
            },
        });

        expect(health.state).toBe('broken');
        expect(health.transport.state).toBe('redirect');
        expect(health.transport.ok).toBe(false);
        // The whole point of this indicator: the popover must explain the
        // mechanism (POST becomes GET, laravel/mcp answers 405) and give the
        // literal corrected URL, not just say "failed".
        expect(health.transport.detail).toContain('301');
        expect(health.transport.detail).toContain('GET');
        expect(health.transport.detail).toContain('405');
        expect(health.transport.detail).toContain('https://tynn.ai/mcp/tynn');
        expect(health.transport.detail).toContain('.mcp.json');
        // Downstream rows can't be known once the transport never answered.
        expect(health.auth.state).toBe('unknown');
        expect(health.permission.state).toBe('unknown');
    });

    it('reads a bare 405 as the same incident and still prescribes https://', () => {
        const health = classifyTynnHealth({
            ...WS,
            url: 'http://tynn.ai/mcp/tynn',
            token: 'tok',
            initialize: { kind: 'response', status: 405, headers: {}, bodyText: 'Method Not Allowed' },
        });

        expect(health.state).toBe('broken');
        expect(health.transport.state).toBe('method-not-allowed');
        expect(health.transport.detail).toContain('405');
        expect(health.transport.detail).toContain('https://tynn.ai/mcp/tynn');
    });

    it('does NOT blame http:// for a 405 on a url that is already https', () => {
        const health = classifyTynnHealth({
            ...WS,
            url: 'https://tynn.ai/mcp/tynn',
            token: 'tok',
            initialize: { kind: 'response', status: 405, headers: {}, bodyText: '' },
        });

        expect(health.transport.state).toBe('method-not-allowed');
        // Blaming http:// here would send the reader to change a url that is
        // already https — the advice must be about what is actually in front of
        // this host instead. ('https://' does not contain 'http://'.)
        expect(health.transport.detail).not.toContain('http://');
        expect(health.transport.detail).toContain('/mcp/');
    });

    it('reports an unreachable host with the host name in the detail', () => {
        const health = classifyTynnHealth({
            ...WS,
            url: 'https://tynn.invalid/mcp/tynn',
            token: 'tok',
            initialize: { kind: 'error', message: 'getaddrinfo ENOTFOUND tynn.invalid' },
        });

        expect(health.state).toBe('broken');
        expect(health.transport.state).toBe('unreachable');
        expect(health.transport.detail).toContain('tynn.invalid');
        expect(health.transport.detail).toContain('ENOTFOUND');
    });

    it('reports a 5xx as a bad response rather than an auth or permission problem', () => {
        const health = classifyTynnHealth({
            ...WS,
            url: 'https://tynn.ai/mcp/tynn',
            token: 'tok',
            initialize: { kind: 'response', status: 502, headers: {}, bodyText: 'Bad Gateway' },
        });

        expect(health.state).toBe('broken');
        expect(health.transport.state).toBe('bad-response');
        expect(health.transport.detail).toContain('502');
        expect(health.auth.state).toBe('unknown');
    });

    it('flags a plain-http url that DOES answer as insecure — degraded, not healthy', () => {
        const health = classifyTynnHealth({
            ...WS,
            url: 'http://tynn.ai/mcp/tynn',
            token: 'tok',
            initialize: INIT_OK,
            toolsList: toolsOk(['project', 'find']),
        });

        expect(health.transport.state).toBe('insecure');
        expect(health.state).toBe('degraded');
        expect(health.transport.detail).toContain('https://tynn.ai/mcp/tynn');
    });

    it('leaves a LOOPBACK http url alone — a local server has no https to redirect to', () => {
        const health = classifyTynnHealth({
            ...WS,
            url: 'http://127.0.0.1:8787/mcp/tynn',
            token: 'tok',
            initialize: INIT_OK,
            toolsList: toolsOk(['project']),
        });

        expect(health.transport.state).toBe('ok');
        expect(health.state).toBe('healthy');
    });
});

describe('classifyTynnHealth — auth', () => {
    it('reads 401 as an invalid token for this project and says how to fix it', () => {
        const health = classifyTynnHealth({
            ...WS,
            url: 'https://tynn.ai/mcp/tynn',
            token: 'tok',
            initialize: { kind: 'response', status: 401, headers: {}, bodyText: 'Unauthenticated.' },
        });

        expect(health.state).toBe('broken');
        expect(health.transport.state).toBe('ok');
        expect(health.auth.state).toBe('unauthorized');
        expect(health.auth.detail).toContain('401');
        expect(health.auth.detail.toLowerCase()).toContain('reconnect');
        expect(health.permission.state).toBe('unknown');
    });

    it('reads 403 as an auth failure too', () => {
        const health = classifyTynnHealth({
            ...WS,
            url: 'https://tynn.ai/mcp/tynn',
            token: 'tok',
            initialize: { kind: 'response', status: 403, headers: {}, bodyText: 'Forbidden' },
        });

        expect(health.auth.state).toBe('unauthorized');
        expect(health.auth.detail).toContain('403');
    });

    it('reports a MISSING token without pretending the transport was tested', () => {
        const health = classifyTynnHealth({
            ...WS,
            url: 'https://tynn.ai/mcp/tynn',
            token: null,
        });

        expect(health.state).toBe('broken');
        expect(health.auth.state).toBe('no-token');
        expect(health.auth.detail).toContain('.mcp.json');
        expect(health.transport.state).toBe('unknown');
    });
});

describe('classifyTynnHealth — permission', () => {
    it('lists the tool names tools/list returned and counts them', () => {
        const health = classifyTynnHealth({
            ...WS,
            url: 'https://tynn.ai/mcp/tynn',
            token: 'tok',
            initialize: INIT_OK,
            toolsList: toolsOk(['project', 'find', 'create', 'update']),
        });

        expect(health.state).toBe('healthy');
        expect(health.permission.state).toBe('ok');
        expect(health.permission.tools).toEqual(['project', 'find', 'create', 'update']);
        expect(health.permission.count).toBe(4);
        expect(health.permission.label).toContain('4');
    });

    it('treats a connected token with ZERO tools as degraded, not healthy', () => {
        const health = classifyTynnHealth({
            ...WS,
            url: 'https://tynn.ai/mcp/tynn',
            token: 'tok',
            initialize: INIT_OK,
            toolsList: toolsOk([]),
        });

        expect(health.state).toBe('degraded');
        expect(health.permission.state).toBe('none');
        expect(health.permission.count).toBe(0);
        expect(health.permission.detail.toLowerCase()).toContain('no tools');
    });

    it('surfaces a JSON-RPC error from tools/list instead of reporting zero tools', () => {
        const health = classifyTynnHealth({
            ...WS,
            url: 'https://tynn.ai/mcp/tynn',
            token: 'tok',
            initialize: INIT_OK,
            toolsList: jsonResponse(200, {
                jsonrpc: '2.0',
                id: 2,
                error: { code: -32601, message: 'Method not found' },
            }),
        });

        expect(health.state).toBe('broken');
        expect(health.permission.state).toBe('error');
        expect(health.permission.detail).toContain('Method not found');
    });
});

describe('classifyTynnHealth — unconfigured', () => {
    it('says the workspace has no tynn server rather than calling it broken', () => {
        const health = classifyTynnHealth({ ...WS, url: null, token: null });

        expect(health.state).toBe('unconfigured');
        expect(health.transport.state).toBe('not-configured');
        expect(health.url).toBeNull();
        expect(health.transport.detail).toContain('.mcp.json');
    });
});

describe('probeTynnMcp', () => {
    function recordingHttp(responses: HttpObservation[]): {
        http: TynnProbeHttp;
        calls: Array<{ url: string; headers: Record<string, string>; body: string }>;
    } {
        const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
        let i = 0;
        return {
            calls,
            http: {
                async post(url, headers, body) {
                    calls.push({ url, headers, body });
                    return responses[i++] ?? { kind: 'error', message: 'no scripted response' };
                },
            },
        };
    }

    const initWithSession: HttpObservation = {
        kind: 'response',
        status: 200,
        headers: { 'mcp-session-id': 'sess-123' },
        bodyText: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }),
    };

    it('issues ONLY read-only JSON-RPC methods — Tynn MCP is production', async () => {
        const { http, calls } = recordingHttp([initWithSession, toolsOk(['project'])]);
        await probeTynnMcp({ ...WS, url: 'https://tynn.ai/mcp/tynn', token: 'tok', http });

        const methods = calls.map((c) => JSON.parse(c.body).method);
        expect(methods.length).toBeGreaterThan(0);
        for (const method of methods) {
            expect(READ_ONLY_PROBE_METHODS).toContain(method);
        }
        // Belt and braces: the work-item tools must never appear in ANY body.
        const bodies = calls.map((c) => c.body).join('\n');
        expect(bodies).not.toContain('tools/call');
        expect(bodies).not.toContain('"create"');
        expect(bodies).not.toContain('"update"');
    });

    it('sends the bearer token and forwards the session id from initialize to tools/list', async () => {
        const { http, calls } = recordingHttp([initWithSession, toolsOk(['project'])]);
        const health = await probeTynnMcp({
            ...WS,
            url: 'https://tynn.ai/mcp/tynn',
            token: 'secret-token',
            http,
        });

        expect(health.state).toBe('healthy');
        for (const call of calls) {
            expect(call.headers.Authorization).toBe('Bearer secret-token');
        }
        const toolsCall = calls.find((c) => JSON.parse(c.body).method === 'tools/list');
        expect(toolsCall?.headers['Mcp-Session-Id']).toBe('sess-123');
    });

    it('stops after initialize when the transport never answered — no pointless second call', async () => {
        const { http, calls } = recordingHttp([
            { kind: 'response', status: 301, headers: { location: 'https://tynn.ai/mcp/tynn' }, bodyText: '' },
        ]);
        const health = await probeTynnMcp({
            ...WS,
            url: 'http://tynn.ai/mcp/tynn',
            token: 'tok',
            http,
        });

        expect(health.transport.state).toBe('redirect');
        expect(calls.map((c) => JSON.parse(c.body).method)).toEqual(['initialize']);
    });

    it('makes NO request at all when the workspace has no tynn url', async () => {
        const { http, calls } = recordingHttp([]);
        const health = await probeTynnMcp({ ...WS, url: null, token: null, http });

        expect(health.state).toBe('unconfigured');
        expect(calls).toEqual([]);
    });

    it('never throws when the http seam REJECTS — a failed probe is a reported state', async () => {
        const http: TynnProbeHttp = {
            post: vi.fn(async () => {
                throw new Error('socket hang up');
            }),
        };
        const health = await probeTynnMcp({
            ...WS,
            url: 'https://tynn.ai/mcp/tynn',
            token: 'tok',
            http,
        });

        expect(health.state).toBe('broken');
        expect(health.transport.state).toBe('unreachable');
        expect(health.transport.detail).toContain('socket hang up');
    });

    it('stamps the workspace, url and check time so the popover can render them', async () => {
        const { http } = recordingHttp([initWithSession, toolsOk(['project'])]);
        const health = await probeTynnMcp({
            ...WS,
            url: 'https://tynn.ai/mcp/tynn',
            token: 'tok',
            http,
            now: () => 1_700_000_000_000,
        });

        expect(health.workspaceId).toBe('ws1');
        expect(health.workspaceName).toBe('tynn.ai');
        expect(health.url).toBe('https://tynn.ai/mcp/tynn');
        expect(health.checkedAt).toBe(1_700_000_000_000);
    });
});
