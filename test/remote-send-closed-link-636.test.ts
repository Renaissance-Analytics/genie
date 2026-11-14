import { afterEach, describe, expect, it } from 'vitest';
import type { ActivityFeed } from '../src/core/activity-feed.js';
import { LOCAL_EVENTS, type ClientTransport } from '../src/core/remote-protocol.js';
import { connectRemote, type RemoteClient } from '../src/renderer/remote-bridge.js';

// Real bridge and native promises; only the transport is controlled. No global rejection handlers are changed.
const clients: RemoteClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function fixture(local = false) {
    let incoming: (text: string) => void = () => {};
    const closers = new Set<() => void>();
    const calls: Array<{ id: number; method: string; args: unknown[] }> = [];
    let closed = false;
    let failSend = false;
    const transport: ClientTransport = {
        send: (text) => {
            const frame = JSON.parse(text) as { kind: string; id: number; method: string; args: unknown[] };
            if (frame.kind !== 'call') return;
            calls.push(frame);
            if (failSend) throw new Error('synthetic transport write failure');
            if (closed) return; // A closed transport may silently discard a write.
        },
        onMessage: (listener) => { incoming = listener; return () => { incoming = () => {}; }; },
        onClose: (listener) => { closers.add(listener); return () => { closers.delete(listener); }; },
        close: () => { if (closed) return; closed = true; for (const listener of closers) listener(); },
    };
    const client = connectRemote(transport, local ? { kind: 'local' } : { kind: 'token', token: 'synthetic-token' }, 'fixture');
    clients.push(client);
    incoming(JSON.stringify({ kind: 'welcome', connectionId: 'fixture', host: 'fixture', isOwner: true, workspaceId: null }));
    const reply = (index: number, result: { ok: true; value: unknown } | { ok: false; reason: string }) => {
        incoming(JSON.stringify({ kind: 'result', id: calls[index]!.id, ...result }));
    };
    const emit = (channel: string, payload: unknown) => incoming(JSON.stringify({ kind: 'event', channel, payload }));
    return { client, calls, reply, emit, failSend: () => { failSend = true; } };
}

const flushed = () => new Promise<void>((resolve) => { setImmediate(resolve); });

// A bounded event-loop turn detects a permanently pending promise without waiting for the test runner's timeout.
async function settled<T>(promise: Promise<T>) {
    let timer: ReturnType<typeof setImmediate> | undefined;
    const pending = new Promise<{ kind: 'pending' }>((resolve) => { timer = setImmediate(() => resolve({ kind: 'pending' })); });
    try {
        return await Promise.race([
            promise.then((value) => ({ kind: 'answer' as const, value }), (error: unknown) => ({ kind: 'error' as const, reason: error instanceof Error ? error.message : String(error) })),
            pending,
        ]);
    } finally { if (timer !== undefined) clearImmediate(timer); }
}

describe('remote calls own transport-send failures and a closed link (#636)', () => {
    it.each([
        ['workspace repositories', (client: RemoteClient) => client.bridge.workspaces.listRepos('workspace_fixture')],
        ['agent restart', (client: RemoteClient) => client.bridge.agents.restart('agent_fixture', 'graceful')],
    ] as const)('%s returns a refusal when sending throws, rather than rejecting its answered contract', async (_label, request) => {
        const w = fixture(); await w.client.ready; w.failSend();
        await expect(request(w.client)).resolves.toEqual({ ok: false, reason: 'the connection closed' });
        expect(w.calls).toHaveLength(1); // Never replay a mutation whose delivery is uncertain.
    });

    it('a raw read still rejects with a closed-link reason when sending throws', async () => {
        const w = fixture(); await w.client.ready; w.failSend();
        await expect(w.client.bridge.snapshot()).rejects.toThrow(/^the connection closed$/);
        expect(w.calls).toHaveLength(1);
    });

    it('an answered call made after close refuses immediately without writing to the dead transport', async () => {
        const w = fixture(); await w.client.ready; w.client.close();
        expect(await settled(w.client.bridge.workspaces.settings('workspace_fixture'))).toEqual({ kind: 'answer', value: { ok: false, reason: 'the connection closed' } });
        expect(w.calls).toEqual([]);
    });

    it('a raw read made after close rejects instead of waiting forever or inventing an empty snapshot', async () => {
        const w = fixture(); await w.client.ready; w.client.close();
        expect(await settled(w.client.bridge.snapshot())).toEqual({ kind: 'error', reason: 'the connection closed' });
        expect(w.calls).toEqual([]);
    });

    it('CONTROL: a close settles both kinds of call that were already in flight', async () => {
        const w = fixture(); await w.client.ready;
        const read = expect(w.client.bridge.snapshot()).rejects.toThrow(/^the connection closed$/);
        const answer = expect(w.client.bridge.workspaces.listRepos('workspace_fixture')).resolves.toEqual({ ok: false, reason: 'the connection closed' });
        w.client.close(); await Promise.all([read, answer]);
        expect(w.calls.map((call) => call.method)).toEqual(['snapshot', 'workspaces.listRepos']);
    });

    it('CONTROL: actual successful read and action values pass through unchanged, with no extra request', async () => {
        const w = fixture(); await w.client.ready;
        const read = w.client.bridge.agentDetail('agent_fixture'); w.reply(0, { ok: true, value: null });
        await expect(read).resolves.toBeNull();
        const action = w.client.bridge.workspaces.listRepos('workspace_fixture'); const value = { ok: true, repos: [] };
        w.reply(1, { ok: true, value }); await expect(action).resolves.toEqual(value);
        expect(w.calls.map((call) => call.method)).toEqual(['agentDetail', 'workspaces.listRepos']);
    });

    it('CONTROL: a host permission refusal keeps its own reason and is never retried', async () => {
        const w = fixture(); await w.client.ready;
        const answer = w.client.bridge.agents.restart('agent_fixture', 'graceful');
        w.reply(0, { ok: false, reason: 'synthetic permission refusal' });
        await expect(answer).resolves.toEqual({ ok: false, reason: 'synthetic permission refusal' });
        expect(w.calls).toHaveLength(1); expect(w.client.state().connected).toBe(true);
    });
});

