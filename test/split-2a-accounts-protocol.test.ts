import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { capabilityOf, inMemoryPair, REMOTE_METHODS, type PreAuth, type RemoteMethod, type ServerConnection, type WireMessage } from '../src/core/remote-protocol.js';
import type { LocalFramePort } from '../src/core/local-frame.js';
import type { AccountsSnapshot } from '../src/core/accounts-view.js';
import type { AccountsAction, AccountsActResult } from '../src/core/account-settings.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import { ACCOUNTS_METHODS, accountsOwnAnswers, type AccountsPort } from '../src/main/accounts-protocol.js';
import { pageBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * CLIENT/HOST SPLIT STEP 2a (Tynn #895, P4 #332): the header's account chips on the ONE protocol. Every client (this
 * machine's window, a paired device, a phone) asks the host the same three methods and gets the same answer; genie-host
 * answers them itself, window or not; only a share-link guest is refused (the owner's one exception). The three IPC
 * channels the window used are gone.
 */

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const localProof: PreAuth = { kind: 'local', label: 'local', isOwner: true, workspaceId: null, readonly: false };
const SNAPSHOT: AccountsSnapshot = { providers: [], offers: [{ id: 'offer_1' } as never] };
const RENAME: AccountsAction = { kind: 'rename', id: 'acct_1', label: 'Work' };
const METHODS = ['accounts.list', 'accounts.act', 'accounts.dismissOffer'] as const;
const CHANNELS = ['genie:accounts', 'genie:accounts-act', 'genie:switch-offer-dismiss'] as const;

let dir: string, devices: DeviceStore;
const closes: Array<() => void> = [];

function port(): AccountsPort & { list: ReturnType<typeof vi.fn>; act: ReturnType<typeof vi.fn>; dismissOffer: ReturnType<typeof vi.fn> } {
    return {
        list: vi.fn(async () => SNAPSHOT),
        act: vi.fn(async (_action: AccountsAction): Promise<AccountsActResult> => ({ ok: true })),
        dismissOffer: vi.fn(async (id: string) => id === 'offer_1'),
    };
}

function server(accounts: AccountsPort | undefined) {
    const deps: HostApiDeps = { ...protocolContractDeps(dir), ...(accounts ? { accounts } : {}) };
    const api = buildHostApi(deps), invoke = vi.spyOn(api, 'invoke');
    let accept!: (connection: ServerConnection) => void;
    const host = new RemoteHost({ api, hostName: 'accounts-host', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing,
        transport: { onConnection: (listener) => { accept = listener; return () => {}; } } });
    /** A raw connection: a paired device (token), or one the relay proved (an owner or a guest). */
    function raw(proof?: PreAuth, mobile = false) {
        const pair = inMemoryPair(), frames: WireMessage[] = [];
        pair.client.onMessage((text) => { frames.push(JSON.parse(text) as WireMessage); });
        accept({ ...pair.server, ...(proof ? { preAuth: proof } : {}) }); closes.push(() => pair.client.close());
        let id = 0;
        const send = async (frame: unknown) => { frames.length = 0; pair.client.send(JSON.stringify(frame)); await tick(); await tick(); return frames.filter((f) => f.kind !== 'event').at(-1); };
        return {
            hello: () => send({ kind: 'hello', auth: proof ? { kind: proof.kind === 'local' ? 'local' : 'relay' } : { kind: 'token', token: devices.pair('owner').token }, ...(mobile ? { profile: 'mobile' } : {}) }),
            call: (method: string, ...args: unknown[]) => send({ kind: 'call', id: ++id, method, args }),
        };
    }
    function framePort(): LocalFramePort {
        const listeners = new Set<Parameters<LocalFramePort['onFrame']>[0]>();
        let active: ReturnType<typeof inMemoryPair> | undefined, handle = '';
        return { onFrame: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, send: (action, id, text) => {
            if (action === 'open') {
                active?.client.close(); active = inMemoryPair(); handle = id;
                active.client.onMessage((frame) => { for (const listener of listeners) listener('frame', handle, frame); });
                active.client.onClose(() => { for (const listener of listeners) listener('closed', handle, ''); });
                closes.push(() => active?.client.close()); accept({ ...active.server, preAuth: localProof });
            } else if (action === 'frame') active?.client.send(text); else active?.client.close();
        } };
    }
    return {
        host, invoke, raw, framePort,
        local: async () => {
            const pair = inMemoryPair(); accept({ ...pair.server, preAuth: localProof });
            const client = connectRemote(pair.client, { kind: 'local' }, 'accounts-local'); closes.push(() => client.close());
            expect(await client.ready).toEqual({ ok: true }); return client;
        },
        paired: async () => {
            const pair = inMemoryPair(); accept(pair.server);
            const client = connectRemote(pair.client, { kind: 'pin', code: host.issuePin().code }, 'accounts-remote'); closes.push(() => client.close());
            expect(await client.ready).toEqual({ ok: true });
            expect(await client.takeBaton()).toEqual({ ok: true });
            return client;
        },
    };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-split-2a-')); let seq = 0;
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => `split2a-${++seq}` });
});
afterEach(async () => {
    for (const close of closes.splice(0)) close(); vi.unstubAllGlobals(); await tick(); await devices.flushed(); await rm(dir, { recursive: true, force: true });
});

