import { describe, expect, it } from 'vitest';
import { encodeSubscribe, parsePusherFrame, pusherWsUrl } from '../src/core/pusher.js';
import type { IwEvent } from '../src/core/issue-watch.js';
import { IssueWatchClient, type IssueWatchClientPorts, type SocketLike } from '../src/main/issue-watch-client.js';

/**
 * ISSUEWATCH, LISTENING TO TYNN (Tynn #806). Genie never polls GitHub: Tynn does, and pushes each workspace's entry on
 * the person's own private channel (`issuewatch.delta`, Pusher protocol). Genie reaches it with the Tynn token it
 * already holds (the owner: no new token): it asks Tynn for the push config (the public key, the cluster, the person's
 * channel), dials, has Tynn sign its channel for this socket, subscribes — and on EVERY (re)connect reconciles the whole
 * feed, so a delta missed while offline is never lost. Each entry goes through the IssueWatchFeed: the first after a
 * boot is a baseline, after that what changed comes out as events. A drop reconnects; nothing polls.
 */
const PROJECT = 'proj_1';
const item = (key: string, kind = 'issue', updatedAt = '2026-10-17T10:00:00Z') => ({ kind, key, number: 1, title: 't', url: 'u', createdAt: updatedAt, updatedAt, owner: 'acme', repo: 'app' });
const entry = (items: unknown[]) => ({ workspaceId: PROJECT, projectId: PROJECT, counts: {}, items, feedbackItems: [], tracking: {} });

function harness(opts: { credentials?: { host: string; token: string } | null; authStatus?: number } = {}) {
    const requests: Array<{ method: string; url: string; auth: string | null; body: unknown }> = [];
    const sockets: Array<SocketLike & { sent: string[]; url: string; closed: boolean; emit(frame: unknown): void; drop(): void }> = [];
    const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
    const heard: Array<{ projectId: string; events: IwEvent[] }> = [];
    let reconcile: unknown = { workspaces: [entry([item('a:issue:1')])] };
    const ports: IssueWatchClientPorts = {
        credentials: () => (opts.credentials === undefined ? { host: 'https://tynn.example', token: 'rpk_X.secret' } : opts.credentials),
        fetch: async (url, init) => {
            requests.push({ method: init.method ?? 'GET', url, auth: init.headers.authorization ?? null, body: init.body ? JSON.parse(init.body) : null });
            const json = url.endsWith('/push-config') ? { key: 'pk_test', cluster: 'us2', channel: 'private-App.Models.User.42' }
                : url.endsWith('/broadcasting-auth') ? { auth: 'pk_test:sig' }
                : reconcile;
            const status = url.endsWith('/broadcasting-auth') ? (opts.authStatus ?? 200) : 200;
            return { ok: status < 300, status, json: async () => json };
        },
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
});

describe('the client', () => {
    it('signed out of Tynn: it says so and asks nothing', async () => {
        const h = harness({ credentials: null });
        h.client.start();
        await h.settle();
        expect(h.client.state()).toEqual({ kind: 'signed-out' });
        expect(h.requests).toEqual([]);
        expect(h.sockets).toEqual([]);
    });

    it('connects with the token it holds: push config, the socket, the channel signed for THIS socket, subscribed, reconciled', async () => {
        const h = harness();
        h.client.start();
        await h.settle();
        expect(h.requests[0]).toMatchObject({ method: 'GET', url: 'https://tynn.example/api/v1/issue-watch/push-config', auth: 'Bearer rpk_X.secret' });
        expect(h.sockets).toHaveLength(1);
        expect(h.sockets[0]!.url).toBe('wss://ws-us2.pusher.com/app/pk_test?protocol=7&client=genie&version=2.0');
        await h.connect(h.sockets[0]!);
        expect(h.requests[1]).toEqual({ method: 'POST', url: 'https://tynn.example/api/v1/issue-watch/broadcasting-auth', auth: 'Bearer rpk_X.secret', body: { socket_id: '123.456', channel_name: 'private-App.Models.User.42' } });
        expect(h.sockets[0]!.sent.map((f) => JSON.parse(f))).toEqual([{ event: 'pusher:subscribe', data: { auth: 'pk_test:sig', channel: 'private-App.Models.User.42' } }]);
        expect(h.requests[2]).toMatchObject({ method: 'GET', url: 'https://tynn.example/api/v1/issue-watch' });
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
