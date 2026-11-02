import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import { DeviceLinkService, type DeviceLinkEvent, type DeviceSocket } from '../src/main/device-link-service.js';
import { deviceTokenStore } from '../src/main/device-tokens.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import { fakeKeychain } from './helpers/tynn-storage.js';

/**
 * ANOTHER MACHINE'S DEVICE TOKEN IS THE HOST'S (P3.4 cut e, audit M-e). The token a PIN pairing mints is an owner-level key to that machine, and it sat in the window's
 * localStorage in plain text because the window dialled the socket itself. Moving only the storage would hand it back to the window on every dial, so the HOST dials.
 * The window gets a channel and speaks Genie's protocol on it: it asks for a saved hello, the host writes the token in, and the welcome comes back without one.
 */

const URL_A = 'wss://studio:7421/genie';
const ENTRY_A = `device/${URL_A}`;
const SECRET = 'dev_owner_level_token';
const OWNER = 'window-1';
let dir: string;
let file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'device-link-')); file = join(dir, 'device-hosts.json'); });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

type Lockable = ReturnType<typeof fakeKeychain> & { locked: boolean; garble: boolean };
function keychain(seed: Record<string, string> = {}): Lockable {
    const base = fakeKeychain(seed);
    const k: Lockable = {
        ...base, locked: false, garble: false,
        get: async (name: string) => {
            if (k.locked) return { kind: 'unavailable' as const, reason: 'the keyring is locked' };
            const read = await base.get(name);
            return k.garble && read.kind === 'value' ? { kind: 'value' as const, value: `${read.value}x` } : read;
        },
        set: async (name: string, value: string) => (k.locked ? { ok: false as const, reason: 'the keyring is locked' } : base.set(name, value)),
        delete: async (name: string) => (k.locked ? { ok: false as const, reason: 'the keyring is locked' } : base.delete(name)),
    } as Lockable;
    return k;
}

class FakeSocket implements DeviceSocket {
    readyState = 0;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    readonly sent: string[] = [];
    closed = 0;
    send(data: string): void { this.sent.push(data); }
    close(): void { this.closed += 1; }
    opens(): void { this.readyState = 1; this.onopen?.({}); }
    says(frame: unknown): void { this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) }); }
    ends(): void { this.readyState = 3; this.onclose?.({}); }
    fails(): void { this.onerror?.({}); }
}

function rig(k: Lockable = keychain(), options: { dialTimeoutMs?: number } = {}) {
    const tokens = deviceTokenStore(file, k);
    const sockets: { url: string; socket: FakeSocket }[] = [];
    const events: DeviceLinkEvent[] = [];
    const owners: string[] = [];
    const lines: string[] = [];
    const service = new DeviceLinkService({
        tokens,
        socket: (url) => { const socket = new FakeSocket(); sockets.push({ url, socket }); return socket; },
        send: (owner, event) => { owners.push(owner); events.push(event); },
        log: (line) => lines.push(line),
        ...options,
    });
    const opened = async (url = URL_A, owner = OWNER) => {
        const pending = service.open(owner, url);
        sockets.at(-1)?.socket.opens();
        const result = await pending;
        if (!result.ok) throw new Error(result.reason);
        return { channel: result.channel, socket: sockets.at(-1)!.socket };
    };
    const framesTo = (channel: string) => events.filter((e) => e.channel === channel && e.type === 'frame').map((e) => (e as { text: string }).text);
    const closedTo = (channel: string) => events.filter((e) => e.channel === channel && e.type === 'closed').map((e) => (e as { reason: string | null }).reason);
    return { k, tokens, service, sockets, events, owners, lines, opened, framesTo, closedTo };
}
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
const hello = (auth: unknown, label = 'my desk') => JSON.stringify({ kind: 'hello', auth, label });

