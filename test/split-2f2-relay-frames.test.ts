import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DEVICE_PIECE_CHARS, FrameJoiner, framePieces } from '../src/core/device-frames.js';
import { ENGINE_METHODS } from '../src/core/engine-protocol.js';
import { IPC_INVENTORY, WINDOW_ENGINE_INVENTORY } from '../src/core/ipc-inventory.js';
import { LOCAL_FRAME_LIMIT_BYTES } from '../src/core/local-frame.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { CONTROL_METHODS, LOCAL_EVENTS, REMOTE_METHODS, capabilityOf, inMemoryPair, parseMessage, type CallContext, type RemoteMethod, type ServerTransport, type WireMessage } from '../src/core/remote-protocol.js';
import { remoteWindowAction } from '../src/core/remote-window-policy.js';
import { deviceLinkProtocol } from '../src/main/device-link-protocol.js';
import { HOST_ALONE_METHODS } from '../src/main/host-alone-api.js';
import { ownProtocolClient } from '../src/main/own-protocol-client.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { deviceChannels } from '../src/renderer/device-channels.js';

/*
 * CLIENT/HOST SPLIT STEP 2f-2 (Tynn #898, story #941; split out of #912). A client is a dumb terminal: a remote window's
 * transport to ANOTHER machine (a device socket, or a Tynn workstation's relay) is genie-host's, and the window reaches it
 * over the one protocol on its own connection, never a second frame path through main:
 *  - deviceLink.open / openRelay / send / close (`local`): genie-host's device link, owned by the CALLER'S connection;
 *    its frames, closes and steps come back as `local-device` events to that connection alone, and its channels close
 *    when that connection does;
 *  - a frame larger than a door frame crosses in pieces, both ways (core/device-frames.ts): the door caps a frame at 1 MiB,
 *    another machine's frames reach 100 MiB;
 *  - deviceLink.openBrowser (`local`): this machine's Genie browser on the CALLER'S relay channel's workstation, opened by
 *    genie-host, which also moves the browser's door when it changes. main's genie:browser-window-open keeps local mode;
 *  - main's Deck liveness (`takeOvers`) goes: the question window and the tray read genie-host's Deck (deck.watch).
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const LOCAL: CallContext = { connectionId: 'conn_7', origin: 'local-window', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: 'this Genie window' };
const METHODS = ['deviceLink.open', 'deviceLink.openRelay', 'deviceLink.send', 'deviceLink.close', 'deviceLink.openBrowser'];

describe('the protocol carries a window’s transport to another machine', () => {
    it('the five methods are `local` (this machine’s own windows) and genie-host answers them; deck.watch is a control; one event channel each', () => {
        for (const m of METHODS) {
            expect(REMOTE_METHODS as readonly string[], m).toContain(m);
            expect(capabilityOf(m as RemoteMethod), m).toBe('local');
            expect(HOST_ALONE_METHODS.has(m as RemoteMethod), m).toBe(true);
        }
        // Answered by RemoteHost itself, for a local connection, like baton.watch.
        expect(CONTROL_METHODS as readonly string[]).toContain('deck.watch');
        expect(LOCAL_EVENTS).toMatchObject({ device: 'local-device', deck: 'local-deck' });
    });

    it('the engine link carries none of it: no engine.deviceLink, no device.event', () => {
        expect(ENGINE_METHODS as readonly string[]).not.toContain('engine.deviceLink');
        expect(code(src('src/main/session-engine-server.ts'))).not.toMatch(/'engine\.deviceLink'|'device\.event'/);
        expect(code(src('src/main/session-engine-client.ts'))).not.toMatch(/deviceLink\(\)|'device\.event'|DeviceLinkReplica/);
    });
});

describe('frames larger than a door frame cross in pieces, both ways', () => {
    it('a piece, JSON-escaped at its worst, fits one door frame with room for its envelope', () => {
        const worst = '\u0001'.repeat(DEVICE_PIECE_CHARS);
        const envelope = JSON.stringify({ kind: 'event', channel: LOCAL_EVENTS.device, payload: { type: 'frame', channel: 'relay_99', text: worst, more: true } });
        expect(Buffer.byteLength(envelope, 'utf8')).toBeLessThan(LOCAL_FRAME_LIMIT_BYTES);
    });

    it('a large frame splits into pieces that join back to the same text; a small one is one piece', () => {
        const big = 'é'.repeat(DEVICE_PIECE_CHARS * 2 + 17);
        const pieces = framePieces(big);
        expect(pieces.length).toBe(3);
        expect(pieces.join('')).toBe(big);
        expect(framePieces('{"kind":"hello"}')).toEqual(['{"kind":"hello"}']);
        expect(framePieces('')).toEqual(['']);
    });

    it('the joiner keeps each key’s pieces apart and hands back each whole frame once', () => {
        const j = new FrameJoiner(1_000);
        expect(j.add('a', 'he', true)).toBeNull();
        expect(j.add('b', 'x', false)).toEqual({ ok: true, text: 'x' });
        expect(j.add('a', 'llo', false)).toEqual({ ok: true, text: 'hello' });
        expect(j.add('a', 'again', false)).toEqual({ ok: true, text: 'again' });
    });

    it('past its limit the joiner refuses the frame and forgets it; a dropped key starts clean', () => {
        const j = new FrameJoiner(10);
        expect(j.add('a', '123456', true)).toBeNull();
        expect(j.add('a', '789012', true)).toMatchObject({ ok: false });
        expect(j.add('a', 'ok', false)).toEqual({ ok: true, text: 'ok' });
        j.add('b', 'half', true);
        j.drop('b');
        expect(j.add('b', 'new', false)).toEqual({ ok: true, text: 'new' });
    });
});

/** A fake of genie-host's DeviceLinkService, as the protocol uses it. */
function fakeLink() {
    const calls: unknown[][] = [];
    return {
        calls,
        link: {
            open: async (owner: string, url: string) => { calls.push(['open', owner, url]); return { ok: true as const, channel: 'device_1' }; },
            openRelay: async (owner: string, id: string) => {
                calls.push(['openRelay', owner, id]);
                return id === 'ws_refused' ? { ok: false as const, stage: 'tynn' as const, refusal: { ok: false as const, reason: 'not found', refusedByTynn: true as const } } : { ok: true as const, channel: 'relay_1' };
            },
            send: (owner: string, channel: string, text: string) => { calls.push(['send', owner, channel, text]); },
            close: (owner: string, channel: string) => { calls.push(['close', owner, channel]); },
            dropOwner: (owner: string) => { calls.push(['dropOwner', owner]); },
            browserVia: async (owner: string, channel: string) => {
                calls.push(['browserVia', owner, channel]);
                return owner === 'conn_7' && channel === 'relay_1' ? { ok: true as const, workstationId: 'ws_alpha', port: 6262, ca: 'CA' } : { ok: false as const, reason: 'This window is not connected to its workstation right now. Reconnect, then open the browser again.' };
            },
        },
    };
}
function protocol(overrides: { role?: 'pilot' | 'drone' } = {}) {
    const f = fakeLink();
    const browser: unknown[][] = [];
    const vias: unknown[][] = [];
    const role = overrides.role ?? 'pilot';
    const p = deviceLinkProtocol({
        link: f.link,
        // The role genie-host read from Tynn (device-link-gate.ts decides with it, as main's window did).
        role: { role: () => role, said: () => role, why: () => null, reread: async () => {} },
        wordTynnRefusal: async (refusal) => ({ ...refusal, reason: `worded: ${refusal.reason}` }),
        openBrowser: async (args) => { browser.push(args); return { browserUp: true }; },
        remoteVia: (key, port, ca) => { vias.push([key, port, ca]); },
    });
    return { ...f, p, browser, vias };
}

