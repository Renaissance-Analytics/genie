import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parseEngineFrame } from '../src/core/engine-protocol.js';
import { memoryPair } from '../src/core/line-transport.js';
import { TynnBoardHub, type TynnBoardHubEvent } from '../src/main/issue-watch-host.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import { TYNN_ISSUES_FEED } from '../src/main/tynn-issues-live.js';

const TOKEN = 'f'.repeat(64);
type IssuesClient = SessionEngineClient & {
    tynnIssuesWatch(viewId: string, workspaceId: string): Promise<boolean>;
    tynnIssuesUnwatch(viewId: string): Promise<boolean>;
    onTynnIssuesEvent(listener: (event: TynnBoardHubEvent) => void): () => void;
};
type IssuesServer = SessionEngineServer & { tynnIssuesEvent(owner: string, event: TynnBoardHubEvent): void };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0)); };

async function rig() {
    const dir = await mkdtemp(join(tmpdir(), 'genie-issues-live-host-'));
    const requests: Array<{ path: string; body?: unknown }> = [];
    const sockets: Array<{ closed: boolean; sent: string[]; emit(frame: unknown): void }> = [];
    let server: IssuesServer;
    const ports = {
        feed: TYNN_ISSUES_FEED,
        projectFor: (id: string) => id === 'work' ? 'host-project' : null,
        tynn: () => ({ userId: () => 'owner', request: async (path: string, init: { method: 'GET' | 'POST'; body?: unknown }) => {
            requests.push({ path, ...(init.body ? { body: init.body } : {}) });
            return { ok: true, status: 200, json: async () => path === '/api/v1/broadcasting-config'
                ? { broadcaster: 'reverb', key: 'rk', host: 'ws.tynn.test', port: 443, scheme: 'https' }
                : { auth: 'rk:signature' } };
        } }),
        socket: () => {
            const listeners: Record<string, Array<(event: { data?: unknown }) => void>> = {};
            const socket = {
                closed: false, sent: [] as string[],
                send: (data: string) => { socket.sent.push(data); },
                close: () => { socket.closed = true; for (const l of listeners.close ?? []) l({}); },
                addEventListener: (name: string, l: (event: { data?: unknown }) => void) => { (listeners[name] ??= []).push(l); },
                emit: (frame: unknown) => { for (const l of listeners.message ?? []) l({ data: JSON.stringify(frame) }); },
            };
            sockets.push(socket);
            return socket;
        },
        schedule: (_fn: () => void, _ms: number) => () => {},
        send: (owner: string, event: TynnBoardHubEvent) => server.tynnIssuesEvent(owner, event),
    };
    const hub = new TynnBoardHub(ports);
    const options = { token: TOKEN, build: 'test', tynnIssues: hub };
    server = new SessionEngineServer(options) as IssuesServer;
    const host = new SessionHost({ userData: dir, driverFor: () => { throw new Error('following Issues must start no provider'); }, processTree: { snapshot: () => [], killTree: () => ({ killed: 0, refused: false }) }, ...server.hostOptions() });
    server.attach(host);
    cleanups.push(async () => { await host.stopAll(); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
    const connect = async (client: IssuesClient, local: boolean) => {
        const [h, w] = memoryPair();
        server.accept(h, { local });
        expect(await client.connect(w, TOKEN)).toMatchObject({ ok: true });
        return () => w.close();
    };
    const window = async (local = true) => {
        const client = new SessionEngineClient() as IssuesClient;
        const close = await connect(client, local);
        cleanups.push(async () => { client.disconnect(); });
        return { client, close };
    };
    return { window, connect, sockets, requests };
}

function hasIssuesWatchProtocol() {
    for (const method of ['engine.tynnIssuesWatch', 'engine.tynnIssuesUnwatch']) {
        expect(parseEngineFrame(JSON.stringify({ kind: 'call', id: 1, method, args: ['view', 'work'] }))).toMatchObject({ ok: true });
    }
}

it('the host signs only the Issues channel, shares its socket between views, and sends only issue rings', async () => {
    hasIssuesWatchProtocol();
    const r = await rig();
    const w = await r.window();
    const events: TynnBoardHubEvent[] = [];
    w.client.onTynnIssuesEvent((event) => events.push(event));
    expect(await w.client.tynnIssuesWatch('view1', 'work')).toBe(true);
    expect(await w.client.tynnIssuesWatch('view2', 'work')).toBe(true);
    await settle();
    expect(r.sockets).toHaveLength(1);
    const socket = r.sockets[0]!;
    socket.emit({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: '1.2' }) });
    await settle();
    expect(r.requests.at(-1)).toEqual({ path: '/api/v1/projects/host-project/issues/broadcasting-auth', body: { socket_id: '1.2', channel_name: 'private-project-issues.host-project' } });
    socket.emit({ event: 'pusher_internal:subscription_succeeded', channel: 'private-project-issues.host-project', data: '{}' });
    socket.emit({ event: 'issue.updated', channel: 'private-project-issues.host-project', data: JSON.stringify({ issue: { id: 'i1' } }) });
    socket.emit({ event: 'story.updated', channel: 'private-project-issues.host-project', data: JSON.stringify({ story: { id: 's1' } }) });
    await settle();
    expect(events.filter((e) => 'ring' in e.signal)).toEqual([
        { workspaceId: 'work', signal: { ring: { ids: [], catchUp: true } } },
        { workspaceId: 'work', signal: { ring: { ids: ['i1'], catchUp: false } } },
    ]);
    expect(await w.client.tynnIssuesUnwatch('view1')).toBe(true);
    expect(socket.closed).toBe(false);
    expect(await w.client.tynnIssuesUnwatch('view2')).toBe(true);
    expect(socket.closed).toBe(true);
});

it('a non-local engine connection cannot watch the owner queue; an unlinked workspace asks nothing', async () => {
    hasIssuesWatchProtocol();
    const r = await rig();
    const remote = await r.window(false);
    expect(await remote.client.tynnIssuesWatch('remote', 'work')).toBe(false);
    const local = await r.window();
    expect(await local.client.tynnIssuesWatch('loose', 'unlinked')).toBe(false);
    expect(r.requests).toEqual([]);
    expect(r.sockets).toEqual([]);
});

it('losing the watching connection releases its host views and closes the last socket', async () => {
    hasIssuesWatchProtocol();
    const r = await rig();
    const w = await r.window();
    expect(await w.client.tynnIssuesWatch('view', 'work')).toBe(true);
    await settle();
    expect(r.sockets[0]!.closed).toBe(false);
    w.close();
    await settle();
    expect(r.sockets[0]!.closed).toBe(true);
});

it('a reconnected window restores its intended Issues watches on the host', async () => {
    hasIssuesWatchProtocol();
    const r = await rig();
    const w = await r.window();
    expect(await w.client.tynnIssuesWatch('view', 'work')).toBe(true);
    await settle();
    w.close();
    await settle();
    expect(r.sockets[0]!.closed).toBe(true);
    await r.connect(w.client, true);
    await settle();
    expect(r.sockets).toHaveLength(2);
    expect(r.sockets[1]!.closed).toBe(false);
});