describe('the accounts family is on the remote wire, for every client', () => {
    it('is in the protocol table: a read and two writes, never local or host-only (the owner: remote gets every host feature)', () => {
        for (const method of METHODS) expect(REMOTE_METHODS).toContain(method);
        expect(capabilityOf('accounts.list' as RemoteMethod)).toBe('read');
        expect(capabilityOf('accounts.act' as RemoteMethod)).toBe('write');
        expect(capabilityOf('accounts.dismissOffer' as RemoteMethod)).toBe('write');
        expect([...ACCOUNTS_METHODS].sort()).toEqual([...METHODS].sort());
    });

    it('this machine\'s window and a paired device get the same answers from the same host functions', async () => {
        const accounts = port(), source = server(accounts);
        const here = await source.local(), there = await source.paired();
        for (const client of [here, there]) {
            expect(await client.bridge.accounts!()).toEqual(SNAPSHOT);
            expect(await client.bridge.accountsAct!(RENAME)).toEqual({ ok: true });
            expect(await client.bridge.dismissSwitchOffer!('offer_1')).toBe(true);
            expect(await client.bridge.dismissSwitchOffer!('offer_gone')).toBe(false);
        }
        expect(accounts.list).toHaveBeenCalledTimes(2);
        // The action, and WHO asked (Tynn #1011: a browser sign-in opens on the screen of the window that asked).
        expect(accounts.act.mock.calls.map((c: unknown[]) => c[0])).toEqual([RENAME, RENAME]);
        for (const c of accounts.act.mock.calls as unknown[][]) expect(c[1]).toMatchObject({ connectionId: expect.any(String) });
        expect(accounts.dismissOffer.mock.calls).toEqual([['offer_1'], ['offer_gone'], ['offer_1'], ['offer_gone']]);
    });

    it('a phone and a relay owner are answered too', async () => {
        const accounts = port(), source = server(accounts);
        for (const peer of [source.raw(undefined, true), source.raw({ kind: 'relay', label: 'relay owner', isOwner: true, workspaceId: null, readonly: false })]) {
            expect(await peer.hello()).toMatchObject({ kind: 'welcome' });
            expect(await peer.call('accounts.list')).toEqual({ kind: 'result', id: 1, ok: true, value: SNAPSHOT });
        }
    });

    it.each([
        ['workspace guest', 'work'],
        ['host guest', null],
    ] as const)('a share-link %s is refused every accounts method, and no host function runs', async (label, workspaceId) => {
        const accounts = port(), source = server(accounts);
        const guest = source.raw({ kind: 'relay', label, isOwner: false, workspaceId, readonly: false });
        expect(await guest.hello()).toMatchObject({ kind: 'welcome' });
        for (const method of METHODS) expect(await guest.call(method, method === 'accounts.act' ? RENAME : 'offer_1')).toMatchObject({ kind: 'result', ok: false, reason: expect.any(String) });
        expect(accounts.list).not.toHaveBeenCalled(); expect(accounts.act).not.toHaveBeenCalled(); expect(accounts.dismissOffer).not.toHaveBeenCalled();
    });

    it.each([undefined, null, 42, 'rename', {}, { kind: 'rename', id: 'acct_1' }, { kind: 'forget', id: '' }, { kind: 'wipe', id: 'acct_1' }].map((raw) => [raw]))(
        'accounts.act refuses %j in words before any host function runs', async (raw) => {
            const accounts = port(), here = await server(accounts).local();
            expect(await here.bridge.accountsAct!(raw as never)).toEqual({ ok: false, reason: 'That is not an account action.' });
            expect(accounts.act).not.toHaveBeenCalled();
        });

    it('a host with no accounts answers null, a refusal in words, and false, never a hang', async () => {
        const here = await server(undefined).local();
        expect(await here.bridge.accounts!()).toBeNull();
        expect(await here.bridge.accountsAct!(RENAME)).toEqual({ ok: false, reason: 'The accounts are not ready on this host yet.' });
        expect(await here.bridge.dismissSwitchOffer!('offer_1')).toBe(false);
    });

    it('a host that does not know the method (an older host) answers the client null / a refusal / false', async () => {
        // An older host replies `unsupported` with the call's id (Tynn #894); the client turns that into its own "nothing".
        const pair = inMemoryPair();
        pair.server.onMessage((text) => {
            const frame = JSON.parse(text) as WireMessage;
            if (frame.kind === 'hello') pair.server.send(JSON.stringify({ kind: 'welcome', connectionId: 'old', host: 'old-host', isOwner: true, workspaceId: null }));
            if (frame.kind === 'call') pair.server.send(JSON.stringify({ kind: 'result', id: frame.id, ok: false, code: 'unsupported', reason: `old-host does not support ${frame.method}` }));
        });
        const client = connectRemote(pair.client, { kind: 'local' }, 'old-host-client'); closes.push(() => client.close());
        expect(await client.ready).toEqual({ ok: true });
        expect(await client.bridge.accounts!()).toBeNull();
        expect(await client.bridge.accountsAct!(RENAME)).toEqual({ ok: false, reason: 'old-host does not support accounts.act' });
        expect(await client.bridge.dismissSwitchOffer!('offer_1')).toBe(false);
    });
});