describe('genie-host’s side: the caller’s connection owns what it opens', () => {
    it('open and openRelay are the caller’s; Tynn’s refusal is worded with the role read again', async () => {
        const t = protocol();
        expect(await t.p.call('conn_7', 'open', ['wss://other.example/genie'])).toEqual({ ok: true, channel: 'device_1' });
        expect(await t.p.call('conn_7', 'openRelay', ['ws_alpha'])).toEqual({ ok: true, channel: 'relay_1' });
        expect(await t.p.call('conn_7', 'openRelay', ['ws_refused'])).toMatchObject({ ok: false, stage: 'tynn', reason: 'worded: not found' });
        expect(t.calls.slice(0, 2)).toEqual([['open', 'conn_7', 'wss://other.example/genie'], ['openRelay', 'conn_7', 'ws_alpha']]);
    });

    it('a drone dials nothing: the refusal comes before any socket; not a device url, nothing either', async () => {
        const t = protocol({ role: 'drone' });
        expect(await t.p.call('conn_7', 'open', ['wss://other.example/genie'])).toMatchObject({ ok: false, reason: expect.stringMatching(/drone/) });
        expect(await protocol().p.call('conn_7', 'open', ['https://other.example'])).toEqual({ ok: false, reason: 'another machine is reached over ws:// or wss://' });
        expect(t.calls).toEqual([]);
    });

    it('send joins the pieces before the socket hears them; close drops a half-sent frame', async () => {
        const t = protocol();
        await t.p.call('conn_7', 'send', ['relay_1', '{"kind":', true]);
        expect(t.calls).toEqual([]);
        await t.p.call('conn_7', 'send', ['relay_1', '"hello"}', false]);
        expect(t.calls).toEqual([['send', 'conn_7', 'relay_1', '{"kind":"hello"}']]);
        await t.p.call('conn_7', 'send', ['relay_1', 'half', true]);
        await t.p.call('conn_7', 'close', ['relay_1']);
        await t.p.call('conn_7', 'send', ['relay_1', 'fresh', false]);
        expect(t.calls.slice(1)).toEqual([['close', 'conn_7', 'relay_1'], ['send', 'conn_7', 'relay_1', 'fresh']]);
    });

    it('another connection’s pieces never join this one’s', async () => {
        const t = protocol();
        await t.p.call('conn_7', 'send', ['relay_1', 'mine-', true]);
        await t.p.call('conn_8', 'send', ['relay_1', 'theirs', false]);
        await t.p.call('conn_7', 'send', ['relay_1', 'end', false]);
        expect(t.calls).toEqual([['send', 'conn_8', 'relay_1', 'theirs'], ['send', 'conn_7', 'relay_1', 'mine-end']]);
    });

    it('the connection going closes everything it opened (dropOwner)', () => {
        const t = protocol();
        t.p.dropOwner('conn_7');
        expect(t.calls).toEqual([['dropOwner', 'conn_7']]);
    });

    it('events: a frame goes out in pieces, a close and a step as they are; a moved browser door reaches the browser, never the window', () => {
        const t = protocol();
        const big = 'x'.repeat(DEVICE_PIECE_CHARS + 5);
        expect(t.p.events({ type: 'frame', channel: 'relay_1', text: big })).toEqual([
            { type: 'frame', channel: 'relay_1', text: 'x'.repeat(DEVICE_PIECE_CHARS), more: true },
            { type: 'frame', channel: 'relay_1', text: 'xxxxx' },
        ]);
        expect(t.p.events({ type: 'closed', channel: 'relay_1', reason: 'gone' })).toEqual([{ type: 'closed', channel: 'relay_1', reason: 'gone' }]);
        expect(t.p.events({ type: 'step', workstationId: 'ws_alpha', step: 'relay' })).toEqual([{ type: 'step', workstationId: 'ws_alpha', step: 'relay' }]);
        expect(t.p.events({ type: 'via', channel: 'relay_1', port: 7000, ca: 'NEW' })).toEqual([]);
    });
});

