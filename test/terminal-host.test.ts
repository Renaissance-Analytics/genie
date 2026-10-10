import { describe, expect, it } from 'vitest';
import { TerminalHost, type PtyPort, type PtySpawnOptions } from '../src/main/terminal-host.js';

/**
 * TERMINALS — for shells, builds, services and hosted sites. **No agent has one.**
 *
 * `test/no-agent-pty.test.ts` owns the one rule. This file owns the surface: that a terminal
 * can be opened, written to, resized, read back and closed, and that closing one workspace's
 * terminals does not reach into another's.
 *
 * The port is injected, so none of this spawns a process. The real engine is
 * `fancy-term-host` and it is proved by `npm run verify:terminal` against a real pty — a fake
 * proves the bookkeeping and can never prove that a shell starts.
 */

/** A pty port that RECORDS, and never spawns. */
function recordingPty() {
    const opened: PtySpawnOptions[] = [];
    const killed: string[] = [];
    const writes: Array<{ id: string; data: string }> = [];
    const resizes: Array<{ id: string; cols: number; rows: number }> = [];
    let live: string[] = [];
    let dataListener: ((id: string, data: string) => void) | null = null;
    let exitListener: ((id: string, exitCode: number) => void) | null = null;

    const port: PtyPort = {
        open: (options) => {
            opened.push(options);
            const id = `pty_${opened.length}`;
            live = [...live, id];
            return { id, pid: 1000 + opened.length, shell: options.command ?? '/bin/sh', scrollback: '' };
        },
        write: (id, data) => {
            if (!live.includes(id)) return false;
            writes.push({ id, data });
            return true;
        },
        resize: (id, cols, rows) => {
            if (!live.includes(id)) return false;
            resizes.push({ id, cols, rows });
            return true;
        },
        kill: (id) => {
            if (!live.includes(id)) return false;
            killed.push(id);
            live = live.filter((x) => x !== id);
            return true;
        },
        scrollback: (id) => (live.includes(id) ? `history of ${id}` : undefined),
        onData: (listener) => {
            dataListener = listener;
            return () => { dataListener = null; };
        },
        onExit: (listener) => {
            exitListener = listener;
            return () => { exitListener = null; };
        },
    };

    return {
        port,
        opened,
        killed,
        writes,
        resizes,
        emitData: (id: string, data: string) => dataListener?.(id, data),
        emitExit: (id: string, code: number) => exitListener?.(id, code),
    };
}

describe('opening a terminal', () => {
    it('opens one in a workspace and reports it', () => {
        const pty = recordingPty();
        const host = new TerminalHost(pty.port);

        const opened = host.open({ workspaceId: 'tynn', cwd: '/repo', command: 'npm test' });

        expect(opened.id).toBe('pty_1');
        expect(host.count).toBe(1);
        expect(pty.opened).toEqual([{ cwd: '/repo', command: 'npm test' }]);
    });

    it('opens a plain SHELL when no command is given', () => {
        /**
         * `+terminal` is the common case and names no command: the engine resolves the user's
         * own login shell. A host that required one would make the ordinary thing the special
         * case, and would have to invent a default — which is how a build ends up spawning
         * `/bin/sh` for somebody whose shell is fish.
         */
        const pty = recordingPty();
        const host = new TerminalHost(pty.port);

        host.open({ workspaceId: 'tynn', cwd: '/repo' });

        expect(pty.opened).toEqual([{ cwd: '/repo', command: undefined }]);
    });

    it('passes the initial size through, so the first paint is not the wrong shape', () => {
        // A shell spawned at the engine's default and resized a frame later reflows everything
        // it has already printed — the banner wraps, then unwraps.
        const pty = recordingPty();
        const host = new TerminalHost(pty.port);

        host.open({ workspaceId: 'tynn', cwd: '/repo', cols: 120, rows: 30 });

        expect(pty.opened[0]).toMatchObject({ cols: 120, rows: 30 });
    });

    it('lists what is open, with the workspace each belongs to', () => {
        const pty = recordingPty();
        const host = new TerminalHost(pty.port);

        host.open({ workspaceId: 'tynn', cwd: '/a' });
        host.open({ workspaceId: 'fancy', cwd: '/b' });

        expect(host.list().map((t) => [t.id, t.workspaceId])).toEqual([
            ['pty_1', 'tynn'],
            ['pty_2', 'fancy'],
        ]);
    });
});

