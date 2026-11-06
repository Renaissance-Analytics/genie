import { describe, expect, it } from 'vitest';
import type { SpawnChannel, SpawnFrame } from '../src/main/spawn-host-protocol.js';
import { serveSpawnHost } from '../src/main/spawn-host-server.js';
import type { PtyOpened, PtyPort, PtySpawnOptions } from '../src/main/terminal-host.js';

/**
 * THE SPAWN HOST REMEMBERS WHAT IT RUNS, FOR THE NEXT WINDOW (the host split, P2.1: plan §11a).
 *
 * Under genie-host the spawn host outlives the window. A new window must find what is still running — a site's server,
 * a queue worker, an open terminal — and take it back rather than start it twice (a second site on the same port).
 * So the server keeps, per pty: the window's id, its pid, the TAG the window gave at open (what it is to the window),
 * and its scrollback; and answers `pty.list` with the live ones.
 */

/** A pty engine that does nothing but remember, and lets the test write output and end processes. */
function fakePty() {
    const data = new Set<(id: string, d: string) => void>();
    const exit = new Set<(id: string, code: number) => void>();
    const scroll = new Map<string, string>();
    let n = 0;
    const port: PtyPort = {
        open: (o: PtySpawnOptions): PtyOpened => { const id = `e${++n}`; scroll.set(id, ''); return { id, pid: 1000 + n, shell: o.command ?? 'sh', scrollback: '' }; },
        write: () => true,
        resize: () => true,
        kill: (id) => { scroll.delete(id); return true; },
        scrollback: (id) => scroll.get(id),
        onData: (l) => { data.add(l); return () => data.delete(l); },
        onExit: (l) => { exit.add(l); return () => exit.delete(l); },
    };
    return {
        port,
        out: (engineId: string, d: string) => { scroll.set(engineId, (scroll.get(engineId) ?? '') + d); for (const l of data) l(engineId, d); },
        end: (engineId: string, code: number) => { for (const l of exit) l(engineId, code); scroll.delete(engineId); },
    };
}

/** The window's end and the spawn host's end of one channel, in memory, in order. */
function channelPair(): { host: SpawnChannel; window: { send(f: SpawnFrame): void; frames: SpawnFrame[] } } {
    const toHost = new Set<(f: SpawnFrame) => void>();
    const frames: SpawnFrame[] = [];
    const host: SpawnChannel = {
        send: (f) => { frames.push(JSON.parse(JSON.stringify(f)) as SpawnFrame); },
        onFrame: (l) => { toHost.add(l); },
        onClose: () => {},
    };
    return { host, window: { send: (f) => { for (const l of toHost) l(JSON.parse(JSON.stringify(f)) as SpawnFrame); }, frames } };
}

const resultOf = (frames: SpawnFrame[], id: number) => frames.find((f) => f.kind === 'result' && f.id === id) as Extract<SpawnFrame, { kind: 'result' }> | undefined;

describe('pty.list: what is still running, for the next window', () => {
    it('lists each live pty with the window\'s id, its pid, the tag it was opened with, and its scrollback', () => {
        const pty = fakePty();
        const { host, window } = channelPair();
        serveSpawnHost(host, { exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) as never, stream: (() => ({ stop() {} })) as never, pty: pty.port });
        window.send({ kind: 'call', id: 0, method: 'pty.open', args: ['term_a', { cwd: '/w', command: 'php artisan serve' }, { kind: 'process', processId: 'site:shop', workspaceId: 'ws1' }] });
        window.send({ kind: 'call', id: 0, method: 'pty.open', args: ['term_b', { cwd: '/w' }, { kind: 'terminal', workspaceId: 'ws1', shell: 'bash' }] });
        pty.out('e1', 'Server running on http://127.0.0.1:4102\r\n');
        window.send({ kind: 'call', id: 7, method: 'pty.list', args: [] });
        const listed = resultOf(window.frames, 7);
        expect(listed?.ok).toBe(true);
        expect((listed as { value: unknown }).value).toEqual([
            { id: 'term_a', pid: 1001, tag: { kind: 'process', processId: 'site:shop', workspaceId: 'ws1' }, shell: 'php artisan serve', scrollback: 'Server running on http://127.0.0.1:4102\r\n', epoch: expect.any(String), endOffset: 'Server running on http://127.0.0.1:4102\r\n'.length },
            { id: 'term_b', pid: 1002, tag: { kind: 'terminal', workspaceId: 'ws1', shell: 'bash' }, shell: 'sh', scrollback: '', epoch: expect.any(String), endOffset: 0 },
        ]);
    });

    it('a pty that ended, or was killed on the window\'s word, is not listed; one opened with no tag is listed with tag null', () => {
        const pty = fakePty();
        const { host, window } = channelPair();
        serveSpawnHost(host, { exec: async () => ({}) as never, stream: (() => ({ stop() {} })) as never, pty: pty.port });
        window.send({ kind: 'call', id: 0, method: 'pty.open', args: ['a', { cwd: '/w', command: 'x' }] });
        window.send({ kind: 'call', id: 0, method: 'pty.open', args: ['b', { cwd: '/w', command: 'y' }, { kind: 'process', processId: 'p', workspaceId: 'w' }] });
        window.send({ kind: 'call', id: 0, method: 'pty.open', args: ['c', { cwd: '/w', command: 'z' }, { kind: 'process', processId: 'q', workspaceId: 'w' }] });
        pty.end('e2', 0);
        window.send({ kind: 'call', id: 0, method: 'pty.kill', args: ['c'] });
        window.send({ kind: 'call', id: 9, method: 'pty.list', args: [] });
        expect((resultOf(window.frames, 9) as { value: unknown }).value).toEqual([{ id: 'a', pid: 1001, tag: null, shell: 'x', scrollback: '', epoch: expect.any(String), endOffset: 0 }]);
    });
});
