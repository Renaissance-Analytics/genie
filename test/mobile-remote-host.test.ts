import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Baton, PairingPins, ShareLinks } from '../src/core/remote.js';
import { inMemoryPair, parseMessage, type ClientTransport, type WireMessage } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';

/**
 * THE PHONE ON THE HOST (2026-10-30). A connection that says hello as `profile: 'mobile'` is a phone, and the host
 * treats it as one — better than Genie 1, which streamed every terminal's bytes to it:
 *
 *  - it receives the snapshot and the agents it WATCHES, nothing else: no terminal output, no feature or update pushes,
 *    and no other agent's ledger; a `terminals.*` call is refused in words;
 *  - a watched agent arrives as a window of its ledger, then as patches, and an agent nobody watches is not even built;
 *  - removing a device in Settings ends its live connection at once, not at its next reconnect;
 *  - bytes cross in chunks and are staged per connection; `files.upload` and a prompt's attachments take them from the
 *    stage only after the call passed its gates, and a guest's files are its own workspace's.
 *
 * A connection WITHOUT the profile (another Genie's window) is the positive control: it still hears everything.
 */

type Row = { id: string; text: string };
const rows: Row[] = [{ id: 'r1', text: 'hello' }, { id: 'r2', text: 'working' }];
const detailOf = (id: string) => (id === 'agent_a' ? { agent: { id, name: 'atlas', provider: 'claude' }, session: { status: 'working' }, rows } : null);

const snapshot = {
    agents: [{ id: 'agent_a', name: 'atlas', workspaceId: 'tynn' }, { id: 'agent_b', name: 'bolt', workspaceId: 'fancy' }],
    workspaces: [{ id: 'tynn', path: '/w/tynn', agentsKnown: true }, { id: 'fancy', path: '/w/fancy', agentsKnown: true }],
    deckItems: [],
    signals: {},
};

function fakeApi() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const listeners = new Set<(channel: string, payload: unknown) => void>();
    let options: { wantsAgent?: (id: string) => boolean } | undefined;
    const api: HostApi = {
        invoke: async (method, args) => {
            calls.push({ method, args });
            if (method === 'snapshot') return snapshot;
            if (method === 'agentDetail') return detailOf(String(args[0]));
            return { ok: true };
        },
        onEvent: (cb, opts) => { listeners.add(cb); options = opts; return () => listeners.delete(cb); },
        workspaceOfAgent: (id) => snapshot.agents.find((a) => a.id === id)?.workspaceId ?? null,
        workspaceOfTerminal: (id) => ({ term_t: 'tynn' } as Record<string, string>)[id] ?? null,
    };
    return { api, calls, wants: (id: string) => options?.wantsAgent?.(id) ?? true, emit: (channel: string, payload: unknown) => { for (const l of listeners) l(channel, payload); } };
}

function client(t: ClientTransport) {
    const inbox: WireMessage[] = [];
    const waiters: Array<(m: WireMessage) => void> = [];
    let closed = false;
    t.onClose(() => { closed = true; });
    t.onMessage((text) => { const r = parseMessage(text); if (!r.ok) throw new Error(r.reason); const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
    const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage>((r) => waiters.push(r)));
    let id = 0;
    return {
        hello: async (auth: unknown, extra: Record<string, unknown> = {}) => { t.send(JSON.stringify({ kind: 'hello', auth, label: 'phone', ...extra })); return next(); },
        call: async (method: string, ...args: unknown[]) => { t.send(JSON.stringify({ kind: 'call', id: ++id, method, args })); return next(); },
        next,
        /** Everything pushed so far, drained. */
        drain: async () => { await new Promise((r) => setTimeout(r, 5)); return inbox.splice(0); },
        closed: () => closed,
    };
}

let dir: string;
let host: RemoteHost;
let api: ReturnType<typeof fakeApi>;
let shares: ShareLinks;
let devices: DeviceStore;
let connect: () => ReturnType<typeof client>;
const now = 1_000_000;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-mobile-host-'));
    api = fakeApi();
    shares = new ShareLinks({ host: 'alphar:7421', now: () => now, random: () => 'sekrit' });
    let n = 0;
    devices = await DeviceStore.open(dir, { now: () => now, random: () => `tok${n++}` });
    const connections: Array<(c: ReturnType<typeof inMemoryPair>['server']) => void> = [];
    host = new RemoteHost({
        api: api.api,
        hostName: 'alphar',
        baton: new Baton(),
        pins: new PairingPins({ now: () => now, random: () => 0.123456 }),
        shares,
        devices,
        transport: { onConnection: (cb) => { connections.push(cb); return () => {}; } },
        now: () => now,
    });
    connect = () => { const pair = inMemoryPair(); for (const cb of connections) cb(pair.server); return client(pair.client); };
});

afterEach(async () => {
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
});

async function pairedPhone(profile: 'mobile' | null = 'mobile') {
    const { code } = host.issuePin();
    const c = connect();
    const welcome = await c.hello({ kind: 'pin', code }, profile ? { profile } : {});
    expect(welcome).toMatchObject({ kind: 'welcome', isOwner: true });
    return { c, token: (welcome as { token: string }).token };
}

