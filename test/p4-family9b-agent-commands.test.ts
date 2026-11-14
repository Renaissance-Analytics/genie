import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LocalFramePort } from '../src/core/local-frame.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, parseMessage, type ServerConnection, type WireMessage } from '../src/core/remote-protocol.js';
import { buildHostApi } from '../src/main/host-api.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { pageBridge, type GenieBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';

/*
 * P4 FAMILY 9B (Tynn #563): the nine agent commands leave the window's IPC. A refusal lands where the IPC path put it, the
 * baton does not gate this machine's own window, and a window whose connection went gets an answer rather than a throw.
 */
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise<void>((r) => setImmediate(r)); };
const closers: Array<() => void> = [];
let dir: string;
let devices: DeviceStore;
let baton: Baton;

function serve(api: HostApi) {
    let accept!: (c: ServerConnection) => void;
    baton = new Baton();
    new RemoteHost({ api, hostName: 'cmd-host', baton, devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing, transport: { onConnection: (l) => { accept = l; return () => {}; } } });
    const framePort = () => {
        const pair = inMemoryPair();
        closers.push(() => pair.client.close());
        const listeners = new Set<Parameters<LocalFramePort['onFrame']>[0]>();
        let handle = '';
        pair.client.onMessage((t) => { for (const l of listeners) l('frame', handle, t); });
        pair.client.onClose(() => { for (const l of listeners) l('closed', handle, ''); });
        const port: LocalFramePort = {
            onFrame: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
            send: (action, id, text) => {
                if (action === 'open') { handle = id; accept({ ...pair.server, preAuth: { kind: 'local', label: 'page', isOwner: true, workspaceId: null, readonly: false, window: 'main' } }); }
                else if (action === 'frame') pair.client.send(text);
                else pair.client.close();
            },
        };
        return { port, drop: () => pair.client.close() };
    };
    const relay = async () => {
        const pair = inMemoryPair();
        const inbox: WireMessage[] = [];
        pair.client.onMessage((t) => { const r = parseMessage(t); if (r.ok) inbox.push(r.message); });
        accept({ ...pair.server, remoteAddress: 'relay:x', preAuth: { label: 'pat', isOwner: true, workspaceId: null, readonly: false } });
        pair.client.send(JSON.stringify({ kind: 'hello', auth: { kind: 'relay' } }));
        await vi.waitFor(() => expect(inbox.some((m) => m.kind === 'welcome')).toBe(true));
        return async (method: string, args: unknown[]) => {
            pair.client.send(JSON.stringify({ kind: 'call', id: 9, method, args }));
            await vi.waitFor(() => expect(inbox.some((m) => m.kind === 'result')).toBe(true));
            return inbox.find((m) => m.kind === 'result');
        };
    };
    return { framePort, relay };
}

const preloadWith = (old: unknown) => new Proxy({ snapshot: async () => ({ workspaces: null }), subscribeAgentWire: () => () => {}, workspaces: {}, features: {} } as Record<string, unknown>, {
    get: (t, k) => (typeof k === 'string' && NINE.includes(k) ? old : t[k as string]),
}) as unknown as PreloadBridge;
// Restart with handoff left with the Deck's handoff band (Tynn #658): eight commands now.
const NINE = ['openAgent', 'stopAgent', 'resumeLimit', 'cancelTurn', 'prompt', 'resolvePrompt', 'answerApproval', 'addAgent'];
const bridgeOn = (port: LocalFramePort, old: unknown = vi.fn()) => { vi.stubGlobal('window', { genieLocalProtocol: port }); return pageBridge(preloadWith(old)); };
function fakeApi(result: unknown = { ok: true }) {
    const invoke = vi.fn(async () => result);
    const api: HostApi = { invoke: invoke as unknown as HostApi['invoke'], onEvent: () => () => {}, workspaceOfAgent: () => 'ws' };
    return { api, invoke };
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-p4-9b-')); let n = 0; devices = await DeviceStore.open(dir, { now: Date.now, random: () => `cmd-${++n}` }); });
afterEach(async () => { for (const c of closers.splice(0)) c(); vi.unstubAllGlobals(); await settle(); await devices.flushed(); await rm(dir, { recursive: true, force: true }); });

const rows: Array<{ method: string; args: unknown[]; call: (b: GenieBridge) => unknown; answers?: boolean }> = [
    { method: 'openAgent', args: ['a1'], call: (b) => b.openAgent('a1') },
    { method: 'stopAgent', args: ['a1'], call: (b) => b.stopAgent('a1') },
    { method: 'resumeLimit', args: ['a1'], call: (b) => b.resumeLimit('a1'), answers: true },
    { method: 'cancelTurn', args: ['a1', 'interrupt'], call: (b) => b.cancelTurn('a1', 'interrupt'), answers: true },
    { method: 'prompt', args: ['a1', 'hi'], call: (b) => b.prompt('a1', 'hi'), answers: true },
    { method: 'resolvePrompt', args: ['a1', 'p1', 'send'], call: (b) => b.resolvePrompt('a1', 'p1', 'send'), answers: true },
    { method: 'answerApproval', args: ['a1', 'allow', 'note'], call: (b) => b.answerApproval('a1', 'allow', 'note'), answers: true },
    { method: 'addAgent', args: ['ws', { name: 'n', purpose: '', provider: 'claude' }], call: (b) => b.addAgent('ws', { name: 'n', purpose: '', provider: 'claude' } as never), answers: true },
];

describe('the nine cross the door', () => {
    it.each(rows)('$method reaches the host with its arguments, never the preload', async (row) => {
        const f = fakeApi();
        const old = vi.fn(async () => { throw new Error('old native path'); });
        const bridge = bridgeOn(serve(f.api).framePort().port, old);
        const answer = await row.call(bridge);
        await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledExactlyOnceWith(row.method, row.args, expect.objectContaining({ origin: 'local-window' })));
        expect(old).not.toHaveBeenCalled();
        if (row.answers) expect(answer).toEqual(expect.objectContaining({ ok: true }));
    });

    it('a prompt with files sends them staged, and the host has the bytes', async () => {
        const f = fakeApi();
        const bridge = bridgeOn(serve(f.api).framePort().port);
        await bridge.prompt('a1', 'look', [{ name: 'a.png', type: 'image/png', bytes: new Uint8Array([1, 2, 3]) }]);
        await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledOnce());
        const [, args] = f.invoke.mock.calls[0] as unknown as [string, unknown[]];
        expect(args.slice(0, 2)).toEqual(['a1', 'look']);
        const [file] = args[2] as Array<{ name: string; type: string; bytes: Uint8Array }>;
        expect(file).toMatchObject({ name: 'a.png', type: 'image/png' });
        expect([...file!.bytes]).toEqual([1, 2, 3]);
    });
});

