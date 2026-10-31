import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Baton, PairingPins, ShareLinks } from '../src/core/remote.js';
import { inMemoryPair, type ServerConnection } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/**
 * THE REMOTE BRIDGE (§6.8) — the renderer's GenieBridge over a transport to another machine's
 * RemoteHost. The App does not know it is remote except through `state()`: the host's name for the
 * loud badge, who is driving, whether this screen holds the baton, the lock, and the LAST REFUSAL
 * (a write without the baton is refused by the host and the bridge's void methods have nowhere to
 * put that but here). Events from the host become the bridge's subscriptions. Tested end to end
 * against the real RemoteHost over the in-memory pair — no sockets, no mocks of either side.
 */

const snapshot = { agents: [{ id: 'agent_a', name: 'atlas', workspaceId: 'tynn' }], workspaces: [{ id: 'tynn', path: '/w/tynn', agentsKnown: true }], deckItems: [], signals: {} };

function fakeApi() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const listeners = new Set<(channel: string, payload: unknown) => void>();
    const api: HostApi = {
        invoke: async (method, args) => {
            calls.push({ method, args });
            if (method === 'snapshot') return snapshot;
            if (method === 'agentDetail') return { agent: { id: args[0] }, rows: [] };
            if (method === 'features.snapshot') return siteRoutes === null ? { knowledge: { hits: null } } : { knowledge: { hits: null }, browser: { url: null, routes: siteRoutes, canGoBack: false, canGoForward: false } };
            if (method === 'features.act') throw new Error('that is you');
            if (method === 'terminals.open') return { id: 'term_9', pid: 9, shell: 'sh', scrollback: '' };
            if (method === 'terminals.list') return [{ id: 'term_9', pid: 9, shell: 'sh' }];
            if (method === 'updates.state') return { phase: 'idle', version: null, percent: null, error: null, checkedAt: null };
            if (method === 'restartWithHandoff') return { ok: false, reason: 'no handoff fin_1 for atlas' };
            return { ok: true };
        },
        onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
        workspaceOfAgent: () => 'tynn',
    };
    return { api, calls, emit: (channel: string, payload: unknown) => { for (const l of listeners) l(channel, payload); } };
}

/** The host's `.gen` sites in its features snapshot, for the browser test; `null` = the snapshot has no browser section. */
let siteRoutes: Array<{ host: string; target: string }> | null = null;
let dir: string;
let api: ReturnType<typeof fakeApi>;
let host: RemoteHost;
let devices: DeviceStore;
let accept: (c: ServerConnection) => void = () => {};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-remote-bridge-'));
    api = fakeApi();
    devices = await DeviceStore.open(dir, { now: () => 1, random: () => 'tok' });
    host = new RemoteHost({ confirm: allowEveryPairing,
        api: api.api,
        hostName: 'alphar',
        baton: new Baton(),
        pins: new PairingPins({ now: () => 1, random: () => 0.482913 }),
        shares: new ShareLinks({ host: 'alphar:7421', now: () => 1, random: () => 's' }),
        devices,
        transport: { onConnection: (cb) => { accept = cb; return () => {}; } },
    });
});

afterEach(async () => {
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
});

function dial(auth: Parameters<typeof connectRemote>[1], label = 'laptop', options?: unknown) {
    const pair = inMemoryPair();
    accept(pair.server);
    return (connectRemote as (...a: unknown[]) => ReturnType<typeof connectRemote>)(pair.client, auth, label, ...(options === undefined ? [] : [options]));
}

describe('connecting', () => {
    it('a welcome makes the bridge live and names the host for the badge; a refusal is the ready answer and the state stays disconnected', async () => {
        host.issuePin();
        const remote = dial({ kind: 'pin', code: '482913' });
        expect(await remote.ready).toEqual({ ok: true });
        expect(remote.state()).toMatchObject({ connected: true, host: 'alphar', isOwner: true, workspaceId: null, driving: false, driver: null, locked: false, lastRefusal: null, token: 'tok' });

        const bad = dial({ kind: 'token', token: 'nope' });
        expect(await bad.ready).toEqual({ ok: false, reason: 'this device is not paired with alphar' });
        expect(bad.state()).toMatchObject({ connected: false, host: null });
    });
});