describe('the relay browser: this machine’s Genie browser on the caller’s own channel’s workstation', () => {
    it('opened by genie-host with that workstation’s door, the window’s title and anchor; .gen hosts only', async () => {
        const t = protocol();
        const anchor = { x: 10, y: 20, width: 800, height: 600 };
        expect(await t.p.call('conn_7', 'openBrowser', ['relay_1', 'https://app.gen/', ['app.gen', 'evil.example'], { title: 'alphar', anchor }])).toEqual({ ok: true });
        expect(t.browser).toEqual([['https://app.gen/', 'user-gesture', { key: 'relay:ws_alpha', title: 'alphar', port: 6262, ca: 'CA', hosts: ['app.gen'] }, anchor]]);
    });

    it('a channel the caller does not own opens nothing, in words', async () => {
        const t = protocol();
        expect(await t.p.call('conn_8', 'openBrowser', ['relay_1', null, [], {}])).toEqual({ ok: false, error: 'This window is not connected to its workstation right now. Reconnect, then open the browser again.' });
        expect(t.browser).toEqual([]);
    });

    it('the door moving is the browser’s to hear (remoteVia), keyed by the channel’s workstation', async () => {
        const t = protocol();
        await t.p.call('conn_7', 'openBrowser', ['relay_1', null, [], {}]);
        t.p.events({ type: 'via', channel: 'relay_1', port: 7000, ca: 'NEW' });
        expect(t.vias).toEqual([['relay:ws_alpha', 7000, 'NEW']]);
    });
});