describe('a refusal lands where the IPC path put it', () => {
    it.each(rows.filter((r) => r.answers))('$method: the host\'s reason comes back to its caller', async (row) => {
        const bridge = bridgeOn(serve(fakeApi({ ok: false, reason: 'the host said no' }).api).framePort().port);
        expect(await row.call(bridge)).toEqual(expect.objectContaining({ ok: false, reason: 'the host said no' }));
    });

    it.each(rows.filter((r) => r.answers))('$method: a window whose connection went gets an answer, not a throw', async (row) => {
        const door = serve(fakeApi().api).framePort();
        const bridge = bridgeOn(door.port);
        await bridge.prompt('a1', 'first');
        door.drop();
        await settle();
        // A call made during a drop waits for the link (Tynn #590); this door never comes back, so it is answered when the wait ends.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const answer = row.call(bridge);
            await vi.advanceTimersByTimeAsync(15_000);
            expect(await answer).toEqual(expect.objectContaining({ ok: false, reason: expect.any(String) }));
        } finally { vi.useRealTimers(); }
    });

    it('the approval card\'s words, and the New agent form\'s', async () => {
        const deps = protocolContractDeps(dir);
        const api = buildHostApi(deps);
        expect(await api.invoke('answerApproval', ['nope', 'allow'])).toEqual({ ok: false, reason: 'Genie does not know this agent' });
        expect(await api.invoke('answerApproval', ['agent_a', 7])).toEqual({ ok: false, reason: 'no option was chosen' });
        expect(await api.invoke('addAgent', [null, {}])).toEqual({ ok: false, reason: 'no workspace named' });
    });
});

describe('the baton', () => {
    it('does not gate this machine\'s own window while someone else drives', async () => {
        const f = fakeApi();
        const source = serve(f.api);
        const bridge = bridgeOn(source.framePort().port);
        baton.take('someone-else', 'pat', { isOwner: true });
        await bridge.prompt('a1', 'hi');
        await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledOnce());
    });

    it('CONTROL: a remote window without it is refused, and the host is not asked', async () => {
        const f = fakeApi();
        const call = await serve(f.api).relay();
        expect(await call('prompt', ['a1', 'hi'])).toMatchObject({ ok: false, reason: expect.stringContaining('baton') });
        expect(f.invoke).not.toHaveBeenCalled();
    });
});

describe('the IPC path is gone', () => {
    const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
    const CHANNELS = ['open-agent', 'stop-agent', 'resume-limit', 'cancel-turn', 'prompt', 'resolve-prompt', 'answer-approval', 'add-agent', 'restart-with-handoff'];
    it.each(CHANNELS)('genie:%s: no handler, no preload line, no inventory row', (name) => {
        expect(read('main/main.ts')).not.toContain(`ipcMain.handle('genie:${name}'`);
        expect(read('main/preload.ts')).not.toContain(`'genie:${name}'`);
        expect(read('core/ipc-inventory.ts')).not.toContain(`'genie:${name}'`);
    });
    it('a command before the agent host is up is refused in words', () => {
        expect(read('main/main.ts')).toMatch(/Genie’s agents are not running yet/);
    });
});