describe('a phone receives only what a phone shows', () => {
    it('no terminal bytes, no features, no updates, no unwatched ledger — while a desktop window (no profile) still hears all of it', async () => {
        const { c: phone } = await pairedPhone('mobile');
        const desk = connect();
        const t = (await pairedPhone(null)).token;
        expect(await desk.hello({ kind: 'token', token: t })).toMatchObject({ kind: 'welcome' });
        await phone.drain(); await desk.drain();

        api.emit('terminal-data', { id: 'term_t', data: 'ls -la\r\n' });
        api.emit('terminal-exit', { id: 'term_t', exitCode: 0 });
        api.emit('features', { big: true });
        api.emit('updates', { phase: 'idle' });
        api.emit('activity', { agentId: 'agent_a' });
        api.emit('agent:agent_a', detailOf('agent_a'));
        api.emit('snapshot', snapshot);

        const phoneGot = (await phone.drain()).map((m) => (m as { channel: string }).channel);
        const deskGot = (await desk.drain()).map((m) => (m as { channel: string }).channel);
        expect(phoneGot).toEqual(['snapshot']);
        expect(deskGot).toEqual(['terminal-data', 'terminal-exit', 'features', 'updates', 'activity', 'agent:agent_a', 'snapshot']);
    });

    it('a phone’s terminals.* call is refused in words and never reaches the host API', async () => {
        const { c: phone } = await pairedPhone('mobile');
        await phone.call('baton.take');
        for (const m of ['terminals.open', 'terminals.list', 'terminals.attach', 'terminals.write']) {
            const r = await phone.call(m, 'tynn');
            expect(r, m).toMatchObject({ kind: 'result', ok: false });
            expect((r as { reason: string }).reason).toMatch(/phone/i);
        }
        expect(api.calls.filter((x) => x.method.startsWith('terminals.'))).toEqual([]);
    });

    it('agent.watch answers a window of the ledger; then only the watched agent is pushed, as a patch; unwatch stops it', async () => {
        const { c: phone } = await pairedPhone('mobile');
        await phone.drain();
        const watched = await phone.call('agent.watch', 'agent_a', { tail: 50 });
        expect(watched).toMatchObject({ kind: 'result', ok: true });
        const first = (watched as { value: { seq: number; detail: { agent: { name: string }; rows?: unknown }; rows: { base: null; append: Row[] } } }).value;
        expect(first.detail.agent.name).toBe('atlas');
        expect(first.detail.rows).toBeUndefined();
        expect(first.rows.base).toBeNull();
        expect(first.rows.append.map((r) => r.id)).toEqual(['r1', 'r2']);

        const r3 = { id: 'r3', text: 'done' };
        api.emit('agent:agent_a', { ...detailOf('agent_a')!, rows: [...rows, r3] });
        api.emit('agent:agent_b', { agent: { id: 'agent_b' }, rows: [] });
        const pushed = await phone.drain();
        expect(pushed).toHaveLength(1);
        expect(pushed[0]).toMatchObject({ kind: 'event', channel: 'agent:agent_a', payload: { seq: first.seq + 1, rows: { base: first.seq, keep: 2, append: [r3] } } });

        await phone.call('agent.unwatch', 'agent_a');
        api.emit('agent:agent_a', detailOf('agent_a'));
        expect(await phone.drain()).toEqual([]);
    });

    it('with only phones connected, an agent no phone watches is not even built (wantsAgent), and a desktop window wants every agent', async () => {
        const { c: phone } = await pairedPhone('mobile');
        expect(api.wants('agent_a')).toBe(false);
        await phone.call('agent.watch', 'agent_a', {});
        expect(api.wants('agent_a')).toBe(true);
        expect(api.wants('agent_b')).toBe(false);
        const t = (await pairedPhone(null)).token;
        const desk = connect();
        await desk.hello({ kind: 'token', token: t });
        expect(api.wants('agent_b')).toBe(true);
    });

    it('a guest phone may not watch an agent outside its workspace', async () => {
        const link = shares.mint({ workspaceId: 'tynn', grantedTo: 'wren', expiresInMs: 60_000 });
        const secret = new URL((shares.serve(link.id) as { url: string }).url).hash.slice(1);
        const g = connect();
        await g.hello({ kind: 'share', id: link.id, secret }, { profile: 'mobile' });
        expect(await g.call('agent.watch', 'agent_b', {})).toMatchObject({ ok: false });
        expect(await g.call('agent.watch', 'agent_a', {})).toMatchObject({ ok: true });
    });
});

describe('removing a device ends its live connection', () => {
    it('revoke closes the paired phone’s socket now, and its token is refused after', async () => {
        const { c: phone, token } = await pairedPhone('mobile');
        const other = await pairedPhone('mobile');
        const id = devices.list()[0]!.id;
        expect(host.revokeDevice(id)).toBe(true);
        await phone.drain();
        expect(phone.closed()).toBe(true);
        expect(other.c.closed()).toBe(false);
        expect(host.connections()).toHaveLength(1);
        const again = connect();
        expect(await again.hello({ kind: 'token', token })).toEqual({ kind: 'refused', reason: 'this device is not paired with alphar' });
    });
});

