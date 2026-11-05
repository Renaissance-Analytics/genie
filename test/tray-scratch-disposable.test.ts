import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OS_WORKSPACE } from '../src/main/registry.js';
import { ScratchTerminals, openScratchTerminal } from '../src/main/scratch-terminal.js';
import { TerminalHost, type PtyOpened, type PtyPort, type PtySpawnOptions } from '../src/main/terminal-host.js';

/**
 * THE TRAY'S "NEW SCRATCH TERMINAL" ENDS WITH ITS WINDOW (genie#1596). It opened an ordinary terminal and a Take Over
 * window on it, and that window's close handler only closes an agent's Take Over — so closing the tray's window left the
 * shell running, listed under Genie's own workspace, with nothing showing it. It now takes the header Terminal button's
 * path (#1592): a DISPOSABLE terminal (not listed, never adopted, nothing kept), closed when its window closes.
 */

function fakePty() {
    const opened: Array<PtySpawnOptions & { id: string }> = [];
    const killed: string[] = [];
    const exit = new Set<(id: string, code: number) => void>();
    let n = 0;
    const port: PtyPort = {
        open(o) { n += 1; const id = o.id ?? `term_${n}`; opened.push({ ...o, id }); return { id, pid: 6000 + n, shell: 'bash', scrollback: '' } satisfies PtyOpened; },
        write: () => true,
        resize: () => true,
        kill: (id) => { killed.push(id); for (const l of exit) l(id, 0); return true; },
        scrollback: () => undefined,
        onData: () => () => {},
        onExit: (l) => { exit.add(l); return () => exit.delete(l); },
    };
    return { port, opened, killed };
}

// Called through a loose type ON PURPOSE: on the old signature the test is red by its assertions, not a type error.
const openTray = openScratchTerminal as unknown as (o: Record<string, unknown>) => { ok: boolean; terminalId?: string; reason?: string };

describe('the tray’s scratch terminal is disposable and ends with its window', () => {
    it('closing its window ends its pty; it is never listed; its pty is tagged disposable (COUNTED)', () => {
        const pty = fakePty();
        const host = new TerminalHost(pty.port);
        const windows: string[] = [];
        const scratch = new ScratchTerminals({ terminals: host, openWindow: (route) => windows.push(route) });
        const r = openTray({ scratch, home: '/home/example' });
        expect(r.ok, r.reason).toBe(true);
        const id = r.terminalId!;
        expect(windows).toEqual([`genie://takeover/${id}`]);
        expect(pty.opened).toHaveLength(1);
        expect(pty.opened[0]).toMatchObject({ cwd: '/home/example', tag: { kind: 'terminal', workspaceId: OS_WORKSPACE, disposable: true } });
        expect(host.list()).toEqual([]);
        expect(pty.killed).toEqual([]); // positive control: alive until its window closes
        scratch.windowClosed(id);
        expect(pty.killed).toEqual([id]);
        expect(host.finished(id)).toBeNull();
    });

    it('main’s tray handler opens it through the same ScratchTerminals that every Take Over window’s close reaches', () => {
        // Comment lines dropped by LINE, CRLF-safe: a guard that matched a comment would pass on prose.
        const main = readFileSync('src/main/main.ts', 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        expect(main).toMatch(/openScratchTerminal\(\{ scratch: scratchTerminals, home: homedir\(\) \}\)/);
        expect(main).toMatch(/win\.on\('closed', \(\) => \{[^}]*scratchTerminals\?\.windowClosed\(terminalId\)/);
    });
});