describe('the device token store: the keychain holds the token, a file holds only where', () => {
    it('remember keeps it in the keychain as device/<url>; the index names the url and holds no token', async () => {
        const k = keychain();
        const store = deviceTokenStore(file, k);
        expect(await store.remember(URL_A, SECRET)).toEqual({ ok: true });
        expect(k.held.get(ENTRY_A)).toBe(SECRET);
        expect(store.hosts()).toEqual([URL_A]);
        expect(readFileSync(file, 'utf8')).toContain(URL_A);
        expect(readFileSync(file, 'utf8')).not.toContain(SECRET);
        if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it('a new store on the same file and keychain knows it: it survives a host restart', async () => {
        const k = keychain();
        await deviceTokenStore(file, k).remember(URL_A, SECRET);
        const again = deviceTokenStore(file, k);
        expect(again.hosts()).toEqual([URL_A]);
        expect(await again.tokenFor(URL_A)).toEqual({ kind: 'value', value: SECRET });
    });

    it('a keychain that refuses the write lists nothing, so the device is not shown as paired', async () => {
        const k = keychain();
        k.locked = true;
        const store = deviceTokenStore(file, k);
        expect((await store.remember(URL_A, SECRET)).ok).toBe(false);
        expect(store.hosts()).toEqual([]);
    });

    it('a read-back that differs by a byte is a failed write, and lists nothing', async () => {
        const k = keychain();
        k.garble = true;
        const store = deviceTokenStore(file, k);
        expect((await store.remember(URL_A, SECRET)).ok).toBe(false);
        expect(store.hosts()).toEqual([]);
    });

    it('forget removes the secret and the row; a locked keychain keeps the row, because the secret is still there', async () => {
        const k = keychain();
        const store = deviceTokenStore(file, k);
        await store.remember(URL_A, SECRET);
        k.locked = true;
        expect((await store.forget(URL_A)).ok).toBe(false);
        expect(store.hosts()).toEqual([URL_A]);
        k.locked = false;
        expect((await store.forget(URL_A)).ok).toBe(true);
        expect(store.hosts()).toEqual([]);
        expect(k.held.has(ENTRY_A)).toBe(false);
    });

    it('a locked keychain reads as unavailable, not as a device that never paired', async () => {
        const k = keychain();
        const store = deviceTokenStore(file, k);
        await store.remember(URL_A, SECRET);
        k.locked = true;
        expect((await store.tokenFor(URL_A)).kind).toBe('unavailable');
    });
});

describe('the host dials, and the token stays on its side', () => {
    it('a saved hello goes out with the token the keychain holds, and the window sent none', async () => {
        const r = rig(keychain({ [ENTRY_A]: SECRET }));
        const { channel, socket } = await r.opened();
        r.service.send(OWNER, channel, hello({ kind: 'saved', label: 'my desk' }));
        await settle();
        expect(JSON.parse(socket.sent[0]!)).toEqual({ kind: 'hello', auth: { kind: 'token', token: SECRET, label: 'my desk' }, label: 'my desk' });
    });

    it('a PIN hello passes as typed', async () => {
        const r = rig();
        const { channel, socket } = await r.opened();
        r.service.send(OWNER, channel, hello({ kind: 'pin', code: '123456', label: 'my desk' }));
        await settle();
        expect(JSON.parse(socket.sent[0]!).auth).toEqual({ kind: 'pin', code: '123456', label: 'my desk' });
    });

    it('the welcome reaches the window WITHOUT the minted token, which is in the keychain before the window hears', async () => {
        const r = rig();
        const { channel, socket } = await r.opened();
        r.service.send(OWNER, channel, hello({ kind: 'pin', code: '123456' }));
        await settle();
        socket.says({ kind: 'welcome', connectionId: 'c1', host: 'studio', isOwner: true, workspaceId: null, token: SECRET });
        await settle();
        const frames = r.framesTo(channel);
        expect(frames).toHaveLength(1);
        expect(JSON.parse(frames[0]!)).toEqual({ kind: 'welcome', connectionId: 'c1', host: 'studio', isOwner: true, workspaceId: null });
        expect(JSON.stringify(r.events)).not.toContain(SECRET);
        expect(r.k.held.get(ENTRY_A)).toBe(SECRET);
        expect(r.tokens.hosts()).toEqual([URL_A]);
    });

    it('what follows the welcome keeps its order behind it, even while the keychain is writing', async () => {
        const r = rig();
        const slowSet = r.k.set;
        let release: () => void = () => {};
        r.k.set = (async (name: string, value: string) => { await new Promise<void>((done) => { release = done; }); return slowSet(name, value); }) as never;
        const { channel, socket } = await r.opened();
        r.service.send(OWNER, channel, hello({ kind: 'pin', code: '123456' }));
        await settle();
        socket.says({ kind: 'welcome', connectionId: 'c1', host: 'studio', isOwner: true, workspaceId: null, token: SECRET });
        socket.says({ kind: 'event', channel: 'after', payload: 1 });
        await settle();
        expect(r.framesTo(channel), 'nothing overtakes the welcome').toEqual([]);
        release();
        await settle();
        expect(r.framesTo(channel).map((f) => JSON.parse(f).kind)).toEqual(['welcome', 'event']);
    });

    it('a keychain that will not keep the token still connects, says so in the log without the token, and lists nothing', async () => {
        const k = keychain();
        const r = rig(k);
        const { channel, socket } = await r.opened();
        r.service.send(OWNER, channel, hello({ kind: 'pin', code: '123456' }));
        await settle();
        k.locked = true;
        socket.says({ kind: 'welcome', connectionId: 'c1', host: 'studio', isOwner: true, workspaceId: null, token: SECRET });
        await settle();
        expect(JSON.parse(r.framesTo(channel)[0]!).kind).toBe('welcome');
        expect(JSON.stringify(r.events)).not.toContain(SECRET);
        expect(r.lines.join('\n')).toContain(URL_A);
        expect(r.lines.join('\n')).not.toContain(SECRET);
        expect(r.tokens.hosts()).toEqual([]);
    });

    it('frames after the welcome pass untouched, and a frame that merely mentions a token is not rewritten or kept', async () => {
        const r = rig();
        const { channel, socket } = await r.opened();
        r.service.send(OWNER, channel, hello({ kind: 'pin', code: '123456' }));
        await settle();
        socket.says({ kind: 'welcome', connectionId: 'c1', host: 'studio', isOwner: true, workspaceId: null });
        await settle();
        const later = JSON.stringify({ kind: 'welcome', connectionId: 'c2', host: 'x', isOwner: false, workspaceId: null, token: 'other' });
        socket.says(later);
        await settle();
        expect(r.framesTo(channel)[1]).toBe(later);
        expect(r.k.held.has(ENTRY_A)).toBe(false);
    });

    it('a refusal and a pairing prompt reach the window as they are', async () => {
        const r = rig();
        const { channel, socket } = await r.opened();
        r.service.send(OWNER, channel, hello({ kind: 'pin', code: '123456' }));
        await settle();
        socket.says({ kind: 'pairing', host: 'studio', expiresAt: 5 });
        socket.says({ kind: 'refused', reason: 'wrong PIN' });
        await settle();
        expect(r.framesTo(channel).map((f) => JSON.parse(f).kind)).toEqual(['pairing', 'refused']);
    });
});

describe('the window cannot use the channel to say anything else first', () => {
    it.each([
        ['a token the window claims to hold', hello({ kind: 'token', token: 'whatever' })],
        ['a relay hello, on a socket no relay checked', hello({ kind: 'relay' })],
        ['a call before any hello', JSON.stringify({ kind: 'call', id: 1, method: 'x', args: [] })],
        ['something that is not a frame', 'not json'],
    ])('%s closes the channel and nothing reaches the machine', async (_name, frame) => {
        const r = rig(keychain({ [ENTRY_A]: SECRET }));
        const { channel, socket } = await r.opened();
        r.service.send(OWNER, channel, frame);
        await settle();
        expect(socket.sent).toEqual([]);
        expect(socket.closed).toBe(1);
        expect(r.closedTo(channel)).toHaveLength(1);
    });

    it('a saved hello with no token says to type the PIN, and sends nothing', async () => {
        const r = rig();
        const { channel, socket } = await r.opened();
        r.service.send(OWNER, channel, hello({ kind: 'saved' }));
        await settle();
        expect(socket.sent).toEqual([]);
        expect(socket.closed).toBe(1);
        expect(r.closedTo(channel)[0]).toMatch(/PIN/);
    });

    it('a saved hello on a locked keychain says the keychain, never "type the PIN"', async () => {
        const k = keychain({ [ENTRY_A]: SECRET });
        k.locked = true;
        const r = rig(k);
        const { channel, socket } = await r.opened();
        r.service.send(OWNER, channel, hello({ kind: 'saved' }));
        await settle();
        expect(socket.sent).toEqual([]);
        expect(r.closedTo(channel)[0]).toMatch(/keychain/i);
        expect(r.closedTo(channel)[0]).not.toMatch(/PIN/);
    });

    it('frames sent while a saved hello is reading the keychain follow it in order', async () => {
        const r = rig(keychain({ [ENTRY_A]: SECRET }));
        const { channel, socket } = await r.opened();
        r.service.send(OWNER, channel, hello({ kind: 'saved' }));
        r.service.send(OWNER, channel, JSON.stringify({ kind: 'call', id: 1, method: 'x', args: [] }));
        await settle();
        expect(socket.sent.map((f) => JSON.parse(f).kind)).toEqual(['hello', 'call']);
    });
});

describe('the channel: whose it is, and how it ends', () => {
    it('only ws:// and wss:// are dialled, and anything else opens no socket', async () => {
        const r = rig();
        for (const url of ['relay:abc', 'https://studio/genie', 'http://studio/genie', 'file:///etc/passwd', '']) {
            expect((await r.service.open(OWNER, url)).ok, url).toBe(false);
        }
        expect(r.sockets).toEqual([]);
    });

    it('a socket that fails before it opens says which machine, and leaves no channel', async () => {
        const r = rig();
        const pending = r.service.open(OWNER, URL_A);
        r.sockets[0]!.socket.fails();
        const result = await pending;
        expect(result.ok).toBe(false);
        expect(result.ok ? '' : result.reason).toContain(URL_A);
        expect(r.events).toEqual([]);
    });

    it('a machine that never answers is given up on, and the socket is closed', async () => {
        const r = rig(keychain(), { dialTimeoutMs: 5 });
        const result = await r.service.open(OWNER, URL_A);
        expect(result.ok).toBe(false);
        expect(r.sockets[0]!.socket.closed).toBe(1);
    });

    it('another window cannot speak on, or close, a channel it did not open', async () => {
        const r = rig(keychain({ [ENTRY_A]: SECRET }));
        const { channel, socket } = await r.opened();
        r.service.send('window-2', channel, hello({ kind: 'saved' }));
        r.service.close('window-2', channel);
        await settle();
        expect(socket.sent).toEqual([]);
        expect(socket.closed).toBe(0);
    });

    it('frames go only to the window that opened it', async () => {
        const r = rig();
        const { channel, socket } = await r.opened();
        r.service.send(OWNER, channel, hello({ kind: 'pin', code: '1' }));
        await settle();
        socket.says({ kind: 'refused', reason: 'no' });
        await settle();
        expect(new Set(r.owners)).toEqual(new Set([OWNER]));
    });

    it('the socket ending says closed once, and an error then a close is still once', async () => {
        const r = rig();
        const { channel, socket } = await r.opened();
        socket.fails();
        socket.ends();
        await settle();
        expect(r.closedTo(channel)).toHaveLength(1);
    });

    it('a window gone from the link takes its sockets with it, and leaves the others', async () => {
        const r = rig();
        const mine = await r.opened(URL_A, OWNER);
        const theirs = await r.opened('wss://beast:7421/genie', 'window-2');
        r.service.dropOwner(OWNER);
        expect(mine.socket.closed).toBe(1);
        expect(theirs.socket.closed).toBe(0);
    });
});

describe('what a window can ask for over the link', () => {
    it('no method returns a token: it can hand one over, ask whether it moved, list the hosts, and forget one', async () => {
        const r = rig(keychain({ [ENTRY_A]: SECRET }));
        await r.tokens.remember(URL_A, SECRET);
        expect(JSON.stringify(await r.service.call(OWNER, 'hosts', []))).not.toContain(SECRET);
        await expect(r.service.call(OWNER, 'tokenFor', [URL_A])).rejects.toThrow(/no tokenFor/);
        await expect(r.service.call(OWNER, 'get', [URL_A])).rejects.toThrow();
    });

    it('adopt says true only when the keychain reads back the same bytes', async () => {
        const k = keychain();
        const r = rig(k);
        expect(await r.service.call(OWNER, 'adopt', [URL_A, SECRET])).toBe(true);
        expect(k.held.get(ENTRY_A)).toBe(SECRET);
        k.garble = true;
        expect(await r.service.call(OWNER, 'adopt', ['wss://beast:7421/genie', SECRET])).toBe(false);
        k.garble = false;
        k.locked = true;
        expect(await r.service.call(OWNER, 'adopt', ['wss://third:7421/genie', SECRET])).toBe(false);
    });

    it('adopt refuses an address that is not a host, so the keychain gets no junk entries', async () => {
        const k = keychain();
        const r = rig(k);
        expect(await r.service.call(OWNER, 'adopt', ['javascript:alert(1)', SECRET])).toBe(false);
        expect(k.held.size).toBe(0);
    });

    it('over the real link: open, say hello, hear the welcome without the token, and the window line never carries it', async () => {
        const k = keychain();
        const sockets: FakeSocket[] = [];
        const tokens = deviceTokenStore(file, k);
        let server: SessionEngineServer | null = null;
        const service = new DeviceLinkService({
            tokens,
            socket: () => { const s = new FakeSocket(); sockets.push(s); setImmediate(() => s.opens()); return s; },
            send: (owner, event) => server?.deviceEvent(owner, event),
            log: () => {},
        });
        const TOKEN = 'a'.repeat(64);
        server = new SessionEngineServer({ token: TOKEN, build: 'test', deviceLink: service });
        const host = new SessionHost({ userData: dir, driverFor: () => null, processTree: { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) }, ...server.hostOptions() });
        server.attach(host);
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const seen: string[] = [];
        windowSide.onMessage((line: string) => seen.push(line));
        const client = new SessionEngineClient();
        await client.connect(windowSide, TOKEN);
        const replica = client.deviceLink();
        const heard: { channel: string; text: string }[] = [];
        replica.onFrame((channel, text) => heard.push({ channel, text }));
        const opened = await replica.open(URL_A);
        if (!opened.ok) throw new Error(opened.reason);
        replica.send(opened.channel, hello({ kind: 'pin', code: '123456' }));
        await settle();
        sockets[0]!.says({ kind: 'welcome', connectionId: 'c1', host: 'studio', isOwner: true, workspaceId: null, token: SECRET });
        await settle();
        expect(heard).toHaveLength(1);
        expect(JSON.parse(heard[0]!.text).kind).toBe('welcome');
        expect(k.held.get(ENTRY_A)).toBe(SECRET);
        expect(seen.join('\n')).not.toContain(SECRET);
        expect(await replica.hosts()).toEqual([URL_A]);
    });

    it('a window dropping off the link closes its sockets at the host, and the channel it held says closed when the host goes', async () => {
        const sockets: FakeSocket[] = [];
        let server: SessionEngineServer | null = null;
        const service = new DeviceLinkService({
            tokens: deviceTokenStore(file, keychain()),
            socket: () => { const s = new FakeSocket(); sockets.push(s); setImmediate(() => s.opens()); return s; },
            send: (owner, event) => server?.deviceEvent(owner, event),
            log: () => {},
        });
        const TOKEN = 'a'.repeat(64);
        server = new SessionEngineServer({ token: TOKEN, build: 'test', deviceLink: service });
        const host = new SessionHost({ userData: dir, driverFor: () => null, processTree: { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) }, ...server.hostOptions() });
        server.attach(host);
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const client = new SessionEngineClient();
        await client.connect(windowSide, TOKEN);
        const replica = client.deviceLink();
        const closed: { channel: string; reason: string | null }[] = [];
        replica.onClosed((channel, reason) => closed.push({ channel, reason }));
        const opened = await replica.open(URL_A);
        if (!opened.ok) throw new Error(opened.reason);
        expect(sockets[0]!.closed).toBe(0);
        windowSide.close();
        await settle();
        expect(sockets[0]!.closed, 'the host let go of the socket').toBe(1);
        expect(closed).toEqual([{ channel: opened.channel, reason: 'the host closed the connection' }]);
    });

    it('the host going away closes the channels the window holds, with its words', async () => {
        const replica = new SessionEngineClient().deviceLink();
        const closed: { channel: string; reason: string | null }[] = [];
        replica.onClosed((channel, reason) => closed.push({ channel, reason }));
        replica.lost('the host closed the connection');
        expect(closed).toEqual([]);
        expect((await replica.open(URL_A)).ok).toBe(false);
        expect(await replica.hosts()).toEqual([]);
        expect(await replica.adopt(URL_A, SECRET)).toBe(false);
    });
});