// Added after the boundary fix; temporary refusal-guard mutation + restore prove these are nonvacuous (#636).
describe('fire and watch callers own closed-link failures (#636)', () => {
    it.each(['openAgent', 'stopAgent'] as const)('%s reports a failed send through the existing refusal state, without replay', async (method) => {
        const w = fixture(); await w.client.ready; w.failSend();
        w.client.bridge[method]('agent_fixture'); await flushed();
        expect(w.client.state().lastRefusal).toBe('the connection closed');
        expect(w.calls.map((call) => call.method)).toEqual([method]);
    });

    it('a fire call after close reports refusal and sends nothing to the dead transport', async () => {
        const w = fixture(); await w.client.ready; w.client.close();
        w.client.bridge.openAgent('agent_fixture'); await flushed();
        expect(w.client.state().lastRefusal).toBe('the connection closed'); expect(w.calls).toEqual([]);
    });

    it('local activity watch and unwatch each own a failed send and report it once', async () => {
        const w = fixture(true); await w.client.ready; w.failSend();
        const off = w.client.bridge.activity!.subscribe(() => {});
        try {
            await flushed(); expect(w.client.state().lastRefusal).toBe('the connection closed');
            w.client.clearRefusal(); off(); await flushed();
            expect(w.client.state().lastRefusal).toBe('the connection closed');
            expect(w.calls.map((call) => call.method)).toEqual(['activity.watch', 'activity.unwatch']);
        } finally { off(); await flushed(); }
    });

    it('CONTROL: a successful fire call still reaches the host once without a refusal', async () => {
        const w = fixture(); await w.client.ready; w.client.bridge.openAgent('agent_fixture');
        w.reply(0, { ok: true, value: undefined }); await flushed();
        expect(w.calls.map((call) => ({ method: call.method, args: call.args }))).toEqual([{ method: 'openAgent', args: ['agent_fixture'] }]);
        expect(w.client.state().lastRefusal).toBeNull();
    });

    it('CONTROL: a normal activity subscription delivers real pushes and unwatch removes the listener', async () => {
        const w = fixture(true); await w.client.ready; const received: ActivityFeed[] = [];
        const feed: ActivityFeed = { agentId: 'agent_fixture', running: false, since: null, lastAt: null, plan: null, beats: [], items: [] };
        const off = w.client.bridge.activity!.subscribe((value) => received.push(value));
        try {
            w.reply(0, { ok: true, value: undefined }); await flushed(); w.emit(LOCAL_EVENTS.activity, feed);
            expect(received).toEqual([feed]); off();
            w.reply(1, { ok: true, value: undefined }); await flushed(); w.emit(LOCAL_EVENTS.activity, feed);
            expect(received).toEqual([feed]); expect(w.calls.map((call) => call.method)).toEqual(['activity.watch', 'activity.unwatch']);
            expect(w.client.state().lastRefusal).toBeNull();
        } finally { off(); }
    });
});
