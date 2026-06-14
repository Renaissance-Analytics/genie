import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tier 2 — retained PTY (disable-not-delete) tests.
 *
 * node-pty isn't available in the Node test runtime (native binding), so we
 * mock it with a tiny fake IPty: it records writes, fires onData/onExit
 * listeners, and tracks whether it was killed. That's enough to exercise the
 * manager's pty pool + retention API and the IPC detachOwner decision without
 * a real shell.
 *
 * We mock at the module level BEFORE importing the manager so vi.mock's factory
 * substitutes node-pty in the manager's import graph.
 */

interface FakePty {
    pid: number;
    process: string;
    killed: boolean;
    written: string[];
    _onData: ((d: string) => void) | null;
    _onExit: ((e: { exitCode: number; signal?: number }) => void) | null;
    onData: (cb: (d: string) => void) => void;
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void;
    write: (d: string) => void;
    resize: (c: number, r: number) => void;
    kill: () => void;
    /** Test helper: push data through onData (also feeds the scrollback buffer). */
    emit: (d: string) => void;
}

const spawned: FakePty[] = [];
let nextPid = 1000;

function makeFakePty(): FakePty {
    const p: FakePty = {
        pid: nextPid++,
        process: 'fake-shell',
        killed: false,
        written: [],
        _onData: null,
        _onExit: null,
        onData(cb) {
            this._onData = cb;
        },
        onExit(cb) {
            this._onExit = cb;
        },
        write(d) {
            this.written.push(d);
        },
        resize() {
            /* no-op */
        },
        kill() {
            this.killed = true;
            this._onExit?.({ exitCode: 0 });
        },
        emit(d) {
            this._onData?.(d);
        },
    };
    return p;
}

vi.mock('node-pty', () => ({
    spawn: () => {
        const p = makeFakePty();
        spawned.push(p);
        return p;
    },
}));

// db is imported lazily inside the manager (require) for cwd persistence; the
// electron stub's app.getPath returns /tmp, so a real db could init. Stub the
// persistence path so tests never touch disk state.
vi.mock('../../db', () => ({
    updateTerminalSpec: () => null,
    // shells.ts cwdHookEnv reads this during create(); track_cwd off → {} env.
    getAllSettings: () => ({ track_cwd: 'off' }),
}));

// sessions.ts is imported by both manager (readSnapshot) and ipc
// (writeSnapshot/deleteSnapshot). Stub so no snapshot files are touched.
vi.mock('../sessions', () => ({
    readSnapshot: () => null,
    writeSnapshot: () => 1,
    deleteSnapshot: () => undefined,
}));

import { terminalManager } from '../manager';

function mgr() {
    return terminalManager();
}

function freshCreate(id: string) {
    return mgr().create({ id, cwd: '/tmp', shell: '/bin/fake', args: [] });
}

beforeEach(() => {
    spawned.length = 0;
    // Clean any ptys left from a prior test (the manager is a singleton).
    mgr().killAll();
    for (const id of mgr().retainedIds()) mgr().setRetained(id, false);
});

afterEach(() => {
    mgr().killAll();
});

describe('manager retained API', () => {
    it('setRetained/isRetained/retainedCount toggle correctly', () => {
        const m = mgr();
        expect(m.isRetained('t1')).toBe(false);
        m.setRetained('t1', true);
        expect(m.isRetained('t1')).toBe(true);
        expect(m.retainedCount()).toBe(1);
        m.setRetained('t1', false);
        expect(m.isRetained('t1')).toBe(false);
        expect(m.retainedCount()).toBe(0);
    });

    it('killing a pty clears its retained flag', () => {
        const m = mgr();
        freshCreate('t-kill');
        m.setRetained('t-kill', true);
        expect(m.isRetained('t-kill')).toBe(true);
        m.kill('t-kill');
        expect(m.isRetained('t-kill')).toBe(false);
        expect(m.isLive('t-kill')).toBe(false);
    });

    it('pty exit clears its retained flag', () => {
        const m = mgr();
        freshCreate('t-exit');
        m.setRetained('t-exit', true);
        // Simulate the shell exiting on its own.
        spawned[0]._onExit?.({ exitCode: 0 });
        expect(m.isRetained('t-exit')).toBe(false);
        expect(m.isLive('t-exit')).toBe(false);
    });
});

describe('detachOwner decision (Tier 2 core)', () => {
    /**
     * detachOwner's whole Tier 2 change is:
     *   if (owners === 0) { if (!mgr.isRetained(id)) mgr.kill(id); }
     * We exercise that decision against the real manager.
     */
    const lastDetach = (id: string) => {
        if (!mgr().isRetained(id)) mgr().kill(id);
    };

    it('retained=true leaves the pty alive, listed, scrollback retained; create rejoins', () => {
        const m = mgr();
        freshCreate('srv');
        // Produce some output so there is scrollback to replay.
        spawned[0].emit('listening on :3000\r\n');
        m.setRetained('srv', true);

        // Last window detaches.
        lastDetach('srv');

        // Pty survives.
        expect(m.isLive('srv')).toBe(true);
        expect(spawned[0].killed).toBe(false);
        expect(m.list().some((t) => t.id === 'srv')).toBe(true);
        expect(m.getScrollback('srv')).toContain('listening on :3000');

        // Re-enable: create rejoins the SAME live pty (existing=true) and
        // returns the buffered scrollback for replay — no new spawn.
        const before = spawned.length;
        const res = freshCreate('srv');
        expect(res.existing).toBe(true);
        expect(res.scrollback).toContain('listening on :3000');
        expect(spawned.length).toBe(before); // no respawn
    });

    it('retained=false kills the pty on last detach (legacy behaviour)', () => {
        const m = mgr();
        freshCreate('scratch');
        expect(m.isLive('scratch')).toBe(true);

        lastDetach('scratch');

        expect(m.isLive('scratch')).toBe(false);
        expect(spawned[0].killed).toBe(true);
    });
});
