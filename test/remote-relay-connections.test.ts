import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inMemoryPair, parseMessage, type PreAuth, type ServerConnection, type WireMessage } from '../src/core/remote-protocol.js';
import { hostRemoteApi, RemoteAccessHost } from '../src/main/remote-access-host.js';

/*
 * A RELAY CONNECTION IN GENIE-HOST'S REMOTE HOST (Tynn #409, #410). The relay host admits a Pilot or a guest by its Tynn
 * grant and hands the connection straight to the ONE remote host. It is exactly what the relay admitted, never more. Each
 * security case is shown with its control: the same path, allowed.
 */

const AGENTS = [{ id: 'agent_a', name: 'atlas', workspaceId: 'tynn' }, { id: 'agent_b', name: 'bolt', workspaceId: 'fancy' }];
const SNAPSHOT = { agents: AGENTS, workspaces: [{ id: 'tynn', path: '/w/tynn', agentsKnown: true }, { id: 'fancy', path: '/w/fancy', agentsKnown: true }], deckItems: [], signals: {} };
const OWNER: PreAuth = { label: 'glenn', isOwner: true, workspaceId: null, readonly: false };
const GUEST: PreAuth = { label: 'wren', isOwner: false, workspaceId: 'tynn', readonly: false };

let home = '';
let host: RemoteAccessHost;
let connections: Array<(c: ServerConnection) => void> = [];

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'genie2-relay-connections-'));
    connections = [];
    const api = hostRemoteApi({
        hostName: 'alphar',
        own: { snapshot: async () => SNAPSHOT, 'workspaces.confirmAdd': async () => ({ ok: true }) },
        window: { connected: () => false, invoke: async () => { throw new Error('no window'); } },
        workspaceOfAgent: (id) => AGENTS.find((a) => a.id === id)?.workspaceId ?? null,
    });
    host = await RemoteAccessHost.open({ home, hostName: 'alphar', api, transport: { onConnection: (cb) => { connections.push(cb); return () => {}; } }, now: () => 1_000_000 });
});
afterEach(async () => { await host.close(); await rm(home, { recursive: true, force: true }); });

function pilot(preAuth: PreAuth) {
    const pair = inMemoryPair();
    for (const cb of connections) cb({ ...pair.server, remoteAddress: `relay:${preAuth.label}`, preAuth });
    const inbox: WireMessage[] = [];
    const waiters: Array<(m: WireMessage) => void> = [];
    pair.client.onMessage((text) => { const r = parseMessage(text); if (!r.ok) throw new Error(r.reason); const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
    const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage>((r) => waiters.push(r)));
    let n = 0;
    return {
        hello: async (auth: object = { kind: 'relay' }) => { pair.client.send(JSON.stringify({ kind: 'hello', auth, label: 'pilot' })); return next(); },
        call: async (method: string, ...args: unknown[]) => { pair.client.send(JSON.stringify({ kind: 'call', id: ++n, method, args })); return next(); },
    };
}

describe('a relay connection is what the relay admitted, never more', () => {
    it('a relay GUEST stays scoped to its workspace (control: the owner sees the whole host)', async () => {
        const guest = pilot(GUEST);
        expect(await guest.hello()).toMatchObject({ kind: 'welcome', isOwner: false, workspaceId: 'tynn' });
        const seen = await guest.call('snapshot') as unknown as { value: { agents: Array<{ id: string }> } };
        expect(seen.value.agents.map((a) => a.id)).toEqual(['agent_a']);
        const owner = pilot(OWNER);
        expect(await owner.hello()).toMatchObject({ kind: 'welcome', isOwner: true, workspaceId: null });
        const all = await owner.call('snapshot') as unknown as { value: { agents: Array<{ id: string }> } };
        expect(all.value.agents.map((a) => a.id)).toEqual(['agent_a', 'agent_b']);
    });

    it('#348 binding: only the relay hello, never a PIN, a token or local, and nothing redeemed (control: the relay hello)', async () => {
        const { code } = host.issuePin();
        expect(await pilot(OWNER).hello({ kind: 'pin', code })).toMatchObject({ kind: 'refused', reason: expect.stringContaining('came through the Tynn relay') });
        expect(await pilot(OWNER).hello({ kind: 'token', token: 'tok0' })).toMatchObject({ kind: 'refused', reason: expect.stringContaining('came through the Tynn relay') });
        expect(await pilot(OWNER).hello({ kind: 'local' })).toMatchObject({ kind: 'refused' });
        expect(host.status().pin?.code).toBe(code);
        expect(host.status().pairRequests).toEqual([]);
        expect(await pilot(OWNER).hello()).toMatchObject({ kind: 'welcome', isOwner: true });
    });

    it('a guest never gains owner rights (control: the owner has them)', async () => {
        const guest = pilot({ ...GUEST, workspaceId: null });
        expect(await guest.hello()).toMatchObject({ kind: 'welcome', isOwner: false });
        await guest.call('baton.take');
        expect(await guest.call('workspaces.confirmAdd', {})).toMatchObject({ kind: 'result', ok: false });
        const owner = pilot(OWNER);
        await owner.hello();
        await guest.call('baton.release');
        expect(await owner.call('baton.take')).toMatchObject({ kind: 'result', ok: true });
        expect(await owner.call('workspaces.confirmAdd', {})).toMatchObject({ kind: 'result', ok: true });
    });
});
