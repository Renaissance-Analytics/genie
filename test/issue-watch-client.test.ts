import { describe, expect, it } from 'vitest';
import { encodeSubscribe, parsePusherFrame, pusherWsUrl, socketUrlFor } from '../src/core/pusher.js';
import type { IwEvent } from '../src/core/issue-watch.js';
import { IssueWatchClient, type IssueWatchClientPorts, type SocketLike } from '../src/main/issue-watch-client.js';

/**
 * ISSUEWATCH, LISTENING TO TYNN (Tynn #806). Genie never polls GitHub: Tynn does, and pushes each workspace's entry on
 * the person's own private channel (`issuewatch.delta`, Pusher protocol). Genie reaches it over its Tynn SESSION, on the
 * routes Genie 1 used (the owner, 2026-10-19: "everything was already working in genie 1"): it asks Tynn for the push
 * config (`/api/v1/broadcasting-config`: the public key, the cluster; the channel is the person's own, by id), dials, has Tynn sign its channel for this socket, subscribes — and on EVERY (re)connect reconciles the whole
 * feed, so a delta missed while offline is never lost. Each entry goes through the IssueWatchFeed: the first after a
 * boot is a baseline, after that what changed comes out as events. A drop reconnects; nothing polls.
 */
const PROJECT = 'proj_1';
const item = (key: string, kind = 'issue', updatedAt = '2026-10-17T10:00:00Z') => ({ kind, key, number: 1, title: 't', url: 'u', createdAt: updatedAt, updatedAt, owner: 'acme', repo: 'app' });
const entry = (items: unknown[]) => ({ workspaceId: PROJECT, projectId: PROJECT, counts: {}, items, feedbackItems: [], tracking: {} });

function harness(opts: { signedIn?: boolean; authStatus?: number; refresh?: { status?: number; json: unknown }; config?: unknown } = {}) {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const sockets: Array<SocketLike & { sent: string[]; url: string; closed: boolean; emit(frame: unknown): void; drop(): void }> = [];
    const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
    const heard: Array<{ projectId: string; events: IwEvent[] }> = [];
    let reconcile: unknown = { workspaces: [entry([item('a:issue:1')])] };
    const ports: IssueWatchClientPorts = {
        // The signed-in Tynn (main/tynn-account.ts): the person's id, and requests that ride the session.
        tynn: () => (opts.signedIn === false ? null : {
            userId: '42',
            request: async (path, init) => {
                requests.push({ method: init.method, path, body: init.body ?? null });
                const json = path === '/api/v1/broadcasting-config' ? (opts.config ?? { key: 'pk_test', cluster: 'us2' })
                    : path === '/api/v1/user/broadcasting-auth' ? { auth: 'pk_test:sig' }
                    : path === '/api/v1/user/issue-watch/refresh' ? opts.refresh?.json
                    : reconcile;
                const status = path === '/api/v1/user/broadcasting-auth' ? (opts.authStatus ?? 200) : path === '/api/v1/user/issue-watch/refresh' ? (opts.refresh?.status ?? 200) : 200;
                return { ok: status < 300, status, json: async () => json };
            },
        }),
        socket: (url) => {
            const listeners: Record<string, Array<(e: { data?: unknown }) => void>> = {};
            const s = {
                url, sent: [] as string[], closed: false,
                send: (data: string) => { s.sent.push(data); },
                close: () => { s.closed = true; for (const l of listeners.close ?? []) l({}); },
                addEventListener: (type: string, l: (e: { data?: unknown }) => void) => { (listeners[type] ??= []).push(l); },
                emit: (frame: unknown) => { for (const l of listeners.message ?? []) l({ data: JSON.stringify(frame) }); },
                drop: () => { for (const l of listeners.close ?? []) l({}); },
            };
            sockets.push(s);
            return s;
        },
        schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
        onEvents: (projectId, events) => { heard.push({ projectId, events }); },
    };
    const client = new IssueWatchClient(ports);
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const connect = async (s: (typeof sockets)[number]) => {
        s.emit({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: '123.456' }) });
        await settle();
        s.emit({ event: 'pusher_internal:subscription_succeeded', channel: 'private-App.Models.User.42', data: '{}' });
        await settle(); await settle();
    };
    return { client, requests, sockets, timers, heard, connect, settle, setReconcile: (r: unknown) => { reconcile = r; } };
}

