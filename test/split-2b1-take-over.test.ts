import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, parseMessage, type CallContext, type PreAuth, type WireMessage } from '../src/core/remote-protocol.js';
import { IPC_INVENTORY, WINDOW_ENGINE_INVENTORY } from '../src/core/ipc-inventory.js';
import { takeOverRouteOf } from '../src/core/take-over-route.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import { openCallersTerminalWindow } from '../src/main/host-terminal-windows.js';
import { windowOpsHandler } from '../src/main/window-tunnel.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * CLIENT/HOST SPLIT STEP 2b-1, TAKE OVER ON THE ONE PROTOCOL (Tynn #898, story #896). A client is a dumb terminal (the
 * owner's ruling), the local window included: Take over is the protocol's `takeOver`, answered by genie-host, which starts
 * the TUI. The window that asked opens its own Take Over window: genie-host asks that window's process for it over
 * `client.windowOp`, and the op settles when the window closes, so the host ends the TUI itself. Another machine's window
 * still gets its companion ticket and opens its own. The local connection's refusal is gone; no refusal is added.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
/** Comment LINES go (the repo's source-guard convention); never a block regex. */
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const settled = async () => { for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setImmediate(r)); };
const context = (connectionId: string, origin: CallContext['origin'] = 'local-window'): CallContext =>
    ({ connectionId, origin, profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: 'x' });

describe('genie-host opens the asking window\'s terminal window and ends the TUI when it closes', () => {
    const ports = (owners: Record<string, string>, answer: () => Promise<unknown>) => {
        const asked: Array<{ owner: string; op: string; args: unknown[] }> = [];
        return { asked, ports: { ownerOf: (id: string) => owners[id] ?? null, windowOp: (owner: string, op: string, args: unknown[]) => { asked.push({ owner, op, args }); return answer(); }, log: () => {} } };
    };

    it('a tunnelled caller: its own window process is asked, with the route', async () => {
        const p = ports({ c1: 'win-1' }, async () => 'closed');
        const closed = vi.fn();
        expect(openCallersTerminalWindow(p.ports, context('c1'), takeOverRouteOf('term_1'), closed)).toBe(true);
        expect(p.asked).toEqual([{ owner: 'win-1', op: 'terminal.window', args: [takeOverRouteOf('term_1')] }]);
        await settled();
        expect(closed).toHaveBeenCalledExactlyOnceWith('closed');
    });

    it('a window already open on it is raised, and the TUI is NOT ended', async () => {
        const p = ports({ c1: 'win-1' }, async () => 'raised');
        const closed = vi.fn();
        openCallersTerminalWindow(p.ports, context('c1'), takeOverRouteOf('term_1'), closed);
        await settled();
        expect(closed).not.toHaveBeenCalled();
    });

    it('a window process that is gone before it closes reports failed', async () => {
        const p = ports({ c1: 'win-1' }, async () => { throw new Error('the caller’s own window is no longer connected'); });
        const closed = vi.fn();
        openCallersTerminalWindow(p.ports, context('c1'), takeOverRouteOf('term_1'), closed);
        await settled();
        expect(closed).toHaveBeenCalledExactlyOnceWith('failed');
    });

    it('CONTROL: a caller no window of this machine carries (another machine, no context) is not asked', () => {
        const p = ports({ c1: 'win-1' }, async () => 'closed');
        expect(openCallersTerminalWindow(p.ports, context('c9', 'device'), takeOverRouteOf('term_1'), () => {})).toBe(false);
        expect(openCallersTerminalWindow(p.ports, undefined, takeOverRouteOf('term_1'), () => {})).toBe(false);
        expect(p.asked).toEqual([]);
    });
});

describe('the window process opens a Take Over window when genie-host asks', () => {
    const handler = (log: string[], answer: 'closed' | 'raised' = 'closed') => windowOpsHandler({
        trash: async () => {}, workspaces: () => [], openApp: async () => {},
        openTerminalWindow: async (route) => { log.push(route); return answer; },
    });

    it('a Take Over route opens, and the op answers when the window closes (or is raised)', async () => {
        const log: string[] = [];
        await expect(handler(log)('terminal.window', [takeOverRouteOf('term_1')])).resolves.toBe('closed');
        await expect(handler(log, 'raised')('terminal.window', [takeOverRouteOf('term_2')])).resolves.toBe('raised');
        expect(log).toEqual([takeOverRouteOf('term_1'), takeOverRouteOf('term_2')]);
    });

    it('anything that is not a terminal window\'s route is refused and opens nothing', async () => {
        const log: string[] = [];
        for (const bad of ['https://example.com', 'genie://settings', '', 42]) await expect(handler(log)('terminal.window', [bad])).rejects.toThrow(/terminal window/);
        expect(log).toEqual([]);
    });
});

