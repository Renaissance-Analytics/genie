import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IPC_INVENTORY } from '../src/core/ipc-inventory.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { REMOTE_METHODS, WORKSPACE_SCOPED_METHODS, capabilityOf, inMemoryPair, parseMessage, type CallContext, type RemoteMethod, type WireMessage } from '../src/core/remote-protocol.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { HOST_ALONE_METHODS } from '../src/main/host-alone-api.js';
import { OS_WORKSPACE } from '../src/main/registry.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { ScratchTerminals, scratchTerminalFor } from '../src/main/scratch-terminal.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * CLIENT/HOST SPLIT STEP 2c-4, THE SCRATCH TERMINAL (Tynn #898, story #897, task #1433; the coordinator's plan). The
 * header's throwaway Terminal (Tynn story #378) and the tray's (Tynn #761) are one protocol write, terminals.scratch
 * (workspaceId | null), answered by genie-host: it opens the DISPOSABLE shell with the workspace's environment (its
 * shellEnv) and asks the caller's window process to open its window (the terminal.window op, like Take Over). Closing
 * that window ends it. Another machine's window gets a companion ticket and opens its own. Workspace-scoped: a share
 * guest has its own workspace's; the null (home) one, Genie's own, is the host owner's only. main's channel and its own
 * ScratchTerminals go; the tray asks over its own protocol connection.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const OWNER: CallContext = { connectionId: 'rc_1', origin: 'remote-window', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: 'laptop' };
const METHOD = 'terminals.scratch' as RemoteMethod;

function fakeScratch() {
    const asked: Array<[string | null, CallContext | undefined]> = [];
    return { asked, scratchTerminals: { open: (workspaceId: string | null, context?: CallContext) => { asked.push([workspaceId, context]); return { ok: true as const, terminalId: 'pty_9', route: 'genie://takeover/pty_9' }; } } };
}

describe('terminals.scratch is the host’s, workspace-scoped', () => {
    it('is a remote method, a write, workspace-scoped, not `local`; genie-host answers it', () => {
        expect(REMOTE_METHODS as readonly string[]).toContain(METHOD);
        expect(capabilityOf(METHOD)).toBe('write');
        expect(WORKSPACE_SCOPED_METHODS).toContain(METHOD);
        expect(HOST_ALONE_METHODS.has(METHOD)).toBe(true);
    });

    it('the host API opens the named workspace’s, or Genie’s own for null, with the caller’s context', async () => {
        const s = fakeScratch();
        const api = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null, scratchTerminals: s.scratchTerminals } as unknown as HostApiDeps);
        expect(await api.invoke(METHOD, ['ws_a'], OWNER)).toEqual({ ok: true, terminalId: 'pty_9', route: 'genie://takeover/pty_9' });
        expect(await api.invoke(METHOD, [null], OWNER)).toMatchObject({ ok: true });
        expect(await api.invoke(METHOD, [42], OWNER)).toEqual({ ok: false, reason: 'No workspace named.' });
        expect(s.asked).toEqual([['ws_a', OWNER], [null, OWNER]]);
    });

    it('CONTROL: with no scratch port the host says it cannot, in words', async () => {
        const api = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null } as unknown as HostApiDeps);
        expect(await api.invoke(METHOD, ['ws_a'], OWNER)).toEqual({ ok: false, reason: 'this host cannot open a scratch terminal' });
    });
});

