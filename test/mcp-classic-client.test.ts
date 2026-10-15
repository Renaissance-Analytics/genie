import { afterEach, describe, expect, it } from 'vitest';
import { genieToolDeps } from '../src/main/genie-tool-deps.js';
import { allGenieTools } from '../src/main/mcp-registrations.js';
import { genieMcpServer, type GenieMcpServer } from '../src/main/mcp-server.js';
import type { Caller } from '../src/main/mcp-tools.js';

/**
 * A CLASSIC MCP CLIENT GETS GENIE'S TOOLS — the handshake Codex's client sends, over real HTTP to the real
 * prism-mcp-server Genie runs. prism-mcp-server 0.1.0 refused the classic `initialize` (prism-mcp-server-ts#1), so a
 * Codex session in Genie connected to its `genie` server and had NO Genie tools. 0.2.0 answers it.
 *
 * The exchange is the one a classic streamable-HTTP client makes: `initialize` (protocolVersion 2025-06-18) with the
 * bearer → `notifications/initialized` → `tools/list` and `tools/call` carrying `MCP-Protocol-Version: 2025-06-18` and
 * no `_meta`. The control: the same `initialize` without the bearer is 401 — a server that answers it for anyone would
 * pass every other assertion here.
 */

const CLASSIC = '2025-06-18';
const term: Caller = { agentId: 'codex:builder' as Caller['agentId'], agentName: 'builder', workspaceId: 'ws_1', workspacePath: '/w' };
const never = (() => { throw new Error('not exercised'); }) as never;

let server: GenieMcpServer | null = null;
afterEach(async () => { await server?.stop(); server = null; });

async function start(thumbs: string[]): Promise<{ url: string; token: string }> {
    server = genieMcpServer({
        port: 0,
        registrations: allGenieTools(genieToolDeps({
            inbox: never, attention: never, knowledge: never, settings: never, feedback: never, approve: never, roster: () => [],
            resolveCaller: (id) => (id === 'term_7' ? term : null),
            userActive: () => true, glow: () => false, thumbsUp: (_caller: Caller, reason: string) => { thumbs.push(reason); }, openFile: never, terminals: never,
            sidecar: { register: never, start: never, running: () => false },
            plugins: { tools: () => [], guard: () => null, run: never },
        })),
    });
    return server.start();
}

/** A classic client accepts either a JSON body or an SSE stream; read the JSON-RPC message out of whichever came. */
async function message(res: Response): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
    const text = await res.text();
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        return JSON.parse(data);
    }
    return JSON.parse(text);
}

function post(url: string, body: unknown, headers: Record<string, string>): Promise<Response> {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
}

const INITIALIZE = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: CLASSIC, capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: '0.0.0' } } };

describe('a classic MCP client (what Codex sends) against Genie’s server over real HTTP', () => {
    it('control: initialize without the bearer is 401', async () => {
        const { url } = await start([]);
        expect((await post(url, INITIALIZE, {})).status).toBe(401);
    });

    it('initialize with the bearer is answered in the classic revision; initialized is accepted; tools/list names Genie’s tools; tools/call runs one', async () => {
        const thumbs: string[] = [];
        const { url, token } = await start(thumbs);
        const auth = { authorization: `Bearer ${token}` };

        const init = await post(url, INITIALIZE, auth);
        const initBody = await message(init);
        expect({ status: init.status, error: initBody.error ?? null }).toEqual({ status: 200, error: null });
        expect(initBody.result?.protocolVersion).toBe(CLASSIC);
        expect(initBody.result?.capabilities).toMatchObject({ tools: {} });
        expect((initBody.result?.serverInfo as { name?: unknown } | undefined)?.name).toEqual(expect.any(String));

        const classic = { ...auth, 'mcp-protocol-version': CLASSIC };
        const initialized = await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, classic);
        expect(initialized.status).toBe(202);

        const list = await message(await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, classic));
        expect(list.error ?? null).toBeNull();
        const names = (list.result?.tools as Array<{ name: string }>).map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining(['imDone', 'ForceTheQuestion', 'agentinbox', 'lists', 'thumbsUp']));

        const call = await message(await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'thumbsUp', arguments: { terminalId: 'term_7', reason: 'booted' } } }, classic));
        expect(call.error ?? null).toBeNull();
        const content = call.result?.content as Array<{ type: string; text: string }>;
        expect({ isError: call.result?.isError, type: content[0]!.type, payload: JSON.parse(content[0]!.text) }).toEqual({ isError: false, type: 'text', payload: { ok: true } });
        expect(thumbs).toEqual(['booted']);
    });
});
