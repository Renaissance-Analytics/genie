import { describe, expect, it } from 'vitest';
import type { ListedPty } from '../src/main/spawn-host-protocol.js';
import { TerminalHost, type PtyOpened, type PtyPort, type PtySpawnOptions } from '../src/main/terminal-host.js';

/**
 * A NEW WINDOW TAKES BACK ITS OPEN TERMINALS (the host split, P2.1: plan §11a). Under genie-host an interactive shell —
 * a build running in it, an agent's Take Over — keeps running while the window restarts. The new window's terminal host
 * adopts each live one with what it printed, so the panel reopens on it rather than on nothing.
 */

function fakePty() {
    const opened: Array<PtySpawnOptions & { id: string }> = [];
    const data = new Set<(id: string, d: string) => void>();
    const exit = new Set<(id: string, code: number) => void>();
    let n = 0;
    const port: PtyPort = {
        open(o) { const id = `t${++n}`; opened.push({ ...o, id }); return { id, pid: 3000 + n, shell: o.command ?? 'bash', scrollback: '' } satisfies PtyOpened; },
        write: () => true,
        resize: () => true,
        kill: () => true,
        scrollback: () => undefined,
        onData: (l) => { data.add(l); return () => data.delete(l); },
        onExit: (l) => { exit.add(l); return () => exit.delete(l); },
    };
    return { port, opened, output: (id: string, d: string) => { for (const l of data) l(id, d); }, exits: (id: string, c: number) => { for (const l of exit) l(id, c); } };
}

const terminal = (id: string, over: Partial<ListedPty> = {}): ListedPty => ({ id, pid: 5151, tag: { kind: 'terminal', workspaceId: 'ws', shell: 'bash' }, scrollback: '$ npm run build\r\n> vite build\r\n', ...over });

describe('adopting open terminals after a window restart', () => {
    it('an opened terminal carries its tag (what the next window adopts it by)', () => {
        const pty = fakePty();
        const host = new TerminalHost(pty.port);
        host.open({ workspaceId: 'ws', cwd: '/w', command: 'npm test' });
        expect(pty.opened[0]!.tag).toEqual({ kind: 'terminal', workspaceId: 'ws', shell: 'npm test' });
    });

    it('an adopted terminal is listed, its earlier output is what attach replays, and new output follows', () => {
        const pty = fakePty();
        const host = new TerminalHost(pty.port);
        host.adopt(terminal('term_b'));
        expect(host.list()).toEqual([{ id: 'term_b', workspaceId: 'ws', pid: 5151, shell: 'bash' }]);
        pty.output('term_b', 'built in 3.2s\r\n');
        expect(host.attach('term_b')).toEqual({ id: 'term_b', pid: 5151, shell: 'bash', workspaceId: 'ws', scrollback: '$ npm run build\r\n> vite build\r\nbuilt in 3.2s\r\n' });
    });

    it('it ends like any terminal (gone from the list, its output readable as finished); a process pty is not a terminal', () => {
        const pty = fakePty();
        const host = new TerminalHost(pty.port);
        host.adopt(terminal('term_b'));
        host.adopt({ id: 'term_site', pid: 1, tag: { kind: 'process', processId: 'site:shop', workspaceId: 'ws' }, scrollback: '' });
        expect(host.list().map((t) => t.id)).toEqual(['term_b']);
        pty.exits('term_b', 0);
        expect(host.list()).toEqual([]);
        expect(host.finished('term_b')).toEqual({ workspaceId: 'ws', exitCode: 0 });
    });
});