describe('the Pusher protocol', () => {
    it('reads a frame whose data is double-encoded; drops one that is not JSON', () => {
        expect(parsePusherFrame('{"event":"issuewatch.delta","channel":"c","data":"{\\"a\\":1}"}')).toEqual({ event: 'issuewatch.delta', channel: 'c', data: { a: 1 } });
        expect(parsePusherFrame('nope')).toBeNull();
    });
    it('the endpoint for a key and cluster; a subscribe carries the channel and its signature', () => {
        expect(pusherWsUrl('pk', 'us2')).toBe('wss://ws-us2.pusher.com/app/pk?protocol=7&client=genie&version=2.0');
        expect(JSON.parse(encodeSubscribe('private-x', 'pk:sig'))).toEqual({ event: 'pusher:subscribe', data: { auth: 'pk:sig', channel: 'private-x' } });
    });
    it('Tynn’s own socket server (Reverb — Laravel Cloud, or Genie’s WebSocket service in development) is dialled at the host Tynn names', () => {
        expect(socketUrlFor({ broadcaster: 'reverb', key: 'rk', host: 'ws.example.test', port: 443, scheme: 'https' }))
            .toBe('wss://ws.example.test:443/app/rk?protocol=7&client=genie&version=2.0');
        expect(socketUrlFor({ broadcaster: 'reverb', key: 'rk', host: 'websockets.gen', port: 8080, scheme: 'http' }))
            .toBe('ws://websockets.gen:8080/app/rk?protocol=7&client=genie&version=2.0');
        // Pusher (and a Tynn from before `broadcaster` was said): the cluster's host.
        expect(socketUrlFor({ key: 'pk', cluster: 'eu' })).toBe('wss://ws-eu.pusher.com/app/pk?protocol=7&client=genie&version=2.0');
        expect(socketUrlFor({ broadcaster: 'pusher', key: 'pk' })).toBe('wss://ws-us2.pusher.com/app/pk?protocol=7&client=genie&version=2.0');
        // No key, or Reverb without a host: nothing to dial.
        expect(socketUrlFor({ broadcaster: 'reverb', key: 'rk' })).toBeNull();
        expect(socketUrlFor({ broadcaster: 'log', key: null })).toBeNull();
    });
});

