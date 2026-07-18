import { describe, expect, it, vi } from 'vitest';

// The default (uninjected) socket factory constructs `ws`'s WebSocket — mock the
// module so covering that arm never dials a real Pusher endpoint. Every transport
// test here injects `wsFactory`, so nothing else touches this mock.
vi.mock('ws', () => ({
    WebSocket: class {
        on(): void {}
        send(): void {}
        close(): void {}
    },
}));

import {
    isIssueWatchDelta,
    parsePusherFrame,
    toIssueWatchDelta,
    workstationChannel,
} from '../pusher-protocol';
import {
    WorkstationPusherTransport,
    type WebSocketLike,
} from '../pusher-transport';
import {
    parseIssueWatchSnapshot,
    resolveBroadcastConfig,
    startLocalWorkstation,
    syncWorkstationInventory,
    type WorkstationTransportLike,
} from '../local-workstation';
import type { IssueWatchDeltaPush } from '../workspace-assignment';
import type { WorkstationIdentity } from '../workstation-identity';

// --- pure codec -----------------------------------------------------------

describe('pusher-protocol (lifted codec)', () => {
    it('names the private-workstation channel', () => {
        expect(workstationChannel('ws-1')).toBe('private-workstation.ws-1');
    });

    it('recognises + coerces an issuewatch.delta frame for our channel', () => {
        const chan = workstationChannel('p1');
        const frame = parsePusherFrame(
            JSON.stringify({
                event: 'issuewatch.delta',
                channel: chan,
                data: JSON.stringify({
                    workspaceId: 'p1',
                    counts: { issue: 2, pr: 1, security: 0 },
                    items: [{ key: 'o/r:issue:1' }],
                }),
            }),
        );
        expect(isIssueWatchDelta(frame!, chan)).toBe(true);
        expect(toIssueWatchDelta(frame!.data)).toMatchObject({
            workspaceId: 'p1',
            projectId: 'p1',
            counts: { issue: 2, pr: 1, security: 0 },
        });
        expect(toIssueWatchDelta(frame!.data)!.items).toHaveLength(1);
    });

    it('coerces a bare projectId + drops an id-less payload', () => {
        expect(toIssueWatchDelta({ projectId: 'p2' })).toMatchObject({
            workspaceId: 'p2',
            counts: { issue: 0, pr: 0, security: 0 },
            items: [],
        });
        expect(toIssueWatchDelta({ counts: {} })).toBeNull();
    });
});

// --- transport dispatch (fake socket) -------------------------------------

class FakeSocket implements WebSocketLike {
    listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    sent: string[] = [];
    closed = false;
    on(ev: string, cb: (...a: unknown[]) => void): void {
        (this.listeners[ev] ??= []).push(cb);
    }
    send(d: string): void {
        this.sent.push(d);
    }
    close(): void {
        this.closed = true;
        this.emit('close');
    }
    emit(ev: string, ...args: unknown[]): void {
        (this.listeners[ev] ?? []).forEach((cb) => cb(...args));
    }
}

function frame(obj: unknown): string {
    return JSON.stringify(obj);
}

