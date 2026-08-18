import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * genie#217 — `manageTerminals action:read` goes permanently blind on a LIVE
 * terminal after Genie's main process restarts (or its pty-host client
 * reconnects).
 *
 * The agent read buffer is module-scoped in-memory state fed ONLY by the live
 * `onData` fan-out. The ptys themselves survive in the detached pty-host — with
 * up to 1 MB of scrollback each — so after a restart the terminal is genuinely
 * alive and `list` still shows it, while the read buffer holds nothing. A PARKED
 * agent emits no new bytes, so nothing ever refills it: every read returns
 * `data:'' cursor:0 dropped:false`, forever, and an Ops loop that classifies
 * agents by reading their terminal cannot tell working / idle / blocked /
 * crashed apart.
 *
 * These tests drive the real `readTerminalOutput` against a backend that holds
 * the surviving scrollback, with the read buffer never fed — exactly the
 * post-restart state.
 */

// A controllable fake pty so the backend can "spawn" without node-pty's native
// binding, and the test can push output / trigger an exit on demand.
interface FakePty {
    pid: number;
    process: string;
    emit(data: string): void;
    exit(code: number): void;
}
const ptys: FakePty[] = [];
vi.mock('node-pty', () => ({
    spawn: () => {
        let onData: ((d: string) => void) | null = null;
        let onExit: ((e: { exitCode: number; signal?: number }) => void) | null = null;
        const p = {
            pid: 4242 + ptys.length,
            process: 'fake',
            onData: (cb: (d: string) => void) => {
                onData = cb;
            },
            onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
                onExit = cb;
            },
            write: () => {},
            resize: () => {},
            kill() {
                onExit?.({ exitCode: 0 });
            },
            emit(data: string) {
                onData?.(data);
            },
            exit(code: number) {
                onExit?.({ exitCode: code });
            },
        };
        ptys.push(p as unknown as FakePty);
        return p;
    },
}));

// The specs the db "holds" — tests mutate this to model a spec being deleted.
const specIds: string[] = [];
vi.mock('../../db', () => ({
    updateTerminalSpec: () => null,
    getAllSettings: () => ({ track_cwd: 'off' }),
    getTerminalSpec: () => null,
    listTerminalSpecs: () => specIds.map((id) => ({ id })),
    listWorkspaces: () => [],
    getWorkspace: () => null,
    workspaceMcpEnabled: () => false,
    createTerminalSpec: () => null,
}));

vi.mock('../genie-adapter', () => ({
    getSnapshotStore: () => ({
        readSnapshot: () => null,
        writeSnapshot: () => 1,
        deleteSnapshot: () => undefined,
    }),
    dbSettingsProvider: () => ({
        get: (k: string) => (k === 'track_cwd' ? 'off' : undefined),
    }),
}));

import {
    readTerminalOutput,
    reapOrphanTerminals,
    seedAgentReadBuffers,
    subscribeHeadlessBackendEvents,
} from '../ipc';
import { terminalManager, configureInProcessBackend } from '@particle-academy/fancy-term-host';

configureInProcessBackend({
    settings: { get: (k) => (k === 'track_cwd' ? 'off' : undefined) },
    snapshots: {
        readSnapshot: () => null,
        writeSnapshot: () => 1,
        deleteSnapshot: () => undefined,
    },
});

/** Spawn a pty through the real backend and return its controllable fake. */
function spawnPty(id: string): FakePty {
    terminalManager().create({ id, cwd: process.cwd(), shell: 'fake' });
    return ptys[ptys.length - 1];
}

beforeEach(() => {
    ptys.length = 0;
    specIds.length = 0;
    terminalManager().killAll();
});

afterEach(() => {
    terminalManager().killAll();
});