describe('bytes cross in chunks, staged per connection, taken only by a call that passed its gates', () => {
    const stage = async (c: ReturnType<typeof client>, name: string, body: string) => {
        const begun = await c.call('upload.begin', { name, size: Buffer.byteLength(body) });
        expect(begun).toMatchObject({ ok: true });
        const id = (begun as { value: { id: string } }).value.id;
        expect(await c.call('upload.chunk', id, 0, Buffer.from(body).toString('base64'))).toMatchObject({ ok: true });
        return id;
    };

    it('files.upload hands the host API the staged bytes by name — never a path or bytes the phone sent inline', async () => {
        const { c: phone } = await pairedPhone('mobile');
        await phone.call('baton.take');
        const id = await stage(phone, 'photo.jpg', 'JPEGBYTES');
        expect(await phone.call('files.upload', 'tynn', 'docs', { staged: id })).toMatchObject({ ok: true });
        const call = api.calls.find((x) => x.method === 'files.upload')!;
        expect(call.args[0]).toBe('tynn');
        expect(call.args[1]).toBe('docs');
        const file = call.args[2] as { name: string; bytes: Uint8Array };
        expect(file.name).toBe('photo.jpg');
        expect(Buffer.from(file.bytes).toString()).toBe('JPEGBYTES');
        // Spent: the same id again is refused, and an unknown one too.
        expect(await phone.call('files.upload', 'tynn', 'docs', { staged: id })).toMatchObject({ ok: false });
        expect(await phone.call('files.upload', 'tynn', '', { name: 'x.txt', bytes: 'inline' })).toMatchObject({ ok: false });
    });

    it('a prompt’s attachments are the staged bytes; another connection cannot spend my stage', async () => {
        const { c: phone } = await pairedPhone('mobile');
        await phone.call('baton.take');
        const id = await stage(phone, 'IMG_0001.jpg', '\xff\xd8\xffJPEG');
        const thief = (await pairedPhone('mobile')).c;
        expect(await thief.call('prompt', 'agent_a', 'look', [{ staged: id, type: 'image/jpeg' }])).toMatchObject({ ok: false });
        expect(await phone.call('prompt', 'agent_a', 'what is in this photo?', [{ staged: id, type: 'image/jpeg' }])).toMatchObject({ ok: true });
        const call = api.calls.find((x) => x.method === 'prompt')!;
        expect(call.args[1]).toBe('what is in this photo?');
        const [att] = call.args[2] as Array<{ name: string; type: string; bytes: Uint8Array }>;
        expect(att!.name).toBe('IMG_0001.jpg');
        expect(att!.type).toBe('image/jpeg');
        expect(att!.bytes.byteLength).toBe(Buffer.byteLength('\xff\xd8\xffJPEG'));
    });

    it('a guest uploads only into its own workspace, and reads only its own files', async () => {
        const link = shares.mint({ workspaceId: 'tynn', grantedTo: 'wren', expiresInMs: 60_000 });
        const secret = new URL((shares.serve(link.id) as { url: string }).url).hash.slice(1);
        const g = connect();
        await g.hello({ kind: 'share', id: link.id, secret }, { profile: 'mobile' });
        await g.call('baton.take');
        expect(await g.call('files.children', 'fancy', '')).toMatchObject({ ok: false });
        expect(await g.call('files.open', 'fancy', 'README.md')).toMatchObject({ ok: false });
        expect(await g.call('files.readMedia', 'fancy', 'a.png')).toMatchObject({ ok: false });
        const id = await stage(g, 'a.txt', 'a');
        expect(await g.call('files.upload', 'fancy', '', { staged: id })).toMatchObject({ ok: false });
        expect(await g.call('files.children', 'tynn', '')).toMatchObject({ ok: true });
        expect(api.calls.filter((x) => x.method.startsWith('files.')).map((x) => x.args[0])).toEqual(['tynn']);
    });

    it('a read-only connection cannot stage bytes at all', async () => {
        const conns: Array<(c: ReturnType<typeof inMemoryPair>['server']) => void> = [];
        const ro = new RemoteHost({ api: api.api, hostName: 'alphar', baton: new Baton(), pins: new PairingPins({ now: () => now, random: () => 0.5 }), shares, devices, transport: { onConnection: (cb) => { conns.push(cb); return () => {}; } } });
        const pair = inMemoryPair();
        const server = { ...pair.server, preAuth: { label: 'viewer', isOwner: false, workspaceId: 'tynn', readonly: true } };
        for (const cb of conns) cb(server);
        const v = client(pair.client);
        await v.hello({ kind: 'relay' }, { profile: 'mobile' });
        expect(await v.call('upload.begin', { name: 'a.txt', size: 1 })).toMatchObject({ ok: false });
        expect(ro.connections()).toHaveLength(1);
    });
});