describe('the host API routes them with the caller’s connection as owner', () => {
    it('each method reaches the device protocol as the calling connection; with none, in words', async () => {
        const asked: unknown[][] = [];
        const deviceLink = { call: async (...a: unknown[]) => { asked.push(a); return { ok: true }; }, dropOwner: (o: string) => { asked.push(['drop', o]); }, events: () => [] };
        const api = buildHostApi({ features: { releaseCaller: () => {} }, workspaceOps: {}, agentOps: {}, updates: null, deviceLinkProtocol: deviceLink } as unknown as HostApiDeps);
        await api.invoke('deviceLink.open' as RemoteMethod, ['wss://x/genie'], LOCAL);
        await api.invoke('deviceLink.send' as RemoteMethod, ['relay_1', 'p', true], LOCAL);
        expect(asked).toEqual([['conn_7', 'open', ['wss://x/genie']], ['conn_7', 'send', ['relay_1', 'p', true]]]);
        api.releaseCaller?.(LOCAL);
        expect(asked.at(-1)).toEqual(['drop', 'conn_7']);
        const none = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null } as unknown as HostApiDeps);
        expect(await none.invoke('deviceLink.open' as RemoteMethod, ['wss://x/genie'], LOCAL)).toEqual({ ok: false, reason: 'this Genie connects to no other machines' });
    });

    it('genie-host composes it over its device link, its role and its browser, and sends each event to the owning connection alone', () => {
        const g = code(src('src/main/genie-host.ts'));
        expect(g).toMatch(/send: \(owner, event\) => \{ for \(const payload of deviceProtocol\.events\(event\)\) remoteAccessHost\.remote\.eventTo\(owner, LOCAL_EVENTS\.device, payload\); \}/);
        expect(g).toMatch(/openBrowser: \(args\) => browserService\.call\('open', args, 'genie-host'\)/);
        expect(g).toMatch(/remoteVia: \(key, port, ca\) => \{ void browserService\.call\('remoteVia', \[key, port, ca\], 'genie-host'\)/);
        const rh = code(src('src/main/remote-host.ts'));
        expect(rh).toMatch(/eventTo\(connectionId: string, channel: string, payload: unknown\): boolean \{/);
    });
});

