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

import { terminalManager, configureInProcessBackend } from '../manager';

/**
 * Inversion: instead of mocking `../../db` + `../sessions`, we configure the
 * in-process backend with TEST-DOUBLE PORTS:
 *   - a SettingsProvider map (track_cwd off → cwdHookEnv returns {}),
 *   - an in-memory no-op SnapshotStore (no snapshot files touched),
 * and capture the backend's emitted `cwd` events to prove the inversion of the
 * old direct updateTerminalSpec({ live_cwd }) write.
 */
const cwdEvents: Array<{ id: string; cwd: string }> = [];
configureInProcessBackend({
    settings: { get: (k) => (k === 'track_cwd' ? 'off' : undefined) },
    snapshots: {
        readSnapshot: () => null,
        writeSnapshot: () => 1,
        deleteSnapshot: () => undefined,
    },
});

function mgr() {
    return terminalManager();
}

function freshCreate(id: string) {
    return mgr().create({ id, cwd: '/tmp', shell: '/bin/fake', args: [] });
}

// Subscribe ONCE to the backend's emitted cwd events (the adapter's job in
// production). The singleton survives across tests, so subscribe at module load.
mgr().on('cwd', (id, cwd) => cwdEvents.push({ id, cwd }));

beforeEach(() => {
    spawned.length = 0;
    cwdEvents.length = 0;
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

describe('cwd event (inverted live_cwd persistence)', () => {
    it('emits a cwd event for an OSC-7 report (was a direct db write)', () => {
        const m = mgr();
        freshCreate('t-cwd');
        // Feed an OSC-7 cwd report. The backend records it in-memory and, on
        // teardown, flushes the latest cwd synchronously as a `cwd` event — the
        // adapter persists it to live_cwd. (The debounced timer also emits, but
        // the synchronous flush on kill is deterministic to assert.)
        spawned[0].emit('\x1b]7;file:///home/user/proj\x07');
        m.kill('t-cwd');
        expect(cwdEvents).toContainEqual({ id: 't-cwd', cwd: '/home/user/proj' });
    });

    it('does not emit cwd when no OSC-7 was seen', () => {
        const m = mgr();
        freshCreate('t-nocwd');
        spawned[0].emit('just some output, no osc7\r\n');
        m.kill('t-nocwd');
        expect(cwdEvents.some((e) => e.id === 't-nocwd')).toBe(false);
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
