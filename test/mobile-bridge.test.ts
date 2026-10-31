import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Baton, PairingPins, ShareLinks } from '../src/core/remote.js';
import { inMemoryPair } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { AgentWindows, connectRemote } from '../src/renderer/remote-bridge.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/**
 * THE PHONE'S BRIDGE (2026-10-30) — `connectRemote(…, { profile: 'mobile', windows })`. The phone reads an agent as a
 * window of its ledger and keeps it live from patches; when the socket drops (the phone slept, changed networks) the
 * NEXT connection resumes from the rows it already holds — `windows` outlives the connection — instead of reading the
 * ledger again. A prompt's photos and a file upload cross as staged chunks; a workspace's files read through the host.
 */

type Row = { id: string; at: number; event: { kind: 'message'; speaker: 'agent'; peerName: null; text: string } };
const msg = (id: string, text = id): Row => ({ id, at: 1, event: { kind: 'message', speaker: 'agent', peerName: null, text } });

let ledger: Row[] = [msg('r1'), msg('r2'), msg('r3')];
let dir: string;
let host: RemoteHost;
let devices: DeviceStore;
const calls: Array<{ method: string; args: unknown[] }> = [];
const listeners = new Set<(channel: string, payload: unknown) => void>();
const detail = () => ({ agent: { id: 'agent_a', name: 'atlas', provider: 'claude', fidelity: 'declared', cwd: '/w' }, session: null, rows: ledger, turns: 0, cost: null, refusal: null });
const api: HostApi = {
    invoke: async (method, args) => {
        calls.push({ method, args });
        if (method === 'snapshot') return { agents: [], workspaces: [{ id: 'tynn', path: '/w/tynn', agentsKnown: true }], deckItems: [], signals: {} };
        if (method === 'agentDetail') return detail();
        if (method === 'files.children') return [{ id: 'a.md', label: 'a.md', type: 'file', ext: 'md' }];
        if (method === 'files.open') return { ok: true, path: 'a.md', text: '# a', sha: 's' };
        if (method === 'files.readMedia') return { ok: true, path: 'p.png', base64: 'iVBORw0KGgo=', sha: 's' };
        return { ok: true };
    },
    onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    workspaceOfAgent: () => 'tynn',
};
let connections: Array<(c: ReturnType<typeof inMemoryPair>['server']) => void> = [];
const emit = (channel: string, payload: unknown) => { for (const l of listeners) l(channel, payload); };
const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-mobile-bridge-'));
    ledger = [msg('r1'), msg('r2'), msg('r3')];
    calls.length = 0;
    connections = [];
    devices = await DeviceStore.open(dir, { now: () => 1, random: () => 'tok' });
    host = new RemoteHost({ confirm: allowEveryPairing, api, hostName: 'alphar', baton: new Baton(), pins: new PairingPins({ now: () => 1, random: () => 0.5 }), shares: new ShareLinks({ host: 'x', now: () => 1, random: () => 's' }), devices, transport: { onConnection: (cb) => { connections.push(cb); return () => {}; } } });
});
afterEach(async () => { await devices.flushed(); await rm(dir, { recursive: true, force: true }); });

const dial = (auth: Parameters<typeof connectRemote>[1], windows: AgentWindows) => {
    const pair = inMemoryPair();
    for (const cb of connections) cb(pair.server);
    return connectRemote(pair.client, auth, 'phone', { profile: 'mobile', windows });
};

