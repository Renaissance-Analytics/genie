import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import { TerminalHost, type PtyOpened, type PtyPort } from '../src/main/terminal-host.js';
import { TerminalsService } from '../src/main/terminals-host.js';

/**
 * THE TERMINALS ARE GENIE-HOST'S (the host split, P3.3e: plan §11e). Their shells run under the host, so a terminal — and
 * what it has printed — outlives the window, and an agent's `manageTerminals` works with no window. A window opens,
 * types into, resizes and closes them through a replica, gets an id the moment it asks (so a pane opens at once), and
 * shows their output as it streams.
 */

const TOKEN = 'terminals-token';
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const tick = async (n = 8) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

function fakePty() {
    const written: Array<[string, string]> = [];
    const data = new Set<(id: string, d: string) => void>();
    const exit = new Set<(id: string, code: number) => void>();
    const pid = new Set<(id: string, pid: number, shell?: string) => void>();
    const live = new Set<string>();
    let n = 0;
    const port: PtyPort = {
        open(options) { n += 1; const id = options.id ?? `term_${n}`; live.add(id); queueMicrotask(() => { for (const l of pid) l(id, 5000 + n, '/bin/bash'); }); return { id, pid: 0, shell: options.command ?? '', scrollback: '' } satisfies PtyOpened; },
        write: (id, d) => { written.push([id, d]); return live.has(id); },
        resize: () => true,
        kill: (id) => { if (!live.delete(id)) return false; for (const l of exit) l(id, 0); return true; },
        scrollback: () => undefined,
        onData: (l) => { data.add(l); return () => data.delete(l); },
        onExit: (l) => { exit.add(l); return () => exit.delete(l); },
        onPid: (l) => { pid.add(l); return () => pid.delete(l); },
    };
    return { port, written, print: (id: string, d: string) => { for (const l of data) l(id, d); } };
}

function rig(limit = 5) {
    const pty = fakePty();
    const terminals = new TerminalHost(pty.port, { terminals: () => limit });
    const service = new TerminalsService(terminals);
    const server = new SessionEngineServer({ token: TOKEN, build: 't', terminals: service });
    server.attach(new SessionHost({ userData: mkdtempSync(join(tmpdir(), 'terminals-host-')), driverFor: () => null, processTree: noProcessTree, ...server.hostOptions() }));
    const window = async () => {
        const [h, w] = memoryPair();
        server.accept(h);
        const client = new SessionEngineClient();
        expect(await client.connect(w, TOKEN)).toMatchObject({ ok: true });
        return { terminals: client.terminals(), close: () => w.close() };
    };
    return { pty, terminals, window };
}

describe('the terminals in genie-host, driven from a window', () => {
    it('a window opens a terminal: its id is there at once; it runs in the host, with its real pid and shell; typing reaches it; its output streams back', async () => {
        const r = rig();
        const w = await r.window();
        const opened = w.terminals.open({ workspaceId: 'ws', cwd: '/w' });
        expect(opened.id).toMatch(/^term_/); // at once: the pane opens without waiting for the host
        const ready = await w.terminals.openReady({ workspaceId: 'ws', cwd: '/w' });
        await tick();
        expect(ready).toMatchObject({ pid: expect.any(Number), shell: '/bin/bash' });
        expect(r.terminals.list().map((t) => t.id).sort()).toEqual([opened.id, ready.id].sort());
        const heard: string[] = [];
        w.terminals.onData((id, d) => { if (id === opened.id) heard.push(d); });
        r.pty.print(opened.id, 'hello\r\n');
        await tick();
        expect(heard).toEqual(['hello\r\n']);
        expect(w.terminals.write(opened.id, 'ls\r')).toBe(true);
        await tick();
        expect(r.pty.written).toContainEqual([opened.id, 'ls\r']);
    });

    it('a terminal OUTLIVES its window: the next window lists it and joins it with what it printed', async () => {
        const r = rig();
        const first = await r.window();
        const t = first.terminals.open({ workspaceId: 'ws', cwd: '/w' });
        await tick();
        r.pty.print(t.id, 'built in 3s\r\n');
        first.close();
        await tick();
        const next = await r.window();
        expect(next.terminals.list().map((x) => x.id)).toEqual([t.id]);
        expect(next.terminals.attach(t.id)?.scrollback).toContain('built in 3s');
    });

    it('close from a window ends it in the host; the limit refuses the next one by name, in the window, before anything opens', async () => {
        const r = rig(1);
        const w = await r.window();
        const t = w.terminals.open({ workspaceId: 'ws', cwd: '/w' });
        await tick();
        expect(() => w.terminals.open({ workspaceId: 'ws', cwd: '/w' })).toThrow(/limit|terminals/i);
        expect(w.terminals.close(t.id)).toBe(true);
        await tick();
        expect(r.terminals.list()).toEqual([]);
        expect(w.terminals.list()).toEqual([]);
    });
});