describe('genie-host’s scratch terminal: the workspace’s shell or the home one, disposable, in the caller’s window', () => {
    function host() {
        const opened: Array<Record<string, unknown>> = [];
        const windows: Array<[string, string, CallContext | undefined]> = [];
        const closed: string[] = [];
        const scratch = new ScratchTerminals({
            terminals: { open: (o) => { opened.push(o as unknown as Record<string, unknown>); return { id: `pty_${opened.length}` }; }, close: (id) => { closed.push(id); return true; } },
            openWindow: (route, terminalId, context) => { windows.push([route, terminalId, context]); },
        });
        const ports = { scratch, home: '/home/example', workspace: (id: string) => (id === 'ws_a' ? { id: 'ws_a', path: '/work/a' } : null), envFor: (id: string) => ({ GENIE_MCP_URL: `mcp-for-${id}` }) };
        return { opened, windows, closed, scratch, ports };
    }

    it('a workspace’s: its folder and its environment, disposable, and the caller’s window opens it', () => {
        const h = host();
        expect(scratchTerminalFor(h.ports, 'ws_a', OWNER)).toEqual({ ok: true, terminalId: 'pty_1', route: 'genie://takeover/pty_1' });
        expect(h.opened).toEqual([{ workspaceId: 'ws_a', cwd: '/work/a', env: { GENIE_MCP_URL: 'mcp-for-ws_a' }, personal: true, limited: false, disposable: true }]);
        expect(h.windows).toEqual([['genie://takeover/pty_1', 'pty_1', OWNER]]);
    });

    it('null: Genie’s own, in the home folder', () => {
        const h = host();
        expect(scratchTerminalFor(h.ports, null, OWNER)).toMatchObject({ ok: true, terminalId: 'pty_1' });
        expect(h.opened).toEqual([{ workspaceId: OS_WORKSPACE, cwd: '/home/example', personal: true, limited: false, disposable: true }]);
    });

    it('a workspace this host does not have opens nothing', () => {
        const h = host();
        expect(scratchTerminalFor(h.ports, 'ws_gone', OWNER)).toEqual({ ok: false, reason: 'That workspace is not open in Genie.' });
        expect({ opened: h.opened, windows: h.windows }).toEqual({ opened: [], windows: [] });
    });

    it('its window closing ends it (windowClosed), once; a terminal it did not open is never closed', () => {
        const h = host();
        scratchTerminalFor(h.ports, 'ws_a', OWNER);
        h.scratch.windowClosed('pty_other');
        expect(h.closed).toEqual([]);
        h.scratch.windowClosed('pty_1');
        h.scratch.windowClosed('pty_1');
        expect(h.closed).toEqual(['pty_1']);
    });

    it('genie-host composes it over its terminal host, its shellEnv and the caller’s window; a companion window closing ends it too', () => {
        const g = code(src('src/main/genie-host.ts'));
        expect(g).toMatch(/new ScratchTerminals\(\{\s*terminals: terminalHost,\s*openWindow: \(route, terminalId, context\) => \{ openCallersTerminalWindow\(terminalWindowPorts, context, route, \{ startedHere: true, ended: \(\) => hostScratch\w*\.windowClosed\(terminalId\) \}\); \}/);
        expect(g).toMatch(/scratchTerminalFor\(\{ scratch: hostScratch\w*, home: userHome\(\), workspace: \(id\) => hostRegistry\.workspace\(id\) \?\? null, envFor: shellEnv \}/);
        expect(g).toMatch(/takeOverEnded: \(terminalId\) => \{[^}]*hostScratch\w*\.windowClosed\(terminalId\)/);
    });
});

describe('who may open one: the workspace’s guest its own; the home one only the owner; another machine gets a ticket', () => {
    async function connect(preAuth: { isOwner: boolean; workspaceId: string | null }) {
        const home = await mkdtemp(join(tmpdir(), 'genie-2c4-'));
        const devices = await DeviceStore.open(home, { now: Date.now, random: () => 'tok' });
        const s = fakeScratch();
        const inner = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null, scratchTerminals: s.scratchTerminals } as unknown as HostApiDeps);
        const api: HostApi = { invoke: (m: RemoteMethod, a: unknown[], ctx?: CallContext) => inner.invoke(m, a, ctx), onEvent: () => () => {}, workspaceOfAgent: () => 'ws_a' } as unknown as HostApi;
        let accept: (c: ReturnType<typeof inMemoryPair>['server']) => void = () => {};
        new RemoteHost({ api, hostName: 'alphar', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now, random: () => 0.482913 }), confirm: allowEveryPairing,
            transport: { onConnection: (l) => { accept = l; return () => {}; } } });
        const pair = inMemoryPair();
        const frames: WireMessage[] = [];
        pair.client.onMessage((m) => { const r = parseMessage(m); if (r.ok) frames.push(r.message); });
        accept({ ...pair.server, preAuth: { kind: 'relay', label: 'wren', readonly: false, ...preAuth } });
        pair.client.send(JSON.stringify({ kind: 'hello', auth: { kind: 'relay' }, label: 'wren' }));
        await settle();
        pair.client.send(JSON.stringify({ kind: 'call', id: 1, method: 'baton.take', args: [] }));
        let id = 1;
        const call = async (args: unknown[]) => { id += 1; pair.client.send(JSON.stringify({ kind: 'call', id, method: METHOD, args })); await settle(); return frames.find((m) => m.kind === 'result' && m.id === id); };
        const done = async () => { await devices.flushed(); await rm(home, { recursive: true, force: true }); };
        return { s, call, done };
    }

    it('a workspace guest opens its own workspace’s, never another’s nor the home one; its answer carries a ticket', async () => {
        const c = await connect({ isOwner: false, workspaceId: 'ws_a' });
        try {
            expect(await c.call(['ws_a'])).toMatchObject({ ok: true, value: { ok: true, terminalId: 'pty_9', ticket: expect.any(String) } });
            expect(await c.call(['ws_b'])).toMatchObject({ ok: false, reason: expect.stringMatching(/not the workspace this link shares/) });
            expect(await c.call([null])).toMatchObject({ ok: false });
            expect(c.s.asked.map(([w]) => w)).toEqual(['ws_a']);
        } finally { await c.done(); }
    });

    it('a guest of the whole host is refused the home one: it is the owner’s', async () => {
        const c = await connect({ isOwner: false, workspaceId: null });
        try {
            expect(await c.call([null])).toMatchObject({ ok: false, reason: expect.stringMatching(/owner/) });
            expect(c.s.asked).toEqual([]);
        } finally { await c.done(); }
    });

    it('CONTROL: the owner from another machine opens the home one, with a ticket', async () => {
        const c = await connect({ isOwner: true, workspaceId: null });
        try {
            expect(await c.call([null])).toMatchObject({ ok: true, value: { ok: true, ticket: expect.any(String) } });
            expect(c.s.asked.map(([w]) => w)).toEqual([null]);
        } finally { await c.done(); }
    });
});