describe('RemoteHost serves Take over to this machine\'s window too', () => {
    let dir: string;
    let devices: DeviceStore;
    let accept: (c: ReturnType<typeof inMemoryPair>['server']) => void;
    let invoke: ReturnType<typeof vi.fn>;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie-2b1-'));
        devices = await DeviceStore.open(dir, { now: Date.now, random: () => 'tok' });
        invoke = vi.fn(async (method: string) => (method === 'takeOver' ? { ok: true, terminalId: 'term_t', started: true } : { ok: true }));
        const api: HostApi = { invoke: invoke as unknown as HostApi['invoke'], onEvent: () => () => {}, workspaceOfAgent: () => 'ws' };
        new RemoteHost({ api, hostName: 'alphar', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now, random: () => 0.482913 }), confirm: allowEveryPairing,
            transport: { onConnection: (l) => { accept = l; return () => {}; } } });
    });
    afterEach(async () => { await devices.flushed(); await rm(dir, { recursive: true, force: true }); });

    async function connect(preAuth: PreAuth | null, auth: object) {
        const pair = inMemoryPair();
        const inbox: WireMessage[] = [];
        const waiters: Array<(m: WireMessage) => void> = [];
        pair.client.onMessage((t) => { const r = parseMessage(t); if (!r.ok) return; const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
        const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage>((r) => waiters.push(r)));
        accept(preAuth ? { ...pair.server, preAuth } : pair.server);
        pair.client.send(JSON.stringify({ kind: 'hello', auth, label: 'x' }));
        let m = await next();
        while (m.kind !== 'welcome') m = await next();
        let id = 0;
        return { call: async (method: string, ...args: unknown[]) => { pair.client.send(JSON.stringify({ kind: 'call', id: ++id, method, args })); let r = await next(); while (r.kind !== 'result') r = await next(); return r; } };
    }

    it('the local window\'s takeOver reaches the host with its context, and no companion ticket is issued', async () => {
        const w = await connect({ kind: 'local', window: 'main', label: 'this Genie window', isOwner: true, workspaceId: null, readonly: false }, { kind: 'local' });
        const r = await w.call('takeOver', 'agent_a');
        expect(r).toMatchObject({ kind: 'result', ok: true, value: { ok: true, terminalId: 'term_t' } });
        expect((r as { value: { ticket?: unknown } }).value.ticket).toBeUndefined();
        const call = invoke.mock.calls.find((c) => c[0] === 'takeOver')!;
        expect(call[1]).toEqual(['agent_a']);
        expect(call[2]).toMatchObject({ origin: 'local-window' });
    });

    it('CONTROL: another machine\'s owner window still gets its ticket', async () => {
        const w = await connect({ kind: 'relay', label: 'laptop', isOwner: true, workspaceId: null, readonly: false }, { kind: 'relay' });
        await w.call('baton.take');
        const r = await w.call('takeOver', 'agent_a');
        expect(r).toMatchObject({ kind: 'result', ok: true, value: { ok: true, terminalId: 'term_t', ticket: expect.any(String) } });
    });
});

describe('hostRemoteApi hands its own answers who called', () => {
    it('an own answer reads the caller\'s context', async () => {
        const own = vi.fn(async () => ({ ok: true }));
        const api = hostRemoteApi({ hostName: 'alphar', own: { takeOver: own } } as never);
        await api.invoke('takeOver', ['agent_a'], context('c1'));
        expect(own).toHaveBeenCalledWith(['agent_a'], expect.objectContaining({ connectionId: 'c1', origin: 'local-window' }));
    });
});

describe('Take over leaves the window\'s IPC (source guards)', () => {
    it('no genie:take-over handler, preload member, or main-side start; main does not end the TUI itself', () => {
        expect(code(src('src/main/preload.ts'))).not.toContain("'genie:take-over'");
        const main = code(src('src/main/main.ts'));
        expect(main).not.toContain("'genie:take-over'");
        expect(main).not.toMatch(/\btakeOverHere\b/);
        expect(main).not.toMatch(/takeOvers\??\.(start|windowClosed)\(/);
        expect(IPC_INVENTORY.map(([c]) => c)).not.toContain('genie:take-over');
    });

    it('the local window\'s bridge takes Take over from the protocol', () => {
        expect(code(src('src/renderer/local-session.ts'))).toMatch(/takeOver: \(id\) => answered\(\(b\) => b\.takeOver\(id\)\)/);
    });

    it('genie-host answers takeOver with the caller\'s context and opens its window there', () => {
        const host = code(src('src/main/genie-host.ts'));
        expect(host).toMatch(/takeOver: async \(args, context\) =>/);
        expect(host).toMatch(/openCallersTerminalWindow\(/);
        expect(code(src('src/main/remote-host.ts'))).not.toContain('this window does it itself');
    });

    it('takeOvers stays only for main\'s deck liveness, under 2f (the coordinator, 2026-11-19)', () => {
        expect(WINDOW_ENGINE_INVENTORY).toContainEqual(['takeOvers', 'move:2f']);
        expect(code(src('src/main/main.ts'))).toMatch(/takeOvers: \(\) => takeOvers/);
    });
});
