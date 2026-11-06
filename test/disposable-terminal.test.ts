import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import * as scratchModule from '../src/main/scratch-terminal.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import { SpawnHostClient } from '../src/main/spawn-host-client.js';
import type { ListedPty, SpawnFrame } from '../src/main/spawn-host-protocol.js';
import { startSpawnRelay, type RelayChild } from '../src/main/spawn-relay.js';
import { TerminalHost, type PtyOpened, type PtyPort, type PtySpawnOptions, type TerminalOptions } from '../src/main/terminal-host.js';
import { TerminalsService } from '../src/main/terminals-host.js';

/**
 * A THROWAWAY TERMINAL (Tynn story #378). The owner: "we need an ability to open a window with a throw away terminal
 * without needing to create a tab … closing the window deletes the terminal and removes all trace of it's existance from
 * memory and file. (meaning this is fully disposable and we don't need to build in any recover mechanisms for this
 * terminal ux)".
 *
 * `disposable: true` is said when the terminal is OPENED, and the host enforces it — not a renderer convention:
 *  - it is not listed (no tab, no panel row, not in the workspace's terminals, not in what a new window is handed);
 *  - it ends with its window: closed by the window, or by the window's connection to genie-host going away;
 *  - once closed or ended nothing of it is kept: no ended-terminal record, no output, no cwd;
 *  - its pty is tagged disposable, and a terminal tagged so is never adopted;
 *  - the crash-cleanup ledger (runtime/ptys.json) holds it only while it lives.
 * Every absence below has a positive control: a NORMAL terminal in the same rig IS listed, kept and adopted.
 */

const TOKEN = 'disposable-token';
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const tick = async (n = 8) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };
// Typed loosely ON PURPOSE: before the flag exists, the test is red by its assertions, not by a type error.
const disposable = (o: TerminalOptions): TerminalOptions => ({ ...o, disposable: true } as TerminalOptions);

function fakePty() {
    const opened: Array<PtySpawnOptions & { id: string }> = [];
    const killed: string[] = [];
    const data = new Set<(id: string, d: string) => void>();
    const exit = new Set<(id: string, code: number) => void>();
    const cwd = new Set<(id: string, cwd: string) => void>();
    const live = new Set<string>();
    let n = 0;
    const port: PtyPort = {
        open(o) { n += 1; const id = o.id ?? `term_${n}`; opened.push({ ...o, id }); live.add(id); return { id, pid: 4000 + n, shell: o.command ?? 'bash', scrollback: '' } satisfies PtyOpened; },
        write: (id) => live.has(id),
        resize: () => true,
        kill: (id) => { if (!live.delete(id)) return false; killed.push(id); for (const l of exit) l(id, 0); return true; },
        scrollback: () => undefined,
        onData: (l) => { data.add(l); return () => data.delete(l); },
        onExit: (l) => { exit.add(l); return () => exit.delete(l); },
        onCwd: (l) => { cwd.add(l); return () => cwd.delete(l); },
    };
    return {
        port, opened, killed, live,
        print: (id: string, d: string) => { for (const l of data) l(id, d); },
        ends: (id: string, code: number) => { live.delete(id); for (const l of exit) l(id, code); },
        cd: (id: string, dir: string) => { for (const l of cwd) l(id, dir); },
    };
}

