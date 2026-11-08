import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMessage, type WireMessage } from '../src/core/remote-protocol.js';
import { hostRemoteApi, RelayBridgeHost, RemoteAccessHost, type BridgeEvent } from '../src/main/remote-access-host.js';

/*
 * THE RELAY BRIDGE (Tynn #409; the coordinator's option 1). Until the relay host moves into genie-host (P5d.3), a window's
 * relay host admits a Pilot or a guest by its Tynn grant and hands the connection to genie-host, so every remote connection
 * meets the ONE baton, lock and device list there. A bridged connection is exactly what the relay admitted, never more.
 * Each security case is shown with its control: the same path, allowed.
 */

const AGENTS = [{ id: 'agent_a', name: 'atlas', workspaceId: 'tynn' }, { id: 'agent_b', name: 'bolt', workspaceId: 'fancy' }];
const SNAPSHOT = { agents: AGENTS, workspaces: [{ id: 'tynn', path: '/w/tynn', agentsKnown: true }, { id: 'fancy', path: '/w/fancy', agentsKnown: true }], deckItems: [], signals: {} };
const OWNER = { label: 'glenn', isOwner: true, workspaceId: null, readonly: false };
const GUEST = { label: 'wren', isOwner: false, workspaceId: 'tynn', readonly: false };

let home = '';
let bridge: RelayBridgeHost;
let host: RemoteAccessHost;
const toWindow = new Map<string, BridgeEvent[]>();
const waiters = new Map<string, Array<() => void>>();

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'genie2-relay-bridge-'));
    toWindow.clear();
    waiters.clear();
    bridge = new RelayBridgeHost((owner, event) => {
        const key = `${owner}/${event.id}`;
        toWindow.set(key, [...(toWindow.get(key) ?? []), event]);
        for (const w of waiters.get(key) ?? []) w();
        waiters.delete(key);
    });
    const api = hostRemoteApi({
        hostName: 'alphar',
        own: {
            snapshot: async () => SNAPSHOT,
            openAgent: async () => ({ ok: true }),
            'workspaces.confirmAdd': async () => ({ ok: true }),
        },
        window: { connected: () => false, invoke: async () => { throw new Error('no window'); } },
        workspaceOfAgent: (id) => AGENTS.find((a) => a.id === id)?.workspaceId ?? null,
    });
    host = await RemoteAccessHost.open({ home, hostName: 'alphar', api, transport: bridge, now: () => 1_000_000 });
});
afterEach(async () => { await host.close(); await rm(home, { recursive: true, force: true }); });

/** The window's end of one bridged connection: what the Pilot sends, through the window, and what comes back. */
function pilot(owner: string, preAuth: unknown) {
    const opened = bridge.open(owner, preAuth);
    if (!opened.ok) throw new Error(opened.reason);
    const id = opened.id;
    const key = `${owner}/${id}`;
    let read = 0;
    const next = async (): Promise<WireMessage | 'closed'> => {
        while ((toWindow.get(key) ?? []).length <= read) await new Promise<void>((r) => waiters.set(key, [...(waiters.get(key) ?? []), r]));
        const event = toWindow.get(key)![read++]!;
        if ('closed' in event) return 'closed';
        const parsed = parseMessage(event.frame);
        if (!parsed.ok) throw new Error(parsed.reason);
        return parsed.message;
    };
    let n = 0;
    const send = (message: object) => bridge.frame(owner, id, JSON.stringify(message));
    return {
        id,
        hello: async (auth: object = { kind: 'relay' }) => { send({ kind: 'hello', auth, label: 'pilot' }); return next(); },
        call: async (method: string, ...args: unknown[]) => { send({ kind: 'call', id: ++n, method, args }); return next(); },
        next,
        send,
    };
}

