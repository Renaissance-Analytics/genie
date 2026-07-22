import { describe, expect, it, vi } from 'vitest';

// The default (uninjected) socket factory constructs `ws`'s WebSocket — mock the
// module so covering that arm never dials a real Pusher endpoint. Every transport
// here injects `wsFactory`, so nothing else touches this mock.
vi.mock('ws', () => ({
    WebSocket: class {
        on(): void {}
        send(): void {}
        close(): void {}
    },
}));

import { userChannel } from '../pusher-protocol';
import {
    WorkstationPusherTransport,
    type WebSocketLike,
} from '../pusher-transport';
import { startUserChannelIssueWatch } from '../user-channel-issuewatch';
import type { IssueWatchDeltaPush } from '../workspace-assignment';

// --- pure codec -----------------------------------------------------------

describe('userChannel', () => {
    it('names the user personal broadcast channel', () => {
        expect(userChannel('42')).toBe('private-App.Models.User.42');
    });
});

// --- fake socket harness (mirrors local-workstation.test.ts) ---------------

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

/** A fetch stub that answers the user broadcasting-auth POST + the reconcile GET. */
function makeUserFetch(snapshot: unknown) {
    return vi.fn(async (url: unknown, init?: unknown) => {
        const u = String(url);
        if (u.endsWith('/api/v1/user/broadcasting-auth')) {
            return { ok: true, status: 200, json: async () => ({ auth: 'appkey:sig' }) };
        }
        if (u.endsWith('/api/v1/user/issue-watch')) {
            return { ok: true, status: 200, json: async () => snapshot };
        }
        throw new Error(`unexpected fetch ${u} ${JSON.stringify(init)}`);
    }) as unknown as typeof fetch;
}

describe('startUserChannelIssueWatch', () => {
    it('authorizes at /api/v1/user/broadcasting-auth, subscribes to the user channel, reconciles, and dispatches deltas', async () => {
        const channel = userChannel('u-1');
        const sockets: FakeSocket[] = [];
        const applyDelta = vi.fn();
        const snapshot = {
            workspaces: [
                { workspaceId: 'p1', projectId: 'p1', counts: { issue: 1, pr: 0, security: 0 }, items: [] },
                { workspaceId: 'p2', projectId: 'p2', counts: { issue: 0, pr: 2, security: 0 }, items: [] },
            ],
        };
        const fetchImpl = makeUserFetch(snapshot);

        const handle = await startUserChannelIssueWatch({
            whoami: async () => ({ id: 'u-1' }),
            broadcastConfig: async () => ({ appKey: 'k', cluster: 'us2' }),
            tynnApiBaseUrl: () => 'https://tynn.test',
            fetchImpl,
            applyDelta,
            makeTransport: (opts) =>
                new WorkstationPusherTransport({
                    appKey: opts.appKey,
                    cluster: opts.cluster,
                    channel: opts.channel,
                    authorize: opts.authorize,
                    tynnApiBaseUrl: opts.tynnApiBaseUrl,
                    wsFactory: () => {
                        const s = new FakeSocket();
                        sockets.push(s);
                        return s;
                    },
                }),
        });

        expect(handle).toMatchObject({ userId: 'u-1' });
        const sock = sockets[0];

        // connection_established → authorize (POST) → subscribe
        sock.emit('message', frame({ event: 'pusher:connection_established', data: frame({ socket_id: '9.9' }) }));
        await vi.waitFor(() =>
            expect(sock.sent.some((m) => m.includes('pusher:subscribe') && m.includes(channel))).toBe(true),
        );

        const authCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
            String(c[0]).endsWith('/api/v1/user/broadcasting-auth'),
        )!;
        expect(authCall[0]).toBe('https://tynn.test/api/v1/user/broadcasting-auth');
        const authInit = authCall[1] as { method: string; body: string };
        expect(authInit.method).toBe('POST');
        expect(JSON.parse(authInit.body)).toMatchObject({ socket_id: '9.9', channel_name: channel });

        // subscription_succeeded → onConnected → reconcile GET → applyDelta per workspace
        sock.emit('message', frame({ event: 'pusher_internal:subscription_succeeded', channel }));
        await vi.waitFor(() => expect(applyDelta).toHaveBeenCalledTimes(2));
        const reconcileCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
            String(c[0]).endsWith('/api/v1/user/issue-watch'),
        )!;
        expect(reconcileCall[0]).toBe('https://tynn.test/api/v1/user/issue-watch');
        expect(applyDelta.mock.calls.map((c) => (c[0] as IssueWatchDeltaPush).workspaceId)).toEqual(['p1', 'p2']);

        // a live push feeds the same store
        sock.emit('message', frame({
            event: 'issuewatch.delta',
            channel,
            data: frame({ workspaceId: 'p3', projectId: 'p3', counts: { issue: 5, pr: 0, security: 0 }, items: [] }),
        }));
        expect(applyDelta).toHaveBeenCalledTimes(3);
        expect((applyDelta.mock.calls[2][0] as IssueWatchDeltaPush).workspaceId).toBe('p3');
    });

    it('does NOT start (returns null, builds no transport) when whoami has no user', async () => {
        const makeTransport = vi.fn();
        const handle = await startUserChannelIssueWatch({
            whoami: async () => null,
            broadcastConfig: async () => ({ appKey: 'k', cluster: 'us2' }),
            tynnApiBaseUrl: () => 'https://tynn.test',
            fetchImpl: makeUserFetch({ workspaces: [] }),
            applyDelta: vi.fn(),
            makeTransport: makeTransport as never,
        });
        expect(handle).toBeNull();
        expect(makeTransport).not.toHaveBeenCalled();
    });

    it('does NOT start when no broadcast config resolves', async () => {
        const makeTransport = vi.fn();
        const handle = await startUserChannelIssueWatch({
            whoami: async () => ({ id: 'u-1' }),
            broadcastConfig: async () => null,
            tynnApiBaseUrl: () => 'https://tynn.test',
            fetchImpl: makeUserFetch({ workspaces: [] }),
            applyDelta: vi.fn(),
            makeTransport: makeTransport as never,
        });
        expect(handle).toBeNull();
        expect(makeTransport).not.toHaveBeenCalled();
    });
});