describe('the terminal host keeps no trace of a disposable terminal', () => {
    it('it is tagged disposable at the pty; a normal one is not (control)', () => {
        const pty = fakePty();
        const host = new TerminalHost(pty.port);
        host.open({ workspaceId: 'ws', cwd: '/w' });
        host.open(disposable({ workspaceId: 'ws', cwd: '/w' }));
        expect(pty.opened[0]!.tag).toEqual({ kind: 'terminal', workspaceId: 'ws', shell: '' });
        expect(pty.opened[1]!.tag).toEqual({ kind: 'terminal', workspaceId: 'ws', shell: '', disposable: true });
    });

    it('it is not listed or counted, and its shell’s folder is never the workspace’s last one; a normal one is (control)', () => {
        const pty = fakePty();
        const host = new TerminalHost(pty.port);
        const normal = host.open({ workspaceId: 'ws', cwd: '/w' });
        const scratch = host.open(disposable({ workspaceId: 'ws', cwd: '/w' }));
        expect(host.list().map((t) => t.id)).toEqual([normal.id]);
        expect(host.count).toBe(1);
        pty.cd(normal.id, '/w/normal');
        pty.cd(scratch.id, '/w/scratch');
        expect(host.lastCwd('ws')).toBe('/w/normal');
        // It is live all the same: the window that opened it types into it.
        expect(host.write(scratch.id, 'ls\r')).toBe(true);
    });

    it('closed: its pty is ended and nothing of it is left — no output, no ended record (control: a normal one’s record is kept)', () => {
        const pty = fakePty();
        const host = new TerminalHost(pty.port);
        const normal = host.open({ workspaceId: 'ws', cwd: '/w' });
        const scratch = host.open(disposable({ workspaceId: 'ws', cwd: '/w' }));
        pty.print(normal.id, 'normal output\r\n');
        pty.print(scratch.id, 'a pasted token\r\n');
        expect(host.close(scratch.id)).toBe(true);
        expect(pty.killed).toEqual([scratch.id]);
        expect(host.scrollback(scratch.id)).toBeUndefined();
        expect(host.finished(scratch.id)).toBeNull();
        expect(host.attach(scratch.id)).toBeNull();
        // Control: a normal terminal that ends keeps what it printed and how it ended, for reading after.
        pty.ends(normal.id, 3);
        expect(host.finished(normal.id)).toEqual({ workspaceId: 'ws', exitCode: 3 });
        expect(host.scrollback(normal.id)).toContain('normal output');
    });

    it('ended on its own (`exit`): the same — nothing kept', () => {
        const pty = fakePty();
        const host = new TerminalHost(pty.port);
        const scratch = host.open(disposable({ workspaceId: 'ws', cwd: '/w' }));
        pty.print(scratch.id, 'secret\r\n');
        pty.ends(scratch.id, 0);
        expect(host.finished(scratch.id)).toBeNull();
        expect(host.scrollback(scratch.id)).toBeUndefined();
        expect(host.write(scratch.id, 'x')).toBe(false);
    });

    it('a pty tagged disposable is never adopted; a normal terminal’s is (control)', () => {
        const pty = fakePty();
        const host = new TerminalHost(pty.port);
        const listed = (id: string, extra: Record<string, unknown> = {}): ListedPty => ({ id, pid: 5151, tag: { kind: 'terminal', workspaceId: 'ws', shell: 'bash', ...extra } as ListedPty['tag'], scrollback: 'hello\r\n' });
        host.adopt(listed('term_normal'));
        host.adopt(listed('term_scratch', { disposable: true }));
        expect(host.list().map((t) => t.id)).toEqual(['term_normal']);
        expect(host.attach('term_scratch')).toBeNull();
        expect(host.scrollback('term_scratch')).toBeUndefined();
    });
});

function rig() {
    const pty = fakePty();
    const terminals = new TerminalHost(pty.port);
    const service = new TerminalsService(terminals);
    const server = new SessionEngineServer({ token: TOKEN, build: 't', terminals: service });
    server.attach(new SessionHost({ userData: mkdtempSync(join(tmpdir(), 'disposable-term-')), driverFor: () => null, processTree: noProcessTree, ...server.hostOptions() }));
    const window = async () => {
        const [h, w] = memoryPair();
        server.accept(h);
        const client = new SessionEngineClient();
        expect(await client.connect(w, TOKEN)).toMatchObject({ ok: true });
        return { terminals: client.terminals(), close: () => w.close() };
    };
    return { pty, terminals, window };
}