describe('WorkstationPusherTransport', () => {
    it('authorizes with the workstation proof, subscribes, then fires onConnected', async () => {
        const channel = workstationChannel('ws-1');
        const sockets: FakeSocket[] = [];
        const fetchImpl = vi.fn(async () => ({
            ok: true,
            json: async () => ({ auth: 'appkey:sig' }),
        })) as unknown as typeof fetch;

        const transport = new WorkstationPusherTransport({
            appKey: 'k',
            cluster: 'us2',
            workstationId: 'ws-1',
            tynnApiBaseUrl: 'https://tynn.test',
            signer: { authHeader: () => 'Workstation 123:sig' },
            fetchImpl,
            wsFactory: () => {
                const s = new FakeSocket();
                sockets.push(s);
                return s;
            },
        });

        const onConnected = vi.fn();
        transport.open({ onConnected, onIssueWatchDelta: vi.fn() });
        const sock = sockets[0];

        // connection_established → authorize + subscribe (async auth chain)
        sock.emit('message', frame({ event: 'pusher:connection_established', data: frame({ socket_id: '1.2' }) }));
        await vi.waitFor(() =>
            expect(sock.sent.some((m) => m.includes('pusher:subscribe') && m.includes(channel))).toBe(true),
        );

        expect(fetchImpl).toHaveBeenCalledOnce();
        const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(url).toBe('https://tynn.test/api/v1/workstations/ws-1/broadcasting-auth');
        expect((init as { headers: Record<string, string> }).headers.authorization).toBe('Workstation 123:sig');

        // subscription_succeeded → onConnected (the reconcile trigger)
        sock.emit('message', frame({ event: 'pusher_internal:subscription_succeeded', channel }));
        expect(onConnected).toHaveBeenCalledOnce();
    });

    it('answers pusher:ping with a pong (keeps the idle socket alive, no poll)', () => {
        const sockets: FakeSocket[] = [];
        const transport = new WorkstationPusherTransport({
            appKey: 'k',
            cluster: 'us2',
            workstationId: 'ws-1',
            tynnApiBaseUrl: 'https://tynn.test',
            signer: { authHeader: () => 'Workstation 1:s' },
            fetchImpl: (async () => ({ ok: true, json: async () => ({ auth: 'a' }) })) as unknown as typeof fetch,
            wsFactory: () => {
                const s = new FakeSocket();
                sockets.push(s);
                return s;
            },
        });
        transport.open({ onConnected: vi.fn(), onIssueWatchDelta: vi.fn() });
        sockets[0].emit('message', frame({ event: 'pusher:ping' }));
        expect(sockets[0].sent.some((m) => m.includes('pusher:pong'))).toBe(true);
    });

    it('dispatches onIssueWatchDelta on an issuewatch.delta push (client stops polling)', () => {
        const channel = workstationChannel('ws-1');
        const sockets: FakeSocket[] = [];
        const transport = new WorkstationPusherTransport({
            appKey: 'k',
            cluster: 'us2',
            workstationId: 'ws-1',
            tynnApiBaseUrl: 'https://tynn.test',
            signer: { authHeader: () => 'Workstation 1:s' },
            fetchImpl: (async () => ({ ok: true, json: async () => ({ auth: 'a' }) })) as unknown as typeof fetch,
            wsFactory: () => {
                const s = new FakeSocket();
                sockets.push(s);
                return s;
            },
        });

        const onIssueWatchDelta = vi.fn();
        transport.open({ onConnected: vi.fn(), onIssueWatchDelta });
        const sock = sockets[0];

        sock.emit('message', frame({
            event: 'issuewatch.delta',
            channel,
            data: frame({ workspaceId: 'p1', projectId: 'p1', counts: { issue: 3, pr: 0, security: 1 }, items: [{ key: 'o/r:issue:5' }] }),
        }));
        expect(onIssueWatchDelta).toHaveBeenCalledTimes(1);
        expect(onIssueWatchDelta.mock.calls[0][0]).toMatchObject({ workspaceId: 'p1', counts: { issue: 3, pr: 0, security: 1 } });

        // An id-less delta is dropped (coercion → null), never dispatched.
        sock.emit('message', frame({ event: 'issuewatch.delta', channel, data: frame({ counts: {} }) }));
        expect(onIssueWatchDelta).toHaveBeenCalledTimes(1);
    });

    const baseOpts = (sockets: FakeSocket[]) => ({
        appKey: 'k',
        cluster: 'us2',
        workstationId: 'ws-1',
        tynnApiBaseUrl: 'https://tynn.test',
        signer: { authHeader: () => 'Workstation 1:s' },
        fetchImpl: (async () => ({ ok: true, json: async () => ({ auth: 'a' }) })) as unknown as typeof fetch,
        reconnectDelayMs: 60_000,
        wsFactory: () => {
            const s = new FakeSocket();
            sockets.push(s);
            return s;
        },
    });

    it('does NOT fire onDisconnected when the caller closes intentionally (e.g. sign-out)', () => {
        const sockets: FakeSocket[] = [];
        const transport = new WorkstationPusherTransport(baseOpts(sockets));
        const onDisconnected = vi.fn();
        const handle = transport.open({ onConnected: vi.fn(), onIssueWatchDelta: vi.fn(), onDisconnected });
        // Intentional teardown sets closed=true, then the socket's 'close' fires
        // onDrop — which must bail (else it clobbers the caller's 'signed-out').
        handle.close();
        expect(onDisconnected).not.toHaveBeenCalled();
    });

    it('fires onDisconnected on an UNINTENDED socket drop (transport re-dials)', () => {
        const sockets: FakeSocket[] = [];
        const transport = new WorkstationPusherTransport(baseOpts(sockets));
        const onDisconnected = vi.fn();
        transport.open({ onConnected: vi.fn(), onIssueWatchDelta: vi.fn(), onDisconnected });
        sockets[0].emit('close'); // the socket dropped on its own
        expect(onDisconnected).toHaveBeenCalledOnce();
    });
});

// --- broadcast config resolution ------------------------------------------

