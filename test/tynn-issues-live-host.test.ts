import { expect, it } from 'vitest';
import { isEngineMethod } from '../src/core/engine-protocol.js';
import type { TynnWatchEvent } from '../src/core/local-tynn-watch.js';
import { HOST_LOCAL_OWNER, hostTynnWatch } from '../src/main/host-local-watches.js';
import { TynnBoardHub, type TynnBoardHubEvent } from '../src/main/issue-watch-host.js';
import { TYNN_ISSUES_FEED } from '../src/main/tynn-issues-live.js';

/**
 * THE LIVE ISSUES QUEUE, IN GENIE-HOST. genie-host follows the queue's own channel, `private-project-issues.{id}`, with one
 * socket shared by every view, and says its rings to its OWN owner's watch port (host-local-watches.ts), which the Tynn
 * tab's `tynn.watch` reads over the protocol. Nothing of it rides the engine link since Tynn #934 task #1474: the window's
 * main held a second road to this hub that nothing read. Who may watch (this machine's own window) and a closing
 * connection releasing its views are RemoteHost's, pinned in p4-family12-tynn.test.ts and p4-family12-kept-contract-561.test.ts.
 */
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0)); };

function rig() {
    const requests: Array<{ path: string; body?: unknown }> = [];
    const sockets: Array<{ closed: boolean; sent: string[]; emit(frame: unknown): void }> = [];
    const strangers: Array<[string, TynnBoardHubEvent]> = [];
    let watches: ReturnType<typeof hostTynnWatch> | null = null;
    const hubOf = (feed?: typeof TYNN_ISSUES_FEED) => new TynnBoardHub({
        ...(feed ? { feed } : {}),
        projectFor: (id: string) => (id === 'work' ? 'host-project' : null),
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
        // As genie-host wires it: its own owner's events to its watch port, and no other owner's anywhere.
        send: (owner: string, event: TynnBoardHubEvent) => { if (owner === HOST_LOCAL_OWNER) watches?.deliver('issues', event); else strangers.push([owner, event]); },
    });
    const hub = hubOf(TYNN_ISSUES_FEED);
    watches = hostTynnWatch({ hubs: { board: hubOf(), issues: hub, features: hubOf() } });
    const events: TynnWatchEvent[] = [];
    watches.port.subscribe((event) => events.push(event));
    return { port: watches.port, hub, events, sockets, requests, strangers };
}

it('the engine link has no Issues watch: its two methods are not engine methods (Tynn #934 task #1474)', () => {
    for (const method of ['engine.tynnIssuesWatch', 'engine.tynnIssuesUnwatch']) expect(isEngineMethod(method), method).toBe(false);
    // CONTROL: a method the link keeps is one.
    expect(isEngineMethod('engine.heartbeat')).toBe(true);
});

it('the host signs only the Issues channel, shares its socket between views, and sends only issue rings, to its own watch port', async () => {
    const r = rig();
    expect(await r.port.watch('issues', 'view1', 'work')).toBe(true);
    expect(await r.port.watch('issues', 'view2', 'work')).toBe(true);
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
    expect(r.events.filter((e) => 'ring' in (e.signal as object))).toEqual([
        { kind: 'issues', workspaceId: 'work', signal: { ring: { ids: [], catchUp: true } } },
        { kind: 'issues', workspaceId: 'work', signal: { ring: { ids: ['i1'], catchUp: false } } },
    ]);
    r.port.unwatch('issues', 'view1');
    expect(socket.closed).toBe(false);
    r.port.unwatch('issues', 'view2');
    expect(socket.closed).toBe(true);
});

it('an unlinked workspace is not followed and asks nothing; another kind’s watch does not dial the Issues channel', async () => {
    const r = rig();
    expect(await r.port.watch('issues', 'loose', 'unlinked')).toBe(false);
    await settle();
    expect(r.requests).toEqual([]);
    expect(r.sockets).toEqual([]);
    // CONTROL: the linked workspace beside it is followed, and dials.
    expect(await r.port.watch('issues', 'view', 'work')).toBe(true);
    await settle();
    expect(r.sockets).toHaveLength(1);
});

it('after the last view goes the socket is closed, and a view that watches again dials a new one', async () => {
    const r = rig();
    expect(await r.port.watch('issues', 'view', 'work')).toBe(true);
    await settle();
    expect(r.sockets[0]!.closed).toBe(false);
    r.port.unwatch('issues', 'view');
    await settle();
    expect(r.sockets[0]!.closed).toBe(true);
    expect(await r.port.watch('issues', 'view', 'work')).toBe(true);
    await settle();
    expect(r.sockets).toHaveLength(2);
    expect(r.sockets[1]!.closed).toBe(false);
});

it('only genie-host’s own owner’s views are told here: a view under any other owner reaches no watcher of the port', async () => {
    const r = rig();
    expect(r.hub.watch('some-other-owner', 'view', 'work')).toBe(true);
    await settle();
    const socket = r.sockets[0]!;
    socket.emit({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: '1.2' }) });
    await settle();
    socket.emit({ event: 'pusher_internal:subscription_succeeded', channel: 'private-project-issues.host-project', data: '{}' });
    socket.emit({ event: 'issue.updated', channel: 'private-project-issues.host-project', data: JSON.stringify({ issue: { id: 'i1' } }) });
    await settle();
    expect(r.events).toEqual([]);
    // CONTROL: the hub did signal that owner; it is only this port that is not told.
    expect(r.strangers.length).toBeGreaterThan(0);
    expect(r.strangers.every(([owner]) => owner === 'some-other-owner')).toBe(true);
});
