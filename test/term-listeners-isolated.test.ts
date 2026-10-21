import { describe, expect, it, vi } from 'vitest';
import { fancyTermPort, type HostBackend } from '../src/main/fancy-term-port.js';
import { TerminalHost, type PtyPort } from '../src/main/terminal-host.js';

/**
 * ONE LISTENER THAT THROWS NEVER COSTS A TERMINAL ITS EXIT (beta.35; the beta.34 Windows release check: "cycle 74: the
 * pty never reported its exit" and one live terminal counted afterwards). fancy (2026-10-21) found the path in
 * fancy-term-host 0.10.0 and 0.11.0: a listener that throws during a pty's final flush stops the exit from being
 * delivered. Genie fanned data and exit out to its own listeners in a plain loop — a listener that throws (a push to a
 * window that has just closed) escaped into the engine's flush. Every listener now runs on its own: its error is
 * reported, the others still hear, and the throw never reaches the engine.
 */

function backend() {
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = { data: [], exit: [], cwd: [] };
    const b: HostBackend = {
        create: (opts) => ({ id: opts.id, pid: 5001, shell: opts.shell ?? '/bin/sh', existing: false, scrollback: '' }),
        write: () => true, resize: () => true, kill: () => true, getScrollback: () => '',
        on: ((event: string, l: (...a: unknown[]) => void) => { listeners[event]?.push(l); return b; }) as HostBackend['on'],
    };
    return {
        b,
        data: (id: string, d: string) => listeners['data']!.forEach((l) => l(id, d)),
        exit: (id: string, code: number) => listeners['exit']!.forEach((l) => l(id, { exitCode: code })),
    };
}

describe('the engine adapter (fancy-term-port)', () => {
    it('a data listener that throws: the engine’s call does not throw, and the next listener still hears (COUNTED)', () => {
        const report = vi.spyOn(console, 'error').mockImplementation(() => {});
        const e = backend();
        const port = fancyTermPort(e.b, { defaultShell: () => ({ command: 'sh', args: [] }) });
        const heard: string[] = [];
        port.onData(() => { throw new Error('window closed'); });
        port.onData((id, d) => heard.push(`${id}:${d}`));
        expect(() => e.data('t1', 'hello')).not.toThrow();
        expect(heard).toEqual(['t1:hello']);
        expect(report).toHaveBeenCalledTimes(1);
        report.mockRestore();
    });

    it('an exit listener that throws: the exit still reaches every other listener', () => {
        const report = vi.spyOn(console, 'error').mockImplementation(() => {});
        const e = backend();
        const port = fancyTermPort(e.b, { defaultShell: () => ({ command: 'sh', args: [] }) });
        const exits: string[] = [];
        port.onExit(() => { throw new Error('boom'); });
        port.onExit((id, code) => exits.push(`${id}:${code}`));
        expect(() => e.exit('t1', 0)).not.toThrow();
        expect(exits).toEqual(['t1:0']);
        report.mockRestore();
    });
});

function pty() {
    let data: ((id: string, d: string) => void) | null = null;
    let exit: ((id: string, c: number) => void) | null = null;
    const port: PtyPort = {
        open: () => ({ id: 'pty_1', pid: 1001, shell: '/bin/sh', scrollback: '' }),
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
        onData: (l) => { data = l; return () => { data = null; }; },
        onExit: (l) => { exit = l; return () => { exit = null; }; },
    };
    return { port, data: (id: string, d: string) => data?.(id, d), exit: (id: string, c: number) => exit?.(id, c) };
}

describe('the terminal host', () => {
    it('a data listener that throws: the host’s handler does not throw, the next listener hears, and the EXIT still lands — the terminal leaves the list', () => {
        const report = vi.spyOn(console, 'error').mockImplementation(() => {});
        const p = pty();
        const host = new TerminalHost(p.port);
        host.open({ workspaceId: 'tynn', cwd: '/w' });
        const heard: string[] = [];
        const exits: string[] = [];
        host.onData(() => { throw new Error('window closed'); });
        host.onData((id, d) => heard.push(`${id}:${d}`));
        host.onExit(() => { throw new Error('boom'); });
        host.onExit((id, c) => exits.push(`${id}:${c}`));
        expect(() => p.data('pty_1', 'out')).not.toThrow();
        expect(heard).toEqual(['pty_1:out']);
        expect(host.count).toBe(1);
        expect(() => p.exit('pty_1', 0)).not.toThrow();
        expect(exits).toEqual(['pty_1:0']);
        expect(host.count).toBe(0);
        report.mockRestore();
    });
});
