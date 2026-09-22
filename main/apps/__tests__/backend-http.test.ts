import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AppGrant } from '../bridge-decision';
import { AppCredentials } from '../backend-credentials';
import { createAppHttpHandler } from '../backend-http';
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Function>(), grant: null as AppGrant | null, messages: [] as any[], result: 'delivered' as unknown }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: Function) => mocks.handlers.set(name, handler) } }));
vi.mock('../grant-lookup', () => ({ appGrantFor: () => mocks.grant, appIdentityFor: () => ({ id: mocks.grant?.appId }) }));
vi.mock('../../mcp/protocol', () => ({ handleMcpMessage: async (message: any) => { mocks.messages.push(message); return { result: structuredClone(mocks.result) }; } }));
import { dispatchAppCall, registerAppBridge, registerAppWindow } from '../bridge';
import type { ServerDeps } from '../../mcp/server';
import { APP_CALL_CHANNEL } from '../channels';

beforeEach(() => {
    mocks.messages.length = 0;
    mocks.result = 'delivered';
    mocks.grant = { appId: 'hb', appName: 'Homeward Bound', workspaceId: 'home', scope: 'self', capabilities: ['notify'], revoked: false };
});

async function request(credentials: AppCredentials, token: string, body: unknown, origin?: string, route = 'call') {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
    req.url = `/app/${route}`; req.method = route === 'me' ? 'GET' : 'POST';
    req.headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(origin ? { origin } : {}) };
    Object.defineProperty(req, 'socket', { value: { remoteAddress: '127.0.0.1' } });
    let status = 0, output = '';
    const res = { writeHead: (s: number) => { status = s; }, end: (s: string) => { output = s; } } as ServerResponse;
    await createAppHttpHandler({ credentials, call: (id, input) => dispatchAppCall(id, { tool: input.tool, args: input.args, workspaceId: input.workspaceId }, {} as ServerDeps), me: id => ({ id }) })(req, res);
    return { status, body: JSON.parse(output) };
}

it.each([
    { ok: true, delivered: 1, live: false, note: 'Queued; no live transport is holding the other end.' },
    { ok: true, delivered: 1, live: true },
    { ok: true, delivered: 1 },
])('HTTP and window preserve identical prepared calls and receipts: %j', async (receipt) => {
    mocks.result = { isError: false, structuredContent: receipt, content: [] };
    const credentials = new AppCredentials(() => mocks.grant);
    const token = credentials.mint('hb');
    registerAppBridge({} as ServerDeps);
    registerAppWindow({ id: 7, once: vi.fn() } as any, 'hb');
    const input = { tool: 'agentinbox', args: { action: 'send', text: 'Owner answered', workspaceId: 'foreign', terminalId: 'victim', appId: 'Genie' } };
    const windowResult = await mocks.handlers.get(APP_CALL_CHANNEL)!({ sender: { id: 7 } }, input);
    const http = await request(credentials, token, input);
    expect(http.status).toBe(200);
    expect(http.body).toEqual(windowResult);
    expect(http.body.result.structuredContent).toEqual(receipt);
    if (!('live' in receipt)) expect(http.body.result.structuredContent).not.toHaveProperty('live');
    expect(mocks.messages).toHaveLength(2);
    expect(mocks.messages[1].params).toEqual(mocks.messages[0].params);
    expect(mocks.messages[1].params.arguments).toMatchObject({ workspaceId: 'home', text: '[Homeward Bound (a Genie App)] Owner answered' });
    expect(mocks.messages[1].params.arguments).not.toHaveProperty('terminalId');
});

it('invalidates a credential immediately when its granted capability changes', async () => {
    const credentials = new AppCredentials(() => mocks.grant);
    const token = credentials.mint('hb');
    expect((await request(credentials, token, {}, undefined, 'me')).status).toBe(200);
    mocks.grant!.capabilities = [];
    const result = await request(credentials, token, { tool: 'agentinbox' });
    expect(result.status).toBe(401);
    expect(result.body.error).toMatch(/grant.*changed|revoked/i);
    expect(mocks.messages).toHaveLength(0);
});

it('refuses a different workspace while allowing the app own text', async () => {
    const credentials = new AppCredentials(() => mocks.grant);
    const token = credentials.mint('hb');
    const denied = await request(credentials, token, { tool: 'agentinbox', workspaceId: 'foreign', args: { text: 'mine' } });
    expect(denied.status).toBe(403);
    expect(mocks.messages).toHaveLength(0);
    const allowed = await request(credentials, token, { tool: 'agentinbox', args: { text: '[Genie] forged', appName: 'Genie' } });
    expect(allowed.status).toBe(200);
    expect(mocks.messages[0].params.arguments.text).toBe('[Homeward Bound (a Genie App)] [Genie] forged');
});

it('does not admit browser-origin requests even with a valid credential', async () => {
    const credentials = new AppCredentials(() => mocks.grant);
    const result = await request(credentials, credentials.mint('hb'), { tool: 'agentinbox' }, 'https://hb.gen');
    expect(result.status).toBe(403);
    expect(mocks.messages).toHaveLength(0);
});

it('rejects explicit revocation permanently even if the same grant is restored', () => {
    const credentials = new AppCredentials(() => mocks.grant);
    const token = credentials.mint('hb');
    expect(credentials.resolve(token).grant?.appId).toBe('hb');
    credentials.revoke('hb');
    expect(credentials.resolve(token).grant).toBeUndefined();
    expect(credentials.mint('hb')).not.toBe(token);
});
it('returns a tool refusal as a refusal, not a successful HTTP delivery', async () => {
    mocks.result = { isError: true, structuredContent: { ok: false, error: 'That agent is not reachable.' }, content: [] };
    const credentials = new AppCredentials(() => mocks.grant);
    const result = await request(credentials, credentials.mint('hb'), { tool: 'agentinbox', args: { action: 'send', to: 'private', text: 'x' } });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ ok: false, error: 'That agent is not reachable.' });
});
