import { expect, it } from 'vitest';
import { isEngineMethod } from '../src/core/engine-protocol.js';
import type { TynnWatchEvent } from '../src/core/local-tynn-watch.js';
import { HOST_LOCAL_OWNER, hostTynnWatch } from '../src/main/host-local-watches.js';
import { TynnBoardHub, type TynnBoardHubEvent } from '../src/main/issue-watch-host.js';
import type { TynnLiveFeed } from '../src/main/tynn-board-live.js';
import { TYNN_FEATURES_FEED } from '../src/main/tynn-features-live.js';

/**
 * THE LIVE FEATURES PAGE (genie#1295 row F1, workspace-ux 0.10.0 `features.data.live`): genie-host follows the page's
 * own channel, `private-project-features.{id}`, signed at `POST /api/v1/projects/{id}/features/broadcasting-auth`, with
 * one socket shared by every view, as it follows the Issues queue. A feature or domain event is a doorbell; the tab reads
 * the page again. Its rings go to genie-host's OWN owner's watch port (host-local-watches.ts), which the Tynn tab's
 * `tynn.watch` reads over the protocol; nothing of it rides the engine link since Tynn #934 task #1474. Who may watch and a
 * closing connection releasing its views are RemoteHost's (p4-family12-tynn.test.ts, p4-family12-kept-contract-561.test.ts).
 */
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0)); };

function rig() {
    const requests: Array<{ path: string; body?: unknown }> = [];
    const sockets: Array<{ closed: boolean; sent: string[]; emit(frame: unknown): void }> = [];
    let watches: ReturnType<typeof hostTynnWatch> | null = null;
    const hubOf = (feed?: TynnLiveFeed) => new TynnBoardHub({
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
        send: (owner: string, event: TynnBoardHubEvent) => { if (owner === HOST_LOCAL_OWNER) watches?.deliver('features', event); },
    });
    watches = hostTynnWatch({ hubs: { board: hubOf(), issues: hubOf(), features: hubOf(TYNN_FEATURES_FEED) } });
    const events: TynnWatchEvent[] = [];
    watches.port.subscribe((event) => events.push(event));
    return { port: watches.port, events, sockets, requests };
}

it('the engine link has no Features watch: its two methods are not engine methods (Tynn #934 task #1474)', () => {
    for (const method of ['engine.tynnFeaturesWatch', 'engine.tynnFeaturesUnwatch']) expect(isEngineMethod(method), method).toBe(false);
    // CONTROL: a method the link keeps is one.
    expect(isEngineMethod('engine.heartbeat')).toBe(true);
});

it('the host signs only the Features channel, shares its socket between views, and rings only feature and domain events, to its own watch port', async () => {
    const r = rig();
    expect(await r.port.watch('features', 'view1', 'work')).toBe(true);
    expect(await r.port.watch('features', 'view2', 'work')).toBe(true);
    await settle();
    expect(r.sockets).toHaveLength(1);
    const socket = r.sockets[0]!;
    socket.emit({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: '1.2' }) });
    await settle();
    expect(r.requests.at(-1)).toEqual({ path: '/api/v1/projects/host-project/features/broadcasting-auth', body: { socket_id: '1.2', channel_name: 'private-project-features.host-project' } });
    socket.emit({ event: 'pusher_internal:subscription_succeeded', channel: 'private-project-features.host-project', data: '{}' });
    socket.emit({ event: 'feature.updated', channel: 'private-project-features.host-project', data: JSON.stringify({ feature: { id: 'f1' } }) });
    socket.emit({ event: 'domain.deleted', channel: 'private-project-features.host-project', data: JSON.stringify({ domain: { id: 'd1' } }) });
    // A board event on this channel is not a Features ring.
    socket.emit({ event: 'story.updated', channel: 'private-project-features.host-project', data: JSON.stringify({ story: { id: 's1' } }) });
    await settle();
    expect(r.events.filter((e) => 'ring' in (e.signal as object))).toEqual([
        { kind: 'features', workspaceId: 'work', signal: { ring: { ids: [], catchUp: true } } },
        { kind: 'features', workspaceId: 'work', signal: { ring: { ids: ['f1'], catchUp: false } } },
        { kind: 'features', workspaceId: 'work', signal: { ring: { ids: ['d1'], catchUp: false } } },
    ]);
    r.port.unwatch('features', 'view1');
    expect(socket.closed).toBe(false);
    r.port.unwatch('features', 'view2');
    expect(socket.closed).toBe(true);
});

it('an unlinked workspace is not followed and asks nothing', async () => {
    const r = rig();
    expect(await r.port.watch('features', 'loose', 'unlinked')).toBe(false);
    await settle();
    expect(r.requests).toEqual([]);
    expect(r.sockets).toEqual([]);
    // CONTROL: the linked workspace beside it is followed, and dials.
    expect(await r.port.watch('features', 'view', 'work')).toBe(true);
    await settle();
    expect(r.sockets).toHaveLength(1);
});

it('after the last view goes the socket is closed, and a view that watches again dials a new one', async () => {
    const r = rig();
    expect(await r.port.watch('features', 'view', 'work')).toBe(true);
    await settle();
    r.port.unwatch('features', 'view');
    await settle();
    expect(r.sockets[0]!.closed).toBe(true);
    expect(await r.port.watch('features', 'view', 'work')).toBe(true);
    await settle();
    expect(r.sockets).toHaveLength(2);
    expect(r.sockets[1]!.closed).toBe(false);
});
