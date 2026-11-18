import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { FRAME_TOO_LARGE } from '../src/core/remote-frame.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, type ServerConnection } from '../src/core/remote-protocol.js';
import type { LocalFramePort } from '../src/core/local-frame.js';
import { answerDeck, type DeckAnswerAction, type DeckAnswerPorts } from '../src/main/deck-answer.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { pageBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import type { FeatureData } from '../src/renderer/features.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';

/*
 * ANSWERING AN APPROVAL SENDS ONLY ITS ID, THE ANSWER AND A NOTE (Tynn #861; the owner on his phone, over Tailscale to
 * AlphaR: Allow on "Genie wants to sign a Proof-of-Done…" said "this is too large to send to another device; use the
 * host's own screen").
 *
 * Two halves. The HOST answers from its own pending record: whatever item a client sends beside the id — its title, its
 * agent, its options — is ignored, so no client can change what was approved or whom the note reaches. And the WIRE: every
 * client sends `{ id, answer, note }` and nothing else, and the host's reply to another device is never the whole feature
 * snapshot that a phone cannot take.
 */

const approval = (over: Partial<DeckItem> = {}): DeckItem => ({
    id: 'appr_1', source: 'agent-question', agentId: 'atlas', agentName: 'atlas', workspaceId: 'w1',
    title: 'Genie wants to sign a Proof-of-Done for task 12', blocking: true, priority: 'high', at: 1,
    answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }] }, forwardedFrom: null,
    detail: 'commits: '.padEnd(20_000, 'a'), ...over,
} as DeckItem);

const question = (over: Partial<DeckItem> = {}): DeckItem => ({
    id: 'q_1', source: 'agent-question', agentId: 'atlas', agentName: 'atlas', workspaceId: 'w1', title: 'Ship it?', blocking: true,
    priority: 'high', at: 1, forwardedFrom: null, revision: 2,
    answer: { kind: 'form', questions: [{ header: 'Ship', question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }] }, ...over,
} as DeckItem);

function ports(items: DeckItem[]) {
    const resolve = vi.fn((_id: string, _choice: 'allow' | 'deny') => true);
    const deliverToAgent = vi.fn(async (_agentId: string, _text: string) => true);
    const answer = vi.fn(async () => true as never);
    const p: DeckAnswerPorts = {
        deckItems: () => items,
        attention: { answer, pending: () => items.filter((i) => i.id.startsWith('q_')).map((i) => ({ id: i.id, revision: i.revision })) as never, lists: { done: async () => true } },
        approvals: { resolve },
        inbox: { unread: () => [], receive: async () => [] as never },
        deliverToAgent,
    } as DeckAnswerPorts;
    return { p, resolve, deliverToAgent, answer };
}