describe('genie-host: a disposable terminal belongs to the window connection that opened it', () => {
    it('the window that opened it joins it with what it printed; it is not in that window’s list', async () => {
        const r = rig();
        const w = await r.window();
        const t = w.terminals.open(disposable({ workspaceId: 'ws', cwd: '/w' }));
        await tick();
        r.pty.print(t.id, 'prompt$ ');
        await tick();
        expect(w.terminals.attach(t.id)?.scrollback).toBe('prompt$ ');
        expect(w.terminals.list().map((x) => x.id)).toEqual([]);
        expect(w.terminals.write(t.id, 'ls\r')).toBe(true);
    });

    it('a NEW window is never handed it — not listed, not joinable; a normal terminal is both (control)', async () => {
        const r = rig();
        const first = await r.window();
        const normal = first.terminals.open({ workspaceId: 'ws', cwd: '/w' });
        const scratch = first.terminals.open(disposable({ workspaceId: 'ws', cwd: '/w' }));
        await tick();
        r.pty.print(normal.id, 'built\r\n');
        r.pty.print(scratch.id, 'secret\r\n');
        await tick();
        const next = await r.window();
        expect(next.terminals.list().map((x) => x.id)).toEqual([normal.id]);
        expect(next.terminals.attach(normal.id)?.scrollback).toContain('built');
        expect(next.terminals.attach(scratch.id)).toBeNull();
        expect(next.terminals.scrollback(scratch.id)).toBeUndefined();
    });

    it('closing the window’s connection ends its disposable terminal’s pty — and only that one (control: a normal terminal lives on)', async () => {
        const r = rig();
        const w = await r.window();
        const normal = w.terminals.open({ workspaceId: 'ws', cwd: '/w' });
        const scratch = w.terminals.open(disposable({ workspaceId: 'ws', cwd: '/w' }));
        await tick();
        expect(r.pty.live.has(scratch.id)).toBe(true); // positive control: it was running
        w.close();
        await tick();
        expect(r.pty.killed).toEqual([scratch.id]);
        expect(r.pty.live.has(normal.id)).toBe(true);
        expect(r.terminals.list().map((t) => t.id)).toEqual([normal.id]);
        expect(r.terminals.finished(scratch.id)).toBeNull();
    });

    it('another window’s connection closing does not end it (control: the owner is the window that opened it)', async () => {
        const r = rig();
        const owner = await r.window();
        const other = await r.window();
        const scratch = owner.terminals.open(disposable({ workspaceId: 'ws', cwd: '/w' }));
        await tick();
        other.close();
        await tick();
        expect(r.pty.live.has(scratch.id)).toBe(true);
    });

    it('closed by its window: gone from the host and from the window’s memory', async () => {
        const r = rig();
        const w = await r.window();
        const scratch = w.terminals.open(disposable({ workspaceId: 'ws', cwd: '/w' }));
        await tick();
        r.pty.print(scratch.id, 'secret\r\n');
        await tick();
        expect(w.terminals.close(scratch.id)).toBe(true);
        await tick();
        expect(r.pty.killed).toEqual([scratch.id]);
        expect(w.terminals.attach(scratch.id)).toBeNull();
        expect(w.terminals.scrollback(scratch.id)).toBeUndefined();
        expect(w.terminals.write(scratch.id, 'x')).toBe(false);
    });
});