describe('the bridge over the wire', () => {
    it('reads answer; a write without the baton lands in lastRefusal; with the baton it reaches the host; subscriptions are the host’s events', async () => {
        host.issuePin();
        const remote = dial({ kind: 'pin', code: '482913' });
        await remote.ready;
        const { bridge } = remote;

        expect(await bridge.snapshot()).toEqual(snapshot);
        expect(await bridge.agentDetail('agent_a')).toEqual({ agent: { id: 'agent_a' }, rows: [] });

        bridge.openAgent('agent_a');
        await tick();
        expect(remote.state().lastRefusal).toBe('nobody is driving alphar; take the baton to make changes');
        expect(api.calls.some((c) => c.method === 'openAgent')).toBe(false);

        expect(await remote.takeBaton()).toEqual({ ok: true });
        expect(remote.state()).toMatchObject({ driving: true, driver: 'laptop' });
        bridge.openAgent('agent_a');
        bridge.prompt('agent_a', 'hello');
        await tick();
        expect(api.calls.filter((c) => c.method === 'openAgent' || c.method === 'prompt')).toEqual([{ method: 'openAgent', args: ['agent_a'] }, { method: 'prompt', args: ['agent_a', 'hello'] }]);

        const snaps: unknown[] = [];
        const details: unknown[] = [];
        const off = bridge.subscribe((s) => snaps.push(s));
        bridge.subscribeAgent('agent_a', (d) => details.push(d));
        api.emit('snapshot', snapshot);
        api.emit('agent:agent_a', { agent: { id: 'agent_a' }, rows: [1] });
        api.emit('agent:agent_b', { agent: { id: 'agent_b' }, rows: [] });
        await tick();
        expect(snaps).toEqual([snapshot]);
        expect(details).toEqual([{ agent: { id: 'agent_a' }, rows: [1] }]);
        off();
        api.emit('snapshot', snapshot);
        await tick();
        expect(snaps).toHaveLength(1);
    });

    it('promise-returning methods carry the host’s answer or refusal; host-only ones say where to do it; a feature refusal rejects like the local bridge', async () => {
        host.issuePin();
        const remote = dial({ kind: 'pin', code: '482913' });
        await remote.ready;
        await remote.takeBaton();
        const { bridge } = remote;

        expect(await bridge.restartWithHandoff('agent_a', 'fin_1')).toEqual({ ok: false, reason: 'no handoff fin_1 for atlas' });
        expect(await bridge.resolvePrompt('agent_a', 'draft1', 'send')).toEqual({ ok: true });
        expect(api.calls).toContainEqual({ method: 'resolvePrompt', args: ['agent_a', 'draft1', 'send'] });
        expect(await bridge.takeOver('agent_a')).toEqual({ ok: false, reason: 'takeOver opens a window on alphar; do it there' });
        bridge.addWorkspace();
        await tick();
        expect(remote.state().lastRefusal).toBe('addWorkspace opens a folder picker on alphar; do it there');

        expect(await bridge.terminals.open('tynn', { cols: 80, rows: 24 })).toEqual({ id: 'term_9', pid: 9, shell: 'sh', scrollback: '' });
        expect(await bridge.terminals.list('tynn')).toEqual([{ id: 'term_9', pid: 9, shell: 'sh' }]);
        const data: string[] = [];
        bridge.terminals.onData((id, d) => data.push(`${id}:${d}`));
        api.emit('terminal-data', { id: 'term_9', data: 'hi' });
        await tick();
        expect(data).toEqual(['term_9:hi']);

        expect(await bridge.features.snapshot()).toEqual({ knowledge: { hits: null } });
        await expect(bridge.features.act({ kind: 'knowledge.search', query: 'x' })).rejects.toThrow('that is you');
        // Nothing to place on a screen that is not the host's: resolves, calls nothing.
        await expect(bridge.features.setBrowserBounds({ x: 0, y: 0, width: 1, height: 1 })).resolves.toBeUndefined();
        expect(api.calls.some((c) => c.method === 'features.setBrowserBounds')).toBe(false);

        expect(await bridge.updates.state()).toMatchObject({ phase: 'idle' });
    });

    it('the lock is visible to every connection; lock/unlock through the client are owner calls', async () => {
        host.issuePin();
        const remote = dial({ kind: 'pin', code: '482913' });
        await remote.ready;
        expect(await remote.lock()).toEqual({ ok: true });
        await remote.refreshBaton();
        expect(remote.state().locked).toBe(true);
        remote.bridge.prompt('agent_a', 'x');
        await tick();
        expect(remote.state().lastRefusal).toBe('this Genie is locked');
        expect(await remote.bridge.resolvePrompt('agent_a', 'draft1', 'discard')).toMatchObject({ ok: false, reason: 'this Genie is locked' });
        expect(await remote.unlock()).toEqual({ ok: true });
    });
});

describe('the host’s sites in Genie’s browser (browser rebuild step 4)', () => {
    afterEach(() => { siteRoutes = null; });

    it('given the local browser, the bridge opens it with the address and the HOST’s site names (read from the host)', async () => {
        siteRoutes = [{ host: 'app.gen', target: 'http://127.0.0.1:8001' }, { host: 'shop.gen', target: 'http://127.0.0.1:8002' }];
        host.issuePin();
        const asked: Array<{ address: string | undefined; hosts: readonly string[] }> = [];
        const remote = dial({ kind: 'pin', code: '482913' }, 'laptop', { browse: async (address: string | undefined, hosts: readonly string[]) => { asked.push({ address, hosts }); return { ok: true }; } });
        await remote.ready;
        const browserWindow = (remote.bridge as { browserWindow?: { open(address?: string): Promise<unknown> } }).browserWindow;
        expect(browserWindow).toBeDefined();
        expect(await browserWindow!.open('https://app.gen/login')).toEqual({ ok: true });
        expect(asked).toEqual([{ address: 'https://app.gen/login', hosts: ['app.gen', 'shop.gen'] }]);
    });

    it('CONTROL: no local browser handed in (a direct window) → no browserWindow, so no Browser row', async () => {
        host.issuePin();
        const remote = dial({ kind: 'pin', code: '482913' });
        await remote.ready;
        expect((remote.bridge as { browserWindow?: unknown }).browserWindow).toBeUndefined();
    });
});
