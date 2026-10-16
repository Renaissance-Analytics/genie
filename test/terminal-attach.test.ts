import { describe, expect, it } from 'vitest';
import { REMOTE_METHODS, WORKSPACE_SCOPED_METHODS, capabilityOf } from '../src/core/remote-protocol.js';
import { TerminalHost, type PtyPort } from '../src/main/terminal-host.js';
import { reattachAll } from '../src/renderer/reattach.js';

/**
 * MULTI-ATTACH WITH SCROLLBACK REPLAY (§6.5). A second surface — a reloaded window, a Take Over
 * window reopened, a popped-out panel, a phone — JOINS a running terminal: it gets the scrollback
 * so far and the live bytes from then on. It does not open a new shell. The old re-attach called
 * `open` once per listed terminal, so every reload of the Workspace surface spawned one NEW shell
 * per existing one and showed the new shell's bytes under the old terminal's id. `attach` is the
 * join; `open` stays the spawn; the counts below tell them apart.
 */

function fakePty() {
    const scroll = new Map<string, string>();
    let n = 0;
    let onData: ((id: string, data: string) => void) | null = null;
    const port: PtyPort = {
        open: (o) => { n += 1; const id = `pty_${n}`; scroll.set(id, ''); return { id, pid: 100 + n, shell: o.command ?? '/bin/sh', scrollback: '' }; },
        write: (id) => scroll.has(id),
        resize: (id) => scroll.has(id),
        kill: (id) => scroll.delete(id),
        scrollback: (id) => scroll.get(id),
        onData: (l) => { onData = l; return () => { onData = null; }; },
        onExit: () => () => {},
    };
    return { port, emit: (id: string, data: string) => { scroll.set(id, (scroll.get(id) ?? '') + data); onData?.(id, data); } };
}

describe('TerminalHost.attach', () => {
    it('joins a running terminal with its scrollback so far and its workspace; unknown or closed is null; nothing is spawned', () => {
        const { port, emit } = fakePty();
        const host = new TerminalHost(port);
        const a = host.open({ workspaceId: 'tynn', cwd: '/w/tynn' });
        host.open({ workspaceId: 'fancy', cwd: '/w/fancy' });
        emit(a.id, 'npm test\r\n');
        emit(a.id, '12 passed\r\n');
        expect(host.attach(a.id)).toEqual({ id: a.id, pid: a.pid, shell: '/bin/sh', workspaceId: 'tynn', scrollback: 'npm test\r\n12 passed\r\n' });
        expect(host.attach('pty_9')).toBeNull();
        // Attaching twice is two readers of one terminal, not two terminals.
        host.attach(a.id);
        expect(host.list()).toHaveLength(2);
        host.close(a.id);
        expect(host.attach(a.id)).toBeNull();
    });
});

describe('reattachAll (renderer)', () => {
    const bridge = (ids: readonly string[]) => {
        let opens = 0;
        const attached: string[] = [];
        const terminals = {
            list: async (_ws: string) => ids.map((id, i) => ({ id, pid: 10 + i, shell: 'sh' })),
            attach: async (_ws: string | null, id: string) => { attached.push(id); return id === 'gone' ? null : { id, pid: 1, shell: 'sh', scrollback: `history of ${id}` }; },
            open: async () => { opens += 1; return { id: 'new', pid: 2, shell: 'sh', scrollback: '' }; },
        };
        return { terminals, counts: () => ({ opens, attached }) };
    };

    it('attaches to every listed terminal — COUNTED — and opens nothing; a terminal gone between list and attach is dropped', async () => {
        const two = bridge(['t1', 't2']);
        expect(await reattachAll(two.terminals, 'tynn')).toEqual([
            { id: 't1', pid: 1, shell: 'sh', scrollback: 'history of t1' },
            { id: 't2', pid: 1, shell: 'sh', scrollback: 'history of t2' },
        ]);
        expect(two.counts()).toEqual({ opens: 0, attached: ['t1', 't2'] });
        const gone = bridge(['t1', 'gone']);
        expect((await reattachAll(gone.terminals, 'tynn')).map((t) => t.id)).toEqual(['t1']);
        // The gauge reads zero where there is nothing: the count is not stuck.
        const none = bridge([]);
        expect(await reattachAll(none.terminals, 'tynn')).toEqual([]);
        expect(none.counts()).toEqual({ opens: 0, attached: [] });
    });
});

describe('the remote protocol', () => {
    it('carries terminals.attach as a workspace-scoped read', () => {
        expect(REMOTE_METHODS).toContain('terminals.attach');
        expect(capabilityOf('terminals.attach')).toBe('read');
        expect(WORKSPACE_SCOPED_METHODS).toContain('terminals.attach');
    });
});