describe('resolveBroadcastConfig', () => {
    it('prefers the env override (dev / self-host)', async () => {
        const cfg = await resolveBroadcastConfig({
            env: { GENIE_PUSHER_APP_KEY: 'envkey', GENIE_PUSHER_CLUSTER: 'eu' } as NodeJS.ProcessEnv,
            fromTynn: async () => ({ key: 'tynnkey', cluster: 'us2' }),
        });
        expect(cfg).toEqual({ appKey: 'envkey', cluster: 'eu' });
    });

    it('falls back to Tynn (default cluster us2) when no env override', async () => {
        const cfg = await resolveBroadcastConfig({
            env: {} as NodeJS.ProcessEnv,
            fromTynn: async () => ({ key: 'tynnkey' }),
        });
        expect(cfg).toEqual({ appKey: 'tynnkey', cluster: 'us2' });
    });

    it('returns null when neither source yields a key (push stays off)', async () => {
        expect(await resolveBroadcastConfig({ env: {} as NodeJS.ProcessEnv })).toBeNull();
        expect(
            await resolveBroadcastConfig({ env: {} as NodeJS.ProcessEnv, fromTynn: async () => null }),
        ).toBeNull();
    });
});

// --- reconcile-snapshot parsing -------------------------------------------

describe('parseIssueWatchSnapshot', () => {
    it('coerces { workspaces: [...] } rows, dropping id-less ones', () => {
        const out = parseIssueWatchSnapshot({
            workspaces: [
                { workspaceId: 'p1', counts: { issue: 1, pr: 0, security: 0 }, items: [] },
                { counts: {} }, // no id → dropped
                { projectId: 'p2', counts: { issue: 0, pr: 2, security: 0 }, items: [{ key: 'x' }] },
            ],
        });
        expect(out.map((d) => d.workspaceId)).toEqual(['p1', 'p2']);
        expect(out[1].projectId).toBe('p2');
    });

    it('is empty for a non-object / non-array body', () => {
        expect(parseIssueWatchSnapshot(null)).toEqual([]);
        expect(parseIssueWatchSnapshot({ workspaces: 'nope' })).toEqual([]);
    });
});

// --- orchestration (fully faked) ------------------------------------------

function identity(id = 'ws-1'): WorkstationIdentity {
    return { workstationId: id, authHeader: () => 'Workstation 1:sig' };
}

it('syncs workspace-owned site inventory with workstation authentication', async () => {
    const request = vi.fn(async () => new Response('{}', { status: 200 }));
    await syncWorkstationInventory(
        identity(),
        'https://tynn.test/',
        {
            workspaces: [{
                id: 'local-1',
                name: 'Local only',
                projectId: null,
                sites: [{ id: 'site-1', name: 'app.gen', hostname: 'app.test' }],
            }],
        },
        request as typeof fetch,
    );

    expect(request).toHaveBeenCalledWith(
        'https://tynn.test/api/v1/workstations/ws-1/inventory',
        expect.objectContaining({
            method: 'PUT',
            headers: expect.objectContaining({ authorization: 'Workstation 1:sig' }),
            body: JSON.stringify({
                workspaces: [{
                    workspace_id: 'local-1',
                    name: 'Local only',
                    project_id: null,
                    sites: [{ site_id: 'site-1', name: 'app.gen', hostname: 'app.test' }],
                }],
            }),
        }),
    );
});

/** A fake transport that captures the handlers so the test can drive connect/push. */
function fakeTransport() {
    const handlers: {
        onConnected?: () => void;
        onIssueWatchDelta?: (d: IssueWatchDeltaPush) => void;
    } = {};
    const closed = { value: false };
    const transport: WorkstationTransportLike = {
        open(h) {
            handlers.onConnected = h.onConnected;
            handlers.onIssueWatchDelta = h.onIssueWatchDelta;
            return { close: () => (closed.value = true) };
        },
    };
    return { transport, handlers, closed };
}