describe('the window’s side: channels over its own protocol session', () => {
    type Listener = (payload: unknown) => void;
    function session() {
        const sent: unknown[][] = [];
        let listener: Listener = () => {};
        const ports = {
            call: async (method: string, ...args: unknown[]) => { sent.push([method, ...args]); return method === 'deviceLink.open' ? { ok: true, channel: 'device_1' } : method === 'deviceLink.openRelay' ? { ok: true, channel: 'relay_1' } : true; },
            on: (l: Listener) => { listener = l; return () => { listener = () => {}; }; },
        };
        const d = deviceChannels(ports);
        return { d, sent, push: (p: unknown) => listener(p) };
    }

    it('open, then frames for that channel only, joined from their pieces', async () => {
        const s = session();
        const got: unknown[][] = [];
        s.d.onMessage((c, t) => got.push([c, t]));
        expect(await s.d.open('wss://other/genie')).toEqual({ ok: true, channel: 'device_1' });
        s.push({ type: 'frame', channel: 'device_1', text: 'hel', more: true });
        s.push({ type: 'frame', channel: 'device_1', text: 'lo' });
        s.push({ type: 'frame', channel: 'device_2', text: 'other' });
        expect(got).toEqual([['device_1', 'hello'], ['device_2', 'other']]);
    });

    it('send splits a large frame into pieces in order; a small one is one call', async () => {
        const s = session();
        const big = 'y'.repeat(DEVICE_PIECE_CHARS + 1);
        s.d.send('relay_1', '{"kind":"hello"}');
        s.d.send('relay_1', big);
        await vi.waitFor(() => expect(s.sent.length).toBe(3));
        expect(s.sent).toEqual([
            ['deviceLink.send', 'relay_1', '{"kind":"hello"}', false],
            ['deviceLink.send', 'relay_1', 'y'.repeat(DEVICE_PIECE_CHARS), true],
            ['deviceLink.send', 'relay_1', 'y', false],
        ]);
    });

    it('steps and closes are heard; a lost session closes every open channel, with its reason', async () => {
        const s = session();
        const steps: unknown[][] = [];
        const closes: unknown[][] = [];
        s.d.onOpenStep((id, step) => steps.push([id, step]));
        s.d.onClosed((c, r) => closes.push([c, r]));
        await s.d.open('wss://other/genie');
        await s.d.openRelay('ws_alpha');
        s.push({ type: 'step', workstationId: 'ws_alpha', step: 'relay' });
        s.push({ type: 'closed', channel: 'device_1', reason: 'bye' });
        s.d.lost('Genie’s connection to its host closed');
        s.d.lost('again');
        expect(steps).toEqual([['ws_alpha', 'relay']]);
        expect(closes).toEqual([['device_1', 'bye'], ['relay_1', 'Genie’s connection to its host closed']]);
    });

    it('openBrowser asks for the channel’s workstation browser with the window’s title and anchor', async () => {
        const s = session();
        await s.d.openBrowser('relay_1', 'https://app.gen/', ['app.gen'], { title: 'alphar', anchor: { x: 1, y: 2, width: 3, height: 4 } });
        expect(s.sent).toEqual([['deviceLink.openBrowser', 'relay_1', 'https://app.gen/', ['app.gen'], { title: 'alphar', anchor: { x: 1, y: 2, width: 3, height: 4 } }]]);
    });

    it('wired: the wire bridge’s local owner and the window’s session carry it; the page bridge takes it from the session, not the preload', () => {
        expect(code(src('src/renderer/remote-bridge.ts'))).toMatch(/deviceChannels\(\{ call: \(method, \.\.\.args\) => read\(method as RemoteMethod, \.\.\.args\), on: \(listener\) => on\(LOCAL_EVENTS\.device, listener\) \}\)/);
        const session = code(src('src/renderer/local-session.ts'));
        expect(session).toMatch(/devices\.lost\(/);
        const bridge = code(src('src/renderer/bridge.ts'));
        expect(bridge).toMatch(/deviceLink: local\.owner\.deviceLink,/);
        expect(bridge).not.toMatch(/\.\.\.preload\.deviceLink/);
    });
});

describe('the window no longer reaches another machine off the one protocol', () => {
    const GONE = ['genie:device-open', 'genie:relay-open', 'genie:relay-send', 'genie:relay-close'];
    it('main registers none of the four, nor pushes their events; the preload sends none; the rows leave both lists', () => {
        const main = code(src('src/main/main.ts'));
        const preload = code(src('src/main/preload.ts'));
        for (const channel of [...GONE, 'genie:relay-message', 'genie:relay-closed', 'genie:relay-open-step']) {
            expect(main, channel).not.toContain(`'${channel}'`);
            expect(preload, channel).not.toContain(`'${channel}'`);
        }
        for (const channel of GONE) expect(IPC_INVENTORY.map(([c]) => c), channel).not.toContain(channel);
        expect(src('test/ipc-inventory.test.ts')).not.toMatch(/'genie:(device-open|relay-open|relay-send|relay-close|browser-window-open)': '2f'/);
    });

    it('main holds no channel, no relay map, no device link and no Take Over liveness', () => {
        const main = code(src('src/main/main.ts'));
        for (const gone of ['deviceLinkNow', 'hearDeviceLink', 'linkedRelays', 'deviceChannels', 'relayLiveFor', 'deviceLinkGate(', '.onVia(', 'client.takeOvers()', 'askerLiveFrom(']) expect(main, gone).not.toContain(gone);
        const uses = WINDOW_ENGINE_INVENTORY.map(([u]) => u);
        expect(uses).not.toContain('deviceLink');
        expect(uses).not.toContain('takeOvers');
        expect(src('test/split-2e-window-guard.test.ts')).not.toMatch(/deviceLink: '2f'|takeOvers: '2f'/);
    });

    it('genie:browser-window-open is this machine’s own browser only: the window’s feature effect; a remote window is refused', () => {
        expect(IPC_INVENTORY).toContainEqual(['genie:browser-window-open', 'window:feature-effect']);
        const main = code(src('src/main/main.ts'));
        expect(main).toMatch(/const conn = browserConnectionFor\(\{ remoteUrl, relays: \[\] \}\);/);
        expect(main).not.toContain('browserVia');
    });

    it('a relay window opens its workstation’s browser over its own session, never main', () => {
        const app = code(src('src/renderer/App.tsx'));
        expect(app).toMatch(/browse: \(address: string \| undefined, hosts: readonly string\[\]\) => net\.openBrowser!\(opened\.channel, address \?\? null, hosts, browserView\(\)\)/);
    });
});

describe('a relay window asked to come up reconnects only if its own link is down', () => {
    it('the policy: the same account’s relay window is asked to reconnect, whatever main cannot see', () => {
        expect(remoteWindowAction({ exists: true, relay: true, openedBy: 'a#x', account: 'a#x' })).toBe('reconnect');
        expect(remoteWindowAction({ exists: true, relay: true, openedBy: 'a#x', account: 'b#y' })).toBe('replace');
        expect(remoteWindowAction({ exists: true, relay: false, openedBy: null, account: null })).toBe('focus');
        expect(remoteWindowAction({ exists: false, relay: true, openedBy: null, account: 'a#x' })).toBe('open');
    });

    it('the window ignores the ask while it is connected', () => {
        expect(code(src('src/renderer/App.tsx'))).toMatch(/onReconnectAsked\?\.\(\(\) => \{ if \(remoteConnectedNow\.current\) return; reconnectNow\.current\(\); \}\)/);
    });
});

describe('the question window and the tray read genie-host’s Deck (takeOvers goes)', () => {
    it('main watches the host’s Deck over its own protocol client, and both read it', () => {
        const main = code(src('src/main/main.ts'));
        expect(main).toMatch(/ownProtocol\.watchDeck\(\(items\) => \{/);
        expect(main).toMatch(/items: \(\) => \[\.\.\.hostDeckNow, \.\.\.remoteQuestions\.items\(\)\]/);
        expect(main).toMatch(/needsYouCount\(\[\.\.\.mainErrors\.deckItems\(\), \.\.\.hostDeckNow\]\)/);
        // main's own composed Deck still feeds its own registry (2g, Tynn #913); the question window and the tray do not read it.
        expect(main).not.toMatch(/items: \(\) => \[\.\.\.composed\.deckItems\(\)|composed\.attention\.onChange\(\(\) => questionWindow/);
    });

    it('main’s own client keeps the Deck connection open, says deck.watch on it, hears local-deck, and opens it again when it drops', () => {
        const own = code(src('src/main/own-protocol-client.ts'));
        expect(own).toMatch(/watchDeck\(onItems: \(items: readonly DeckItem\[\]\) => void\): \(\) => void/);
        expect(own).toContain("method: 'deck.watch'");
        expect(own).toContain('LOCAL_EVENTS.deck');
        expect(own).toMatch(/setTimeout\(open, /);
    });

    it('RemoteHost: a deck.watch connection hears the Deck when it changes, and no estate snapshot', () => {
        const rh = code(src('src/main/remote-host.ts'));
        expect(rh).toMatch(/case 'deck\.watch': \{\s*if \(!connection\.local\) return refuse\(/);
        expect(rh).toMatch(/if \(c\.deckOnly\) \{/);
    });
});

describe('over the wire: RemoteHost serves the Deck connection and the device events', () => {
    const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
    async function host(api: Partial<HostApi>, transport: ServerTransport) {
        const home = await mkdtemp(join(tmpdir(), 'genie-2f2-'));
        const devices = await DeviceStore.open(home, { now: Date.now, random: () => 'tok' });
        const remote = new RemoteHost({ api: { workspaceOfAgent: () => null, onEvent: () => () => {}, invoke: async () => null, ...api } as HostApi, hostName: 'alphar', baton: new Baton(), devices,
            pins: new PairingPins({ now: Date.now, random: () => 0.482913 }), confirm: allowEveryPairing, transport });
        return { remote, done: async () => { await devices.flushed(); await rm(home, { recursive: true, force: true }); } };
    }

    it('main’s Deck connection hears the Deck at once, again only when it changes, and never an estate snapshot', async () => {
        let emit: (channel: string, payload: unknown) => void = () => {};
        let snapshot: Record<string, unknown> = { agents: [], deckItems: [{ id: 'q_1' }] };
        const own = ownProtocolClient();
        const h = await host({ invoke: async (m: RemoteMethod) => (m === 'snapshot' ? snapshot : null), onEvent: (l) => { emit = l; return () => {}; } }, own.door);
        const heard: unknown[] = [];
        const stop = own.watchDeck((items) => heard.push(items));
        try {
            await settle();
            expect(heard).toEqual([[{ id: 'q_1' }]]);
            emit(LOCAL_EVENTS.snapshot, snapshot);
            await settle();
            expect(heard).toHaveLength(1);
            snapshot = { agents: [{ id: 'a' }], deckItems: [{ id: 'q_1' }, { id: 'q_2' }] };
            emit(LOCAL_EVENTS.snapshot, snapshot);
            emit(LOCAL_EVENTS.updates, { state: 'idle' });
            await settle();
            expect(heard).toEqual([[{ id: 'q_1' }], [{ id: 'q_1' }, { id: 'q_2' }]]);
        } finally { stop(); await h.done(); }
    });

    it('eventTo reaches the connection named and no other; the device methods are refused to another machine’s connection', async () => {
        let accept: (c: ReturnType<typeof inMemoryPair>['server']) => void = () => {};
        const asked: string[] = [];
        const h = await host({ invoke: async (m: RemoteMethod) => { asked.push(m); return { ok: true, channel: 'device_1' }; } }, { onConnection: (l) => { accept = l; return () => {}; } });
        const connect = async (preAuth: Record<string, unknown>) => {
            const pair = inMemoryPair();
            const frames: WireMessage[] = [];
            pair.client.onMessage((m) => { const r = parseMessage(m); if (r.ok) frames.push(r.message); });
            accept({ ...pair.server, preAuth: preAuth as never });
            pair.client.send(JSON.stringify({ kind: 'hello', auth: { kind: preAuth.kind }, label: 'x' }));
            await settle();
            const welcome = frames.find((m) => m.kind === 'welcome') as { connectionId?: string } | undefined;
            return { pair, frames, id: welcome?.connectionId ?? '' };
        };
        try {
            const mine = await connect({ kind: 'local', label: 'this Genie window', isOwner: true, workspaceId: null, readonly: false, window: 'remote' });
            const other = await connect({ kind: 'local', label: 'another window', isOwner: true, workspaceId: null, readonly: false, window: 'main' });
            const far = await connect({ kind: 'relay', label: 'laptop', isOwner: true, workspaceId: null, readonly: false });
            expect(mine.id).not.toBe('');
            expect(h.remote.eventTo(mine.id, LOCAL_EVENTS.device, { type: 'frame', channel: 'device_1', text: 'hi' })).toBe(true);
            expect(h.remote.eventTo('conn_none', LOCAL_EVENTS.device, {})).toBe(false);
            expect(h.remote.eventTo(far.id, LOCAL_EVENTS.device, {})).toBe(false);
            await settle();
            const events = (f: WireMessage[]) => f.filter((m) => m.kind === 'event' && (m as { channel?: string }).channel === LOCAL_EVENTS.device);
            expect(events(mine.frames)).toHaveLength(1);
            expect(events(other.frames)).toHaveLength(0);
            mine.pair.client.send(JSON.stringify({ kind: 'call', id: 5, method: 'deviceLink.open', args: ['wss://x/genie'] }));
            far.pair.client.send(JSON.stringify({ kind: 'call', id: 6, method: 'deviceLink.open', args: ['wss://x/genie'] }));
            await settle();
            expect(mine.frames.find((m) => m.kind === 'result' && m.id === 5)).toMatchObject({ ok: true });
            expect(far.frames.find((m) => m.kind === 'result' && m.id === 6)).toMatchObject({ ok: false });
            expect(asked.filter((m) => m === 'deviceLink.open')).toHaveLength(1);
        } finally { await h.done(); }
    });
});