describe('the host answers from its own pending record', () => {
    it('a client\'s copy of the approval changes nothing: the host\'s title, agent and options decide', async () => {
        const own = approval();
        const { p, resolve, deliverToAgent } = ports([own]);
        const forged = { ...own, title: 'FORGED', agentId: 'mallory', agentName: 'mallory' };
        await answerDeck({ kind: 'deck.answer', item: forged, optionId: 'allow', note: 'go ahead' } as DeckAnswerAction, p);
        expect(resolve).toHaveBeenCalledExactlyOnceWith('appr_1', 'allow');
        expect(deliverToAgent).toHaveBeenCalledOnce();
        const [to, text] = deliverToAgent.mock.calls[0]!;
        expect(to).toBe('atlas');
        expect(text).toContain('Genie wants to sign a Proof-of-Done for task 12');
        expect(text).not.toContain('FORGED');
    });

    it('the id alone is enough: the answer needs nothing else from the client', async () => {
        const { p, resolve } = ports([approval()]);
        await answerDeck({ kind: 'deck.answer', item: { id: 'appr_1' }, optionId: 'deny' } as DeckAnswerAction, p);
        expect(resolve).toHaveBeenCalledExactlyOnceWith('appr_1', 'deny');
    });

    it('an id the host is not holding is refused in words, and nothing is resolved', async () => {
        const { p, resolve } = ports([approval()]);
        await expect(answerDeck({ kind: 'deck.answer', item: approval({ id: 'appr_9' }), optionId: 'allow' } as DeckAnswerAction, p)).rejects.toThrow(/no longer waiting/);
        expect(resolve).not.toHaveBeenCalled();
    });

    it('an option the client added to its copy of a question is not one the host offered', async () => {
        const own = question();
        const { p, answer } = ports([own]);
        const forged = question({ answer: { kind: 'form', questions: [{ header: 'Ship', question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Hacked' }] }] } as DeckItem['answer'] });
        await expect(answerDeck({ kind: 'deck.answerForm', item: forged, selections: [['Hacked']], notes: [''], note: '' } as DeckAnswerAction, p)).rejects.toThrow(/not one of the options/);
        expect(answer).not.toHaveBeenCalled();
        // CONTROL: the host's own option, by the same id and revision, is answered.
        await answerDeck({ kind: 'deck.answerForm', item: { id: 'q_1', revision: 2 }, selections: [['Yes']], notes: [''], note: '' } as DeckAnswerAction, p);
        expect(answer).toHaveBeenCalledOnce();
    });

    it('a note over 4,000 characters is refused, never cut, and nothing is resolved', async () => {
        const { p, resolve } = ports([approval()]);
        await expect(answerDeck({ kind: 'deck.answer', item: { id: 'appr_1' }, optionId: 'allow', note: 'n'.repeat(4_001) } as DeckAnswerAction, p)).rejects.toThrow(/4,000 characters/);
        expect(resolve).not.toHaveBeenCalled();
        // CONTROL: exactly at the cap is answered.
        await answerDeck({ kind: 'deck.answer', item: { id: 'appr_1' }, optionId: 'allow', note: 'n'.repeat(4_000) } as DeckAnswerAction, p);
        expect(resolve).toHaveBeenCalledOnce();
    });
});

/* ---- over the wire: a real RemoteHost and the clients' own bridge ---- */

const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise<void>((r) => setImmediate(r)); };
const closers: Array<() => void> = [];
let dir: string;
let devices: DeviceStore;

/** A host whose feature snapshot is as large as a busy workstation's: over the 512 KiB a frame to another device may be. */
function host(result: unknown = { knowledge: { hits: null } }) {
    const deps: HostApiDeps = protocolContractDeps(dir);
    const act = vi.fn(async (..._a: unknown[]) => result as FeatureData);
    const snapshot = vi.fn(async () => ({ knowledge: { hits: null }, remote: { pairRequests: [] } }) as unknown as FeatureData);
    Object.assign(deps.features, { act, snapshot });
    return { api: buildHostApi(deps), act, snapshot };
}

function serve(api: HostApi) {
    let accept!: (connection: ServerConnection) => void;
    new RemoteHost({ api, hostName: 'alphar', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing,
        transport: { onConnection: (l) => { accept = l; return () => {}; } } });
    const connect = async (profile?: 'mobile') => {
        const pair = inMemoryPair();
        const frames: string[] = [];
        pair.client.onMessage((text) => { frames.push(text); });
        accept({ ...pair.server, remoteAddress: 'relay:x', preAuth: { label: 'phone', isOwner: true, workspaceId: null, readonly: false } });
        const client = connectRemote(pair.client, { kind: 'relay' }, 'phone', profile ? { profile } : {});
        closers.push(() => client.close());
        expect(await client.ready).toEqual({ ok: true });
        return { client, frames };
    };
    const window = () => {
        const pair = inMemoryPair();
        closers.push(() => pair.client.close());
        const listeners = new Set<Parameters<LocalFramePort['onFrame']>[0]>();
        let handle = '';
        pair.client.onMessage((text) => { for (const l of listeners) l('frame', handle, text); });
        pair.client.onClose(() => { for (const l of listeners) l('closed', handle, ''); });
        const port: LocalFramePort = {
            onFrame: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
            send: (action, id, text) => {
                if (action === 'open') { handle = id; accept({ ...pair.server, preAuth: { kind: 'local', label: 'page', isOwner: true, workspaceId: null, readonly: false, window: 'main' } }); }
                else if (action === 'frame') pair.client.send(text);
                else pair.client.close();
            },
        };
        vi.stubGlobal('window', { genieLocalProtocol: port });
        return pageBridge(({ snapshot: async () => ({ workspaces: null }), subscribeAgentWire: () => () => {}, workspaces: {}, features: {} }) as unknown as PreloadBridge);
    };
    return { connect, window };
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-861-')); let n = 0; devices = await DeviceStore.open(dir, { now: Date.now, random: () => `d-${++n}` }); });
afterEach(async () => { for (const c of closers.splice(0)) c(); vi.unstubAllGlobals(); await settle(); await devices.flushed(); await rm(dir, { recursive: true, force: true }); });

describe('every client sends the id, the answer and the note — nothing of the item', () => {
    it.each([['a phone', 'mobile' as const], ['a window driving this machine from another', undefined]])('%s', async (_name, profile) => {
        const h = host();
        const { client } = await serve(h.api).connect(profile);
        await client.bridge.features.act({ kind: 'deck.answer', item: approval(), optionId: 'allow', note: 'go ahead' });
        expect(h.act).toHaveBeenCalledOnce();
        expect(h.act.mock.calls[0]![0]).toEqual({ kind: 'deck.answer', item: { id: 'appr_1' }, optionId: 'allow', note: 'go ahead' });
        // A question's answer: its id, the revision it was answered on, the picks and the notes.
        await client.bridge.features.act({ kind: 'deck.answerForm', item: question(), selections: [['Yes']], notes: ['ok'], note: '' });
        expect(h.act.mock.calls[1]![0]).toEqual({ kind: 'deck.answerForm', item: { id: 'q_1', revision: 2 }, selections: [['Yes']], notes: ['ok'], note: '' });
    });

    it('this machine\'s own window the same', async () => {
        const h = host();
        const bridge = serve(h.api).window();
        await bridge.features.act({ kind: 'deck.answer', item: approval(), optionId: 'deny' });
        expect(h.act.mock.calls[0]![0]).toEqual({ kind: 'deck.answer', item: { id: 'appr_1' }, optionId: 'deny' });
    });

    it('a note over the cap is refused before anything is sent', async () => {
        const h = host();
        const { client } = await serve(h.api).connect('mobile');
        await expect(client.bridge.features.act({ kind: 'deck.answer', item: approval(), optionId: 'allow', note: 'n'.repeat(4_001) })).rejects.toThrow(/4,000 characters/);
        expect(h.act).not.toHaveBeenCalled();
    });
});

describe('the host\'s reply to another device is never the whole feature snapshot', () => {
    const big = { knowledge: { hits: null }, remote: { pairRequests: [{ id: 'pr_1', label: 'stranger' }] }, inbox: { unread: [{ text: 'x'.repeat(700_000) }] } };

    it('a phone\'s answer is acknowledged, not refused as too large', async () => {
        const h = host(big);
        const { client, frames } = await serve(h.api).connect('mobile');
        await client.bridge.features.act({ kind: 'deck.answer', item: approval(), optionId: 'allow' });
        expect(frames.some((f) => f.includes(FRAME_TOO_LARGE))).toBe(false);
        expect(frames.some((f) => f.includes('x'.repeat(1000)))).toBe(false);
    });

    it('a window driving this machine reads the snapshot again when the reply would not fit', async () => {
        const h = host(big);
        const { client, frames } = await serve(h.api).connect();
        const answer = await client.bridge.features.act({ kind: 'deck.answer', item: approval(), optionId: 'allow' });
        expect(answer).toEqual({ knowledge: { hits: null }, remote: { pairRequests: [] } });
        expect(h.snapshot).toHaveBeenCalled();
        expect(frames.some((f) => f.includes(FRAME_TOO_LARGE))).toBe(false);
    });

    it('CONTROL: a reply that fits comes inline — without "Pair this device?" requests, as the feature push sends it', async () => {
        const h = host({ knowledge: { hits: null }, remote: { pairRequests: [{ id: 'pr_1', label: 'stranger' }] } });
        const { client } = await serve(h.api).connect();
        expect(await client.bridge.features.act({ kind: 'deck.answer', item: approval(), optionId: 'allow' })).toEqual({ knowledge: { hits: null }, remote: { pairRequests: [] } });
        expect(h.snapshot).not.toHaveBeenCalled();
    });
});