describe('using one', () => {
    it('writes what the human typed', () => {
        const pty = recordingPty();
        const host = new TerminalHost(pty.port);
        const { id } = host.open({ workspaceId: 'tynn', cwd: '/repo' });

        expect(host.write(id, 'npm test\r')).toBe(true);
        expect(pty.writes).toEqual([{ id, data: 'npm test\r' }]);
    });

    it('resizes', () => {
        const pty = recordingPty();
        const host = new TerminalHost(pty.port);
        const { id } = host.open({ workspaceId: 'tynn', cwd: '/repo' });

        expect(host.resize(id, 100, 40)).toBe(true);
        expect(pty.resizes).toEqual([{ id, cols: 100, rows: 40 }]);
    });

    it('replays scrollback, so a second window joins mid-build', () => {
        // Multi-attach is §6.5: a terminal opened in a second window shows what has already
        // happened rather than an empty pane with a live cursor.
        const pty = recordingPty();
        const host = new TerminalHost(pty.port);
        const { id } = host.open({ workspaceId: 'tynn', cwd: '/repo' });

        expect(host.scrollback(id)).toBe('history of pty_1');
    });

    it('says NO rather than throwing for a terminal it does not have', () => {
        /**
         * A renderer holding a stale id is ordinary — a window that was open when the terminal
         * closed. `false` is an answer it can act on; a thrown error from an IPC handler is an
         * unhandled rejection in the main process.
         */
        const pty = recordingPty();
        const host = new TerminalHost(pty.port);

        expect(host.write('pty_nope', 'x')).toBe(false);
        expect(host.resize('pty_nope', 10, 10)).toBe(false);
        expect(host.close('pty_nope')).toBe(false);
        expect(host.scrollback('pty_nope')).toBeUndefined();
    });
});

describe('output and exit reach whoever is watching', () => {
    it('forwards output, tagged with the terminal it came from', () => {
        const pty = recordingPty();
        const host = new TerminalHost(pty.port);
        const { id } = host.open({ workspaceId: 'tynn', cwd: '/repo' });
        const seen: Array<{ id: string; data: string }> = [];
        host.onData((terminalId, data) => seen.push({ id: terminalId, data }));

        pty.emitData(id, 'ok 1 - it works');

        expect(seen).toEqual([{ id, data: 'ok 1 - it works' }]);
    });

    it('reports an exit and FORGETS the terminal', () => {
        /**
         * A shell that exits on its own — `exit`, a build finishing, a crash — must leave the
         * host's list, or the count keeps a dead terminal in it forever and `closeWorkspace`
         * tries to kill something that is already gone.
         */
        const pty = recordingPty();
        const host = new TerminalHost(pty.port);
        const { id } = host.open({ workspaceId: 'tynn', cwd: '/repo' });
        const exits: Array<{ id: string; code: number }> = [];
        host.onExit((terminalId, code) => exits.push({ id: terminalId, code }));

        pty.emitExit(id, 0);

        expect(exits).toEqual([{ id, code: 0 }]);
        expect(host.count).toBe(0);
        expect(host.list()).toEqual([]);
    });

    it('stops forwarding once the listener unsubscribes', () => {
        // A closed window must not keep a listener alive in the main process. The old build
        // leaked one per reopened panel.
        const pty = recordingPty();
        const host = new TerminalHost(pty.port);
        const { id } = host.open({ workspaceId: 'tynn', cwd: '/repo' });
        const seen: string[] = [];
        const stop = host.onData((_id, data) => seen.push(data));

        pty.emitData(id, 'first');
        stop();
        pty.emitData(id, 'second');

        expect(seen).toEqual(['first']);
    });
});

describe('closing', () => {
    it('closes one', () => {
        const pty = recordingPty();
        const host = new TerminalHost(pty.port);
        const { id } = host.open({ workspaceId: 'tynn', cwd: '/repo' });

        expect(host.close(id)).toBe(true);
        expect(pty.killed).toEqual([id]);
        expect(host.count).toBe(0);
    });

    it('closes one workspace’s terminals and NOTHING outside it', () => {
        /**
         * Hibernating a workspace stops its work; it must not reach into another's. The same
         * scoping discipline as `killTree` taking only this session's own pids — on a machine
         * running a dozen agents, the difference is stopping one thing or stopping the room.
         */
        const pty = recordingPty();
        const host = new TerminalHost(pty.port);
        const mine = host.open({ workspaceId: 'tynn', cwd: '/a' });
        const alsoMine = host.open({ workspaceId: 'tynn', cwd: '/a' });
        const theirs = host.open({ workspaceId: 'fancy', cwd: '/b' });

        expect(host.closeWorkspace('tynn')).toBe(2);

        expect(pty.killed.sort()).toEqual([mine.id, alsoMine.id].sort());
        expect(host.list().map((t) => t.id)).toEqual([theirs.id]);
    });

    it('closes everything on a real quit', () => {
        // An upgrade must leave nothing behind that outlives the app — §7.1's whole subject.
        const pty = recordingPty();
        const host = new TerminalHost(pty.port);
        host.open({ workspaceId: 'tynn', cwd: '/a' });
        host.open({ workspaceId: 'fancy', cwd: '/b' });

        expect(host.closeAll()).toBe(2);
        expect(host.count).toBe(0);
    });

    it('reports zero for a workspace with no terminals, which is not an error', () => {
        // POSITIVE CONTROL for the scoping test above: `closeWorkspace` returning 2 only means
        // something if an unrelated id returns 0 rather than sweeping whatever it finds.
        const pty = recordingPty();
        const host = new TerminalHost(pty.port);
        host.open({ workspaceId: 'tynn', cwd: '/a' });

        expect(host.closeWorkspace('nobody')).toBe(0);
        expect(host.count).toBe(1);
    });
});
