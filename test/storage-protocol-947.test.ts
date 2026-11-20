import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, parseMessage, type ClientTransport, type PreAuth, type WireMessage } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/**
 * CLEAN UP'S ACTIONS GO OVER THE ONE PROTOCOL, AND ONLY THE OWNER'S ARE TAKEN (Tynn #947). Move to .trash and Empty trash
 * change the host's disk, so a remote client's are refused unless it is the host's owner: the action is the feature
 * protocol's `features.act` (core/remote-protocol.ts), never a window-only path, and RemoteHost refuses it, in words and
 * before the host API is asked, for anyone else.
 */
const ACTIONS = [
    { kind: 'storage.trash', workspaceId: 'tynn', itemId: 'worktrees:wt/a' },
    { kind: 'storage.cleanUp', workspaceId: 'tynn', itemIds: ['worktrees:wt/a'] },
    { kind: 'storage.emptyTrash', workspaceId: 'tynn', approval: { ids: ['old'], bytes: 1 } },
    { kind: 'storage.restore', workspaceId: 'tynn', trashId: 'genie-1-abcdef' },
] as const;

function fakeApi() {
    const acted: unknown[] = [];
    const api: HostApi = {
        invoke: async (method, args) => {
            if (method === 'snapshot') return { agents: [], workspaces: [], deckItems: [], signals: {} };
            if (method === 'features.act') { acted.push(args[0]); return { ok: true }; }
            return { ok: true };
        },
        onEvent: () => () => {},
        workspaceOfAgent: () => 'tynn',
        workspaceOfTerminal: () => 'tynn',
        workspacePaths: () => ({ tynn: '/w/tynn' }),
    };
    return { api, acted };
}

function client(t: ClientTransport) {
    const inbox: WireMessage[] = [];
    const waiters: Array<(m: WireMessage) => void> = [];
    t.onMessage((text) => { const r = parseMessage(text); if (!r.ok) throw new Error(r.reason); const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
    const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage>((r) => waiters.push(r)));
    let id = 0;
    return {
        hello: async (label: string) => { t.send(JSON.stringify({ kind: 'hello', auth: { kind: 'relay' }, label })); let m = await next(); while (m.kind === 'pairing') m = await next(); return m; },
        call: async (method: string, ...args: unknown[]) => { t.send(JSON.stringify({ kind: 'call', id: ++id, method, args })); let m = await next(); while (m.kind === 'event') m = await next(); return m; },
    };
}

const OWNER: PreAuth = { label: 'studio', isOwner: true, workspaceId: null, readonly: false };
const GUEST: PreAuth = { label: 'wren', isOwner: false, workspaceId: 'tynn', readonly: false };
const DEVICE: PreAuth = { label: 'pat-laptop', isOwner: false, workspaceId: null, readonly: false };

describe('Clean up over the protocol (Tynn #947)', () => {
    let dir: string;
    let devices: DeviceStore;
    let api: ReturnType<typeof fakeApi>;
    let connect: (pre: PreAuth) => ReturnType<typeof client>;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-947-protocol-'));
        let n = 0;
        devices = await DeviceStore.open(dir, { now: () => 1_000_000, random: () => `tok${n++}` });
        api = fakeApi();
        const connections: Array<(c: ReturnType<typeof inMemoryPair>['server']) => void> = [];
        new RemoteHost({
            api: api.api, hostName: 'alphar', baton: new Baton(), pins: new PairingPins({ now: () => 1_000_000 }), devices, confirm: allowEveryPairing,
            transport: { onConnection: (cb) => { connections.push(cb); return () => {}; } }, now: () => 1_000_000,
        });
        connect = (pre) => {
            const pair = inMemoryPair();
            for (const cb of connections) cb({ ...pair.server, remoteAddress: `relay:${pre.label}`, preAuth: pre });
            return client(pair.client);
        };
    });
    afterEach(async () => { await devices.flushed(); await rm(dir, { recursive: true, force: true }); });

    async function driving(pre: PreAuth) {
        const c = connect(pre);
        expect(await c.hello(pre.label)).toMatchObject({ kind: 'welcome' });
        await c.call('baton.watch');
        await c.call('baton.take');
        return c;
    }

    it('CONTROL: the owner’s Move, Clean up, Empty and Restore reach the host as features.act, unchanged', async () => {
        const owner = await driving(OWNER);
        for (const a of ACTIONS) expect(await owner.call('features.act', a)).toMatchObject({ kind: 'result', ok: true });
        expect(api.acted).toEqual(ACTIONS);
    });

    for (const [who, pre] of [['a guest of one workspace', GUEST], ['a device that is not the owner', DEVICE]] as const) {
        it(`${who}: each is refused in words, and the host API is never asked`, async () => {
            const c = await driving(pre);
            for (const a of ACTIONS) {
                const r = await c.call('features.act', a);
                expect(r).toMatchObject({ kind: 'result', ok: false, reason: expect.stringMatching(/alphar itself/) });
            }
            expect(api.acted).toEqual([]);
        });
    }
});