/** A `terminals` spawn host that answers like the real one: pty.list, pty.open → pty.opened, pty.kill → pty.exit. */
class FakeTerminalsChild extends EventEmitter implements RelayChild {
    pid: number;
    connected = true;
    #next = 7000;
    constructor(pid: number, readonly env: Record<string, string>) { super(); this.pid = pid; }
    send(frame: SpawnFrame): boolean {
        if (frame.kind !== 'call') return true;
        const say = (f: SpawnFrame) => queueMicrotask(() => this.emit('message', f));
        if (frame.method === 'pty.list') say({ kind: 'result', id: frame.id, ok: true, value: [] });
        if (frame.method === 'pty.open') say({ kind: 'event', channel: 'pty.opened', payload: { id: frame.args[0], pid: this.#next++ } });
        if (frame.method === 'pty.kill') say({ kind: 'event', channel: 'pty.exit', payload: { id: frame.args[0], code: 0 } });
        return true;
    }
    kill(): boolean { return true; }
}

describe('the crash-cleanup ledger (runtime/ptys.json) holds a disposable terminal only while it lives', () => {
    it('opened: in the ledger (a crashed host’s orphan is swept); closed: gone from it; a normal one stays (control)', async () => {
        const ledger: Array<Array<{ id: string }>> = [];
        let client: SpawnHostClient | null = null;
        let next = 300;
        const relay = startSpawnRelay({
            entry: 'spawn-host.js',
            fork: (_entry, env) => new FakeTerminalsChild(next++, env),
            send: (profile, frame) => { if (profile === 'terminals') client?.linkFrame(frame); },
            killPid: () => {},
            pidAlive: () => false,
            schedule: () => () => {},
            log: () => {},
            onPtys: (ptys) => { ledger.push(ptys.map((p) => ({ id: p.id }))); },
        });
        client = new SpawnHostClient({ entry: '', link: { send: (frame) => relay.send('terminals', frame) }, log: () => {} });
        await client.linkUp();
        const host = new TerminalHost(client.ptyPort());
        const normal = host.open({ workspaceId: 'ws', cwd: '/w' });
        const scratch = host.open(disposable({ workspaceId: 'ws', cwd: '/w' }));
        await tick();
        expect(ledger.at(-1)?.map((p) => p.id).sort()).toEqual([normal.id, scratch.id].sort());
        host.close(scratch.id);
        await tick();
        expect(ledger.at(-1)?.map((p) => p.id)).toEqual([normal.id]);
    });
});

describe('the window side (main): the Terminal button’s window', () => {
    const mod = scratchModule as unknown as Record<string, unknown>;

    it('opens a disposable shell in the workspace’s folder with the workspace’s environment, in a window of its own; each click a new one', () => {
        const Scratch = mod['ScratchTerminals'] as (new (o: unknown) => { open(w: unknown): unknown; windowClosed(id: string): void }) | undefined;
        expect(Scratch, 'ScratchTerminals in main/scratch-terminal.ts').toBeTypeOf('function');
        const opened: TerminalOptions[] = [];
        const windows: string[] = [];
        let n = 0;
        const scratch = new Scratch!({
            terminals: { open: (o: TerminalOptions) => { opened.push(o); n += 1; return { id: `term_s${n}`, pid: 0, shell: '', scrollback: '' }; }, close: () => true },
            openWindow: (route: string) => windows.push(route),
        });
        const env = { DB_HOST: '127.0.0.1' };
        expect(scratch.open({ workspaceId: 'ws', cwd: '/w/tynn', env })).toEqual({ ok: true, terminalId: 'term_s1' });
        expect(scratch.open({ workspaceId: 'ws', cwd: '/w/tynn', env })).toEqual({ ok: true, terminalId: 'term_s2' });
        expect(opened).toEqual([
            { workspaceId: 'ws', cwd: '/w/tynn', env, personal: true, limited: false, disposable: true },
            { workspaceId: 'ws', cwd: '/w/tynn', env, personal: true, limited: false, disposable: true },
        ]);
        expect(windows).toEqual(['genie://takeover/term_s1', 'genie://takeover/term_s2']);
    });

    it('closing its window closes it — only its own (control: another window’s terminal is not touched)', () => {
        const Scratch = mod['ScratchTerminals'] as (new (o: unknown) => { open(w: unknown): unknown; windowClosed(id: string): void }) | undefined;
        expect(Scratch).toBeTypeOf('function');
        const closed: string[] = [];
        const scratch = new Scratch!({
            terminals: { open: () => ({ id: 'term_s1', pid: 0, shell: '', scrollback: '' }), close: (id: string) => { closed.push(id); return true; } },
            openWindow: () => {},
        });
        scratch.open({ workspaceId: 'ws', cwd: '/w' });
        scratch.windowClosed('term_someone_else');
        expect(closed).toEqual([]);
        scratch.windowClosed('term_s1');
        scratch.windowClosed('term_s1');
        expect(closed).toEqual(['term_s1']);
    });

    it('one that cannot start says why and opens no window', () => {
        const Scratch = mod['ScratchTerminals'] as (new (o: unknown) => { open(w: unknown): unknown }) | undefined;
        expect(Scratch).toBeTypeOf('function');
        const windows: string[] = [];
        const scratch = new Scratch!({ terminals: { open: () => { throw new Error('no shell'); }, close: () => true }, openWindow: (r: string) => windows.push(r) });
        expect(scratch.open({ workspaceId: 'ws', cwd: '/w' })).toEqual({ ok: false, reason: 'The terminal could not start: no shell' });
        expect(windows).toEqual([]);
    });
});