describe('the client', () => {
    it('signed out of Tynn: it says so and asks nothing', async () => {
        const h = harness({ signedIn: false });
        h.client.start();
        await h.settle();
        expect(h.client.state()).toEqual({ kind: 'signed-out' });
        expect(h.requests).toEqual([]);
        expect(h.sockets).toEqual([]);
    });

    it('dials the Reverb host Tynn names, and goes live on it exactly as on Pusher', async () => {
        const h = harness({ config: { broadcaster: 'reverb', key: 'rk', host: 'ws.example.test', port: 443, scheme: 'https' } });
        h.client.start();
        await h.settle();
        expect(h.sockets.map((s) => s.url)).toEqual(['wss://ws.example.test:443/app/rk?protocol=7&client=genie&version=2.0']);
        await h.connect(h.sockets[0]!);
        expect(h.client.state()).toEqual({ kind: 'live' });
    });

    it('connects over the session, on Genie 1’s routes: push config, the socket, the channel signed for THIS socket, subscribed, reconciled', async () => {
        const h = harness();
        h.client.start();
        await h.settle();
        expect(h.requests[0]).toEqual({ method: 'GET', path: '/api/v1/broadcasting-config', body: null });
        expect(h.sockets).toHaveLength(1);
        expect(h.sockets[0]!.url).toBe('wss://ws-us2.pusher.com/app/pk_test?protocol=7&client=genie&version=2.0');
        await h.connect(h.sockets[0]!);
        // The channel is the person's own, by the id the session answered /api/v1/me with.
        expect(h.requests[1]).toEqual({ method: 'POST', path: '/api/v1/user/broadcasting-auth', body: { socket_id: '123.456', channel_name: 'private-App.Models.User.42' } });
        expect(h.sockets[0]!.sent.map((f) => JSON.parse(f))).toEqual([{ event: 'pusher:subscribe', data: { auth: 'pk_test:sig', channel: 'private-App.Models.User.42' } }]);
        expect(h.requests[2]).toEqual({ method: 'GET', path: '/api/v1/user/issue-watch', body: null });
        expect(h.client.state()).toEqual({ kind: 'live' });
        // The reconcile after a boot is the baseline: nothing heard.
        expect(h.heard).toEqual([]);
    });

    it('a delta on its channel: what changed is heard, for that project; a delta on any other channel is not (COUNTED)', async () => {
        const h = harness();
        h.client.start();
        await h.settle();
        await h.connect(h.sockets[0]!);
        h.sockets[0]!.emit({ event: 'issuewatch.delta', channel: 'private-App.Models.User.99', data: JSON.stringify(entry([item('a:issue:1'), item('a:pr:9', 'pr')])) });
        h.sockets[0]!.emit({ event: 'issuewatch.delta', channel: 'private-App.Models.User.42', data: JSON.stringify(entry([item('a:issue:1'), item('a:pr:2', 'pr')])) });
        expect(h.heard).toHaveLength(1);
        expect(h.heard[0]!.projectId).toBe(PROJECT);
        expect(h.heard[0]!.events.map((e) => [e.kind, e.item?.key])).toEqual([['pr.new', 'a:pr:2']]);
    });

    /*
     * A LIST TOO BIG FOR ONE EVENT (tynn.ai#308; the owner, 2026-10-21: "exceeds the allowed maximum (10240 bytes)"). Tynn
     * sends a workspace whose list would not fit as a notice — counts, `truncated: true`, no `items` — and Genie pulls the
     * whole entry over HTTP (the reconcile) at once, instead of waiting for the next reconnect.
     */
    it('a TRUNCATED delta pulls the whole entry over HTTP at once — what changed is heard from the pull (COUNTED)', async () => {
        const h = harness();
        h.client.start();
        await h.settle();
        await h.connect(h.sockets[0]!);
        const pullsBefore = h.requests.filter((r) => r.path === '/api/v1/user/issue-watch').length;
        h.setReconcile({ workspaces: [entry([item('a:issue:1'), item('a:pr:7', 'pr')])] });
        h.sockets[0]!.emit({ event: 'issuewatch.delta', channel: 'private-App.Models.User.42', data: JSON.stringify({ workspaceId: PROJECT, projectId: PROJECT, counts: { pr: 1 }, tracking: {}, truncated: true }) });
        await h.settle(); await h.settle();
        expect(h.requests.filter((r) => r.path === '/api/v1/user/issue-watch').length).toBe(pullsBefore + 1);
        expect(h.heard.at(-1)?.events.map((e) => [e.kind, e.item?.key])).toEqual([['pr.new', 'a:pr:7']]);
    });

    it('CONTROL: a whole delta pulls nothing', async () => {
        const h = harness();
        h.client.start();
        await h.settle();
        await h.connect(h.sockets[0]!);
        const pullsBefore = h.requests.filter((r) => r.path === '/api/v1/user/issue-watch').length;
        h.sockets[0]!.emit({ event: 'issuewatch.delta', channel: 'private-App.Models.User.42', data: JSON.stringify(entry([item('a:issue:1')])) });
        await h.settle(); await h.settle();
        expect(h.requests.filter((r) => r.path === '/api/v1/user/issue-watch').length).toBe(pullsBefore);
    });

    it('answers a ping with a pong', async () => {
        const h = harness();
        h.client.start();
        await h.settle();
        await h.connect(h.sockets[0]!);
        h.sockets[0]!.emit({ event: 'pusher:ping', data: '{}' });
        expect(h.sockets[0]!.sent.map((f) => JSON.parse(f).event)).toContain('pusher:pong');
    });

    it('a drop reconnects; the reconcile on reconnect hears what changed while it was away', async () => {
        const h = harness();
        h.client.start();
        await h.settle();
        await h.connect(h.sockets[0]!);
        h.sockets[0]!.drop();
        expect(h.client.state()).toEqual({ kind: 'reconnecting' });
        const t = h.timers.find((x) => !x.cancelled)!;
        h.setReconcile({ workspaces: [entry([item('a:issue:1'), item('a:dependabot:5', 'dependabot')])] });
        t.fn();
        await h.settle();
        expect(h.sockets).toHaveLength(2);
        await h.connect(h.sockets[1]!);
        expect(h.heard.flatMap((x) => x.events.map((e) => e.kind))).toEqual(['security.new']);
        expect(h.client.state()).toEqual({ kind: 'live' });
    });

    it('Tynn refuses to sign the channel: the socket is closed, it says why, and it tries again later', async () => {
        const h = harness({ authStatus: 403 });
        h.client.start();
        await h.settle();
        h.sockets[0]!.emit({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: '1.2' }) });
        await h.settle(); await h.settle();
        expect(h.sockets[0]!.closed).toBe(true);
        expect(h.client.state()).toMatchObject({ kind: 'reconnecting', reason: expect.stringContaining('403') });
        expect(h.timers.some((x) => !x.cancelled)).toBe(true);
    });

    it('stopped: the socket closes and nothing reconnects', async () => {
        const h = harness();
        h.client.start();
        await h.settle();
        await h.connect(h.sockets[0]!);
        h.client.stop();
        expect(h.sockets[0]!.closed).toBe(true);
        expect(h.timers.filter((x) => !x.cancelled)).toEqual([]);
        expect(h.client.state()).toEqual({ kind: 'stopped' });
    });
});