describe('every window asks the host; main keeps no scratch terminal of its own', () => {
    it('the wire bridge and this machine’s window ask terminals.scratch; another machine’s opens its companion window', () => {
        expect(code(src('src/renderer/remote-bridge.ts'))).toMatch(/scratchTerminal: \(workspaceId\) => answer<[^>]+>\('terminals\.scratch', workspaceId\)/);
        expect(code(src('src/renderer/local-session.ts'))).toMatch(/scratchTerminal: \(workspaceId\) => requestBridge\(\(bridge\) => bridge\.scratchTerminal!\(workspaceId\)\)/);
        expect(code(src('src/renderer/bridge.ts'))).toMatch(/scratchTerminal: local\.scratchTerminal/);
        expect(code(src('src/renderer/App.tsx'))).toMatch(/resolvedBridge\.scratchTerminal!\(workspaceId\)\.then\(\(r\) => \{ if \(r\.ok\) openCompanion\(r, 'Terminal'\); return r; \}\)/);
    });

    it('the tray asks over main’s own protocol connection for Genie’s own (null)', () => {
        expect(code(src('src/main/main.ts'))).toMatch(/onScratchTerminal: \(\) => \{\s*void ownProtocol\.call\('terminals\.scratch', \[null\]\)/);
    });

    it('no channel, no ScratchTerminals, no window-close hook in main; no preload line; the row leaves both lists', () => {
        const main = code(src('src/main/main.ts'));
        for (const gone of ["'genie:scratch-terminal-open'", 'new ScratchTerminals(', 'scratchTerminals?.windowClosed', 'openScratchTerminal(']) expect(main, gone).not.toContain(gone);
        expect(code(src('src/main/preload.ts'))).not.toContain('genie:scratch-terminal-open');
        expect(IPC_INVENTORY.map(([c]) => c)).not.toContain('genie:scratch-terminal-open');
        expect(src('test/ipc-inventory.test.ts')).not.toMatch(/'genie:scratch-terminal-open': '2c'/);
    });
});