describe('genie#217 — reading a terminal whose read buffer was lost', () => {
    it('restores a LIVE terminal\'s surviving scrollback instead of reading empty', () => {
        // A pty that produced output BEFORE this main process existed: the
        // backend (in the real world, the pty-host mirror seeded on connect)
        // holds the scrollback; the agent read buffer was never fed, exactly as
        // after a Genie restart.
        const pty = spawnPty('t-live');
        pty.emit('claude> waiting for input\r\n');
        expect(terminalManager().getScrollback('t-live')).toContain('waiting for input');

        const r = readTerminalOutput('t-live', {});

        expect(r.data).toContain('claude> waiting for input');
        expect(r.cursor).toBeGreaterThan(0);
        expect(r.state).toBe('restored');
    });

    it('serves a byte-tail read from the restored scrollback too', () => {
        const pty = spawnPty('t-tail');
        pty.emit('0123456789abcdef');

        const r = readTerminalOutput('t-tail', { bytes: 6 });

        expect(r.data).toBe('abcdef');
        expect(r.state).toBe('restored');
    });

    it('reports a LIVE but genuinely quiet terminal as live, not blind', () => {
        spawnPty('t-quiet'); // spawned, never emitted a byte

        const r = readTerminalOutput('t-quiet', {});

        expect(r.data).toBe('');
        expect(r.state).toBe('live');
    });

    it('seeds every surviving terminal at boot, so the first read is already whole', () => {
        // Two ptys that outlived the previous Genie process, as they do in the
        // detached pty-host.
        spawnPty('t-boot-a').emit('agent A scrollback');
        spawnPty('t-boot-b').emit('agent B scrollback');

        expect(seedAgentReadBuffers().sort()).toEqual(['t-boot-a', 't-boot-b']);

        // Seeded up front, so the read is a normal live read — not a restore.
        const a = readTerminalOutput('t-boot-a', {});
        expect(a.data).toBe('agent A scrollback');
        expect(a.state).toBe('live');
        expect(readTerminalOutput('t-boot-b', {}).data).toBe('agent B scrollback');

        // Idempotent: a second pass must not duplicate what it already holds.
        expect(seedAgentReadBuffers()).toEqual([]);
        expect(readTerminalOutput('t-boot-a', {}).data).toBe('agent A scrollback');
    });

    it('catches up on surviving scrollback as soon as the live tap is wired', () => {
        // Wiring the data fan-out is the moment we start seeing output — so it is
        // also the moment to collect what we MISSED, without every embedder (the
        // desktop app, the headless host-core) having to remember a second call.
        spawnPty('t-wire').emit('output from the previous process');

        subscribeHeadlessBackendEvents();

        const r = readTerminalOutput('t-wire', {});
        expect(r.data).toBe('output from the previous process');
        expect(r.state).toBe('live'); // already seeded — not a lazy per-read rescue
    });

    it('says the pty is GONE rather than returning an indistinguishable empty read', () => {
        // Wire the real data/exit fan-out, so this exercises the production path
        // that drops a buffer on exit.
        subscribeHeadlessBackendEvents();
        const pty = spawnPty('t-dead');
        pty.emit('panic: agent crashed\r\n');
        // The buffer is fed live here, so a read before the exit is normal.
        expect(readTerminalOutput('t-dead', {}).data).toContain('panic');

        pty.exit(1);

        const r = readTerminalOutput('t-dead', {});
        // 0 bytes because the pty is gone is NOT the same answer as 0 bytes
        // because the terminal is quiet — the caller must be able to tell.
        expect(r.state).toBe('exited');
        // And the final output survives the exit: it is the only evidence of WHY
        // the agent died, and the spec stays listed (revivable) after it.
        expect(readTerminalOutput('t-dead', { bytes: 4096 }).data).toContain('panic');
    });

    it('releases a retained exit buffer once the terminal SPEC is gone', () => {
        // Keeping a dead pty's final output is only sound while its spec is still
        // around to revive: once the spec is deleted the terminal no longer
        // exists, and its buffer must not outlive it.
        subscribeHeadlessBackendEvents();
        specIds.push('t-reaped');
        const pty = spawnPty('t-reaped');
        pty.emit('final words\r\n');
        pty.exit(0);
        expect(readTerminalOutput('t-reaped', { bytes: 4096 }).data).toContain('final words');

        specIds.length = 0; // the spec is deleted out from under it
        reapOrphanTerminals();

        expect(readTerminalOutput('t-reaped', { bytes: 4096 }).buffered).toBe(false);
    });
});