/**
 * A REFRESH, ASKED FOR (Genie 1's `checkIssues(refresh: true)`): Tynn reads GitHub now rather than at its next poll. ONE
 * window per workspace, shared by everyone who asks (Tynn's IssueWatchRefreshLimiter) — a refusal is an answer, with the
 * current snapshot and when the next is allowed. The snapshot goes through the same feed as a push, so what is new is
 * heard as events.
 */
describe('a refresh', () => {
    const cooldown = (label: string) => ({ seconds: 1, nextAllowedAt: 't', label });

    it('POSTs the project with the token Genie holds; the fresh snapshot is applied, so what is new is HEARD', async () => {
        const h = harness({ refresh: { json: { refreshed: true, reason: 'refreshed', error: null, cooldown: cooldown('3m'), workspace: entry([item('a:issue:1'), item('b:pr:2', 'pr')]) } } });
        h.client.start();
        await h.settle();
        await h.connect(h.sockets[0]!);

        const answer = await h.client.refresh(PROJECT);

        expect(answer).toEqual({ ok: true, refreshed: true, reason: 'refreshed', nextIn: '3m' });
        const req = h.requests.find((r) => r.path.endsWith('/refresh'))!;
        expect(req).toEqual({ method: 'POST', path: '/api/v1/user/issue-watch/refresh', body: { project_id: PROJECT } });
        expect(h.heard.flatMap((x) => x.events.map((e) => e.kind))).toEqual(['pr.new']);
    });

    it('refused inside the window: says so and when the next is allowed; nothing is new (COUNTED: no events)', async () => {
        const h = harness({ refresh: { json: { refreshed: false, reason: 'cooldown', error: null, cooldown: cooldown('1m 12s'), workspace: entry([item('a:issue:1')]) } } });
        h.client.start();
        await h.settle();
        await h.connect(h.sockets[0]!);

        expect(await h.client.refresh(PROJECT)).toEqual({ ok: true, refreshed: false, reason: 'cooldown', nextIn: '1m 12s' });
        expect(h.heard).toEqual([]);
    });

    it('GitHub failed on Tynn’s side: Tynn’s own words come back', async () => {
        const h = harness({ refresh: { json: { refreshed: false, reason: 'failed', error: 'GitHub answered 502', cooldown: cooldown('3m'), workspace: entry([]) } } });
        expect(await h.client.refresh(PROJECT)).toEqual({ ok: true, refreshed: false, reason: 'failed', nextIn: '3m', error: 'GitHub answered 502' });
    });

    it('not signed in: says so and asks nothing; Tynn refuses: says the status', async () => {
        const out = harness({ signedIn: false });
        expect(await out.client.refresh(PROJECT)).toEqual({ ok: false, reason: 'not signed in to Tynn' });
        expect(out.requests).toEqual([]);
        const refused = harness({ refresh: { status: 404, json: { message: 'No IssueWatch workspace with that id is available to you.' } } });
        expect(await refused.client.refresh(PROJECT)).toEqual({ ok: false, reason: 'Tynn answered the refresh with HTTP 404' });
    });
});