describe('the phone’s bridge', () => {
    it('reads an agent as a window, stays live from patches, and RESUMES from its cursor on the next connection', async () => {
        const windows = new AgentWindows();
        const { code } = host.issuePin();
        const a = dial({ kind: 'pin', code, label: 'phone' }, windows);
        expect((await a.ready).ok).toBe(true);
        const token = a.state().token!;
        const first = await a.bridge.agentDetail('agent_a');
        expect(first?.rows.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
        expect(calls.some((c) => c.method === 'agentDetail')).toBe(true); // the host built it once, for the window
        const seen: string[][] = [];
        a.bridge.subscribeAgent('agent_a', (d) => { if (d) seen.push(d.rows.map((r) => r.id)); });
        ledger = [...ledger, msg('r4')];
        emit('agent:agent_a', detail());
        await tick();
        expect(seen.at(-1)).toEqual(['r1', 'r2', 'r3', 'r4']);

        // The phone sleeps; meanwhile r4 finished and r5 arrived. A new connection, the same windows.
        a.close();
        ledger = [...ledger.slice(0, 3), msg('r4', 'r4 done'), msg('r5')];
        const b = dial({ kind: 'token', token, label: 'phone' }, windows);
        expect((await b.ready).ok).toBe(true);
        const resumed = await b.bridge.agentDetail('agent_a');
        expect(resumed?.rows.map((r) => (r as Row).event.text)).toEqual(['r1', 'r2', 'r3', 'r4 done', 'r5']);
        const watch = calls.filter((c) => c.method === 'agentDetail');
        expect(watch.length).toBe(2);
        // What crossed the wire for the resume was a cursor: the host answered `resume`, not the whole ledger.
        expect(windows.lastBase('agent_a')).toBe('resume');
        b.close();
    });

    it('a prompt with a photo crosses as staged chunks and reaches the host as bytes; text-only stays a plain prompt', async () => {
        const { code } = host.issuePin();
        const c = dial({ kind: 'pin', code, label: 'phone' }, new AgentWindows());
        await c.ready;
        await c.takeBaton();
        const photo = new Uint8Array(700_000).fill(0xab);
        photo.set([0xff, 0xd8, 0xff], 0);
        expect(await c.bridge.prompt('agent_a', 'what is this?', [{ name: 'IMG_9.jpg', type: 'image/jpeg', bytes: photo }])).toEqual({ ok: true });
        const p = calls.find((x) => x.method === 'prompt')!;
        const [att] = p.args[2] as Array<{ name: string; bytes: Uint8Array }>;
        expect(att!.name).toBe('IMG_9.jpg');
        expect(att!.bytes.byteLength).toBe(700_000);
        expect(Buffer.from(att!.bytes).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
        expect(await c.bridge.prompt('agent_a', 'just text')).toEqual({ ok: true });
        expect(calls.filter((x) => x.method === 'prompt').at(-1)!.args).toEqual(['agent_a', 'just text']);
    });

    it('a DESKTOP remote window (no phone profile) sends files with a message too — as staged bytes, never a host path (genie#1356)', async () => {
        const { code } = host.issuePin();
        const pair = inMemoryPair();
        for (const cb of connections) cb(pair.server);
        const desk = connectRemote(pair.client, { kind: 'pin', code, label: 'laptop' }, 'laptop');
        await desk.ready;
        await desk.takeBaton();
        const bytes = new Uint8Array(300_000).fill(7);
        expect(await desk.bridge.prompt('agent_a', 'see attached', [{ name: 'notes.txt', type: 'text/plain', bytes }])).toEqual({ ok: true });
        const p = calls.filter((x) => x.method === 'prompt').at(-1)!;
        const [att] = p.args[2] as Array<{ name: string; bytes: Uint8Array }>;
        expect(att!.name).toBe('notes.txt');
        expect(att!.bytes.byteLength).toBe(300_000);
    });

    it('reads a workspace’s folder, a text file and an image’s bytes through the host', async () => {
        const { code } = host.issuePin();
        const c = dial({ kind: 'pin', code, label: 'phone' }, new AgentWindows());
        await c.ready;
        expect(await c.bridge.files.children!('tynn', '')).toEqual([{ id: 'a.md', label: 'a.md', type: 'file', ext: 'md' }]);
        expect(await c.bridge.files.open('tynn', 'a.md')).toMatchObject({ ok: true, text: '# a' });
        expect(await c.bridge.files.readMedia!('tynn', 'p.png')).toMatchObject({ ok: true, base64: 'iVBORw0KGgo=' });
    });
});