describe('genie-host answers the accounts family itself, window or not', () => {
    it('its own answers run ahead of everything else (Tynn #898: there is no window to ask)', async () => {
        const accounts = port(), aloneInvoke = vi.fn(async () => 'from the host\'s other answers');
        const api = hostRemoteApi({ hostName: 'host', own: { ...accountsOwnAnswers(accounts) }, alone: { invoke: aloneInvoke, onEvent: () => () => {}, workspaceOfAgent: () => null } });
        expect(await api.invoke('accounts.list' as RemoteMethod, [])).toEqual(SNAPSHOT);
        expect(await api.invoke('accounts.act' as RemoteMethod, [RENAME])).toEqual({ ok: true });
        expect(await api.invoke('accounts.dismissOffer' as RemoteMethod, ['offer_1'])).toBe(true);
        expect(aloneInvoke).not.toHaveBeenCalled();
    });

    it('and before the rest of genie-host\'s answers are built', async () => {
        const accounts = port();
        const api = hostRemoteApi({ hostName: 'host', own: { ...accountsOwnAnswers(accounts) } });
        expect(await api.invoke('accounts.list' as RemoteMethod, [])).toEqual(SNAPSHOT);
    });

    it('genie-host puts them in its own answers, from its accounts book', () => {
        const host = readFileSync('src/main/genie-host.ts', 'utf8');
        expect(host).toMatch(/own:\s*\{[^}]*\.\.\.accountsOwnAnswers\(/);
    });
});

describe('the window no longer reaches accounts through IPC', () => {
    it('pageBridge takes all three from the local protocol connection, never the preload', async () => {
        const accounts = port(), source = server(accounts);
        vi.stubGlobal('window', { genieLocalProtocol: source.framePort() });
        const native = { accounts: vi.fn(), accountsAct: vi.fn(), dismissSwitchOffer: vi.fn() };
        const bridge = pageBridge({ ...native, subscribeAgentWire: () => () => {}, workspaces: {} } as unknown as PreloadBridge);
        expect(await bridge.accounts!()).toEqual(SNAPSHOT);
        expect(await bridge.accountsAct!(RENAME)).toEqual({ ok: true });
        expect(await bridge.dismissSwitchOffer!('offer_1')).toBe(true);
        for (const fn of Object.values(native)) expect(fn).not.toHaveBeenCalled();
        expect(source.invoke.mock.calls.map(([method]) => method)).toEqual([...METHODS]);
    });

    it('main, the preload and the IPC inventory no longer carry the three channels', () => {
        const main = readFileSync('src/main/main.ts', 'utf8'), preload = readFileSync('src/main/preload.ts', 'utf8'), inventory = readFileSync('src/core/ipc-inventory.ts', 'utf8');
        for (const channel of CHANNELS) {
            expect(main).not.toContain(`'${channel}'`);
            expect(preload).not.toContain(`'${channel}'`);
            expect(inventory).not.toContain(`'${channel}'`);
        }
    });
});