describe('the relay bridge: a bridged connection is what the relay admitted, never more', () => {
    it('a relay GUEST stays scoped to its workspace (control: the owner sees the whole host)', async () => {
        const guest = pilot('window-1', GUEST);
        expect(await guest.hello()).toMatchObject({ kind: 'welcome', isOwner: false, workspaceId: 'tynn' });
        const seen = await guest.call('snapshot');
        expect(seen).toMatchObject({ kind: 'result', ok: true });
        expect(((seen as { value: { agents: Array<{ id: string }> } }).value.agents).map((a) => a.id)).toEqual(['agent_a']);
        const owner = pilot('window-1', OWNER);
        expect(await owner.hello()).toMatchObject({ kind: 'welcome', isOwner: true, workspaceId: null });
        const all = await owner.call('snapshot');
        expect(((all as { value: { agents: Array<{ id: string }> } }).value.agents).map((a) => a.id)).toEqual(['agent_a', 'agent_b']);
    });

    it('a forged pre-auth is refused before any connection exists (control: a relay proof opens)', () => {
        expect(bridge.open('window-1', { ...OWNER, kind: 'local' })).toMatchObject({ ok: false });
        expect(bridge.open('window-1', undefined)).toMatchObject({ ok: false });
        expect(bridge.open('window-1', { ...GUEST, isOwner: 'yes' })).toMatchObject({ ok: false });
        expect(bridge.open('window-1', { ...GUEST, token: 'tok0' })).toMatchObject({ ok: false });
        expect(bridge.open('window-1', { ...GUEST, label: '' })).toMatchObject({ ok: false });
        expect(host.status().connections).toEqual([]);
        expect(bridge.open('window-1', GUEST)).toMatchObject({ ok: true });
        expect(bridge.open('window-1', { ...GUEST, kind: 'relay' })).toMatchObject({ ok: true });
    });

    it('a replayed frame is refused: onto a closed connection, or onto another window\'s (control: its own, while open)', async () => {
        const p = pilot('window-1', GUEST);
        expect(p.send({ kind: 'hello', auth: { kind: 'relay' }, label: 'pilot' })).toEqual({ ok: true });
        await p.next();
        expect(bridge.frame('window-2', p.id, JSON.stringify({ kind: 'call', id: 1, method: 'snapshot', args: [] }))).toMatchObject({ ok: false });
        bridge.closed('window-1', p.id);
        expect(p.send({ kind: 'call', id: 2, method: 'snapshot', args: [] })).toMatchObject({ ok: false });
        expect(bridge.frame('window-1', 'not-an-id', '{}')).toMatchObject({ ok: false });
    });

    it('#348 binding holds over the bridge: only the relay hello, never a PIN, a token or local (control: the relay hello)', async () => {
        const { code } = host.issuePin();
        expect(await pilot('window-1', OWNER).hello({ kind: 'pin', code })).toMatchObject({ kind: 'refused', reason: expect.stringContaining('came through the Tynn relay') });
        expect(await pilot('window-1', OWNER).hello({ kind: 'token', token: 'tok0' })).toMatchObject({ kind: 'refused', reason: expect.stringContaining('came through the Tynn relay') });
        expect(await pilot('window-1', OWNER).hello({ kind: 'local' })).toMatchObject({ kind: 'refused' });
        // Refused before anything was redeemed: the PIN is still the one to type, and no prompt was raised.
        expect(host.status().pin?.code).toBe(code);
        expect(host.status().pairRequests).toEqual([]);
        expect(await pilot('window-1', OWNER).hello()).toMatchObject({ kind: 'welcome', isOwner: true });
    });

    it('a bridged guest never gains owner rights (control: the bridged owner has them)', async () => {
        const guest = pilot('window-1', { ...GUEST, workspaceId: null });
        expect(await guest.hello()).toMatchObject({ kind: 'welcome', isOwner: false });
        await guest.call('baton.take');
        expect(await guest.call('workspaces.confirmAdd', {})).toMatchObject({ kind: 'result', ok: false });
        const owner = pilot('window-1', OWNER);
        expect(await owner.hello()).toMatchObject({ kind: 'welcome', isOwner: true });
        await guest.call('baton.release');
        expect(await owner.call('baton.take')).toMatchObject({ kind: 'result', ok: true });
        expect(await owner.call('workspaces.confirmAdd', {})).toMatchObject({ kind: 'result', ok: true });
    });

    it('the window that opened them leaving ends its bridged connections, and only its own', async () => {
        const mine = pilot('window-1', GUEST);
        const theirs = pilot('window-2', GUEST);
        await mine.hello();
        await theirs.hello();
        bridge.dropOwner('window-1');
        expect(mine.send({ kind: 'call', id: 9, method: 'snapshot', args: [] })).toMatchObject({ ok: false });
        expect(await theirs.call('snapshot')).toMatchObject({ kind: 'result', ok: true });
    });
});