describe('startLocalWorkstation', () => {
    it('re-enrolls once when the persisted workstation no longer exists on Tynn', async () => {
        const { transport } = fakeTransport();
        const stale = identity('ws-stale');
        const fresh = identity('ws-fresh');
        const ensure = vi.fn()
            .mockResolvedValueOnce({ status: 'exists', workstationId: 'ws-stale' })
            .mockResolvedValueOnce({ status: 'enrolled', workstationId: 'ws-fresh' });
        const readIdentity = vi.fn()
            .mockReturnValueOnce(stale)
            .mockReturnValueOnce(fresh);
        const resetIdentity = vi.fn();
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce({ ok: false, status: 404 })
            .mockResolvedValueOnce({ ok: true, status: 200 });
        const makeTransport = vi.fn(() => transport);

        const handle = await startLocalWorkstation({
            ensure,
            identity: readIdentity,
            resetIdentity,
            features: async () => ({ issuewatch: true, agentinbox: false }),
            broadcastConfig: async () => ({ appKey: 'k', cluster: 'us2' }),
            tynnApiBaseUrl: () => 'https://tynn.test',
            inventory: async () => ({ workspaces: [] }),
            fetchImpl: fetchImpl as never,
            makeTransport,
        });

        expect(resetIdentity).toHaveBeenCalledTimes(1);
        expect(ensure).toHaveBeenCalledTimes(2);
        expect(readIdentity).toHaveBeenCalledTimes(2);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(makeTransport).toHaveBeenCalledWith(
            expect.objectContaining({ workstationId: 'ws-fresh' }),
        );
        expect(handle?.workstationId).toBe('ws-fresh');
    });

    it('does not rotate workstation identity for a transient inventory failure', async () => {
        const { transport } = fakeTransport();
        const resetIdentity = vi.fn();
        const ensure = vi.fn().mockResolvedValue({ status: 'exists', workstationId: 'ws-1' });

        const handle = await startLocalWorkstation({
            ensure,
            identity: () => identity('ws-1'),
            resetIdentity,
            features: async () => ({ issuewatch: true, agentinbox: false }),
            broadcastConfig: async () => ({ appKey: 'k', cluster: 'us2' }),
            tynnApiBaseUrl: () => 'https://tynn.test',
            inventory: async () => ({ workspaces: [] }),
            fetchImpl: vi.fn().mockRejectedValue(new Error('network down')) as never,
            makeTransport: () => transport,
        });

        expect(resetIdentity).not.toHaveBeenCalled();
        expect(ensure).toHaveBeenCalledTimes(1);
        expect(handle?.workstationId).toBe('ws-1');
    });

    it('does NOT subscribe when the IssueWatch feature is off (FMS gate)', async () => {
        const make = vi.fn();
        const handle = await startLocalWorkstation({
            ensure: async () => ({ status: 'exists', workstationId: 'ws-1' }),
            identity: () => identity(),
            features: async () => ({ issuewatch: false, agentinbox: true }),
            makeTransport: make as never,
        });
        expect(handle).toBeNull();
        expect(make).not.toHaveBeenCalled();
    });

    it('does NOT subscribe when no broadcast config resolves', async () => {
        const make = vi.fn();
        const handle = await startLocalWorkstation({
            ensure: async () => ({ status: 'enrolled', workstationId: 'ws-1' }),
            identity: () => identity(),
            features: async () => ({ issuewatch: true, agentinbox: false }),
            broadcastConfig: async () => null,
            makeTransport: make as never,
        });
        expect(handle).toBeNull();
        expect(make).not.toHaveBeenCalled();
    });

    it('subscribes and, on connect, reconciles the snapshot into applyDelta per workspace', async () => {
        const { transport, handlers } = fakeTransport();
        const applyDelta = vi.fn();
        const snapshot: IssueWatchDeltaPush[] = [
            { workspaceId: 'p1', projectId: 'p1', counts: { issue: 1, pr: 0, security: 0 }, items: [] },
            { workspaceId: 'p2', projectId: 'p2', counts: { issue: 0, pr: 3, security: 0 }, items: [] },
        ];

        const handle = await startLocalWorkstation({
            ensure: async () => ({ status: 'exists', workstationId: 'ws-1' }),
            identity: () => identity(),
            features: async () => ({ issuewatch: true, agentinbox: false }),
            broadcastConfig: async () => ({ appKey: 'k', cluster: 'us2' }),
            tynnApiBaseUrl: () => 'https://tynn.test',
            makeTransport: () => transport,
            fetchSnapshot: async () => snapshot,
            applyDelta,
        });

        expect(handle).toMatchObject({ workstationId: 'ws-1' });

        // Simulate (re)connect → the snapshot is reconciled into the store.
        handlers.onConnected!();
        await Promise.resolve();
        await Promise.resolve();
        expect(applyDelta).toHaveBeenCalledTimes(2);
        expect(applyDelta.mock.calls.map((c) => c[0].workspaceId)).toEqual(['p1', 'p2']);

        // A live push feeds the same store.
        handlers.onIssueWatchDelta!({ workspaceId: 'p3', projectId: 'p3', counts: { issue: 5, pr: 0, security: 0 }, items: [] });
        expect(applyDelta).toHaveBeenCalledTimes(3);
        expect(applyDelta.mock.calls[2][0].workspaceId).toBe('p3');
    });

    it('returns null (never throws) when ensure fails', async () => {
        const handle = await startLocalWorkstation({
            ensure: async () => {
                throw new Error('self-register 500');
            },
            makeTransport: (() => {
                throw new Error('should not reach');
            }) as never,
        });
        expect(handle).toBeNull();
    });
});
