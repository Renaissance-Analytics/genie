import { describe, expect, it } from 'vitest';
import { COMPLETED_COMMAND_HISTORY_MAX as MAX, ProcessSupervisor } from '../src/main/process-supervisor.js';
import type { PtyPort } from '../src/main/terminal-host.js';

// Fixed-clock, in-memory supervisor. No file, shell, provider or OS process. Every reader of the supervisor (the process
// book, the features snapshot's hosting.processes, the agents' tools) reads its list, so what it forgets is gone for all.
function rig() {
    let opened = 0; let cancelled = 0;
    const pty: PtyPort = {
        open: () => ({ id: `fake-pty-${++opened}`, pid: 100, shell: 'fixture', scrollback: '' }),
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
        onData: () => () => {}, onExit: () => () => {},
    };
    const supervisor = new ProcessSupervisor(pty, { now: () => 42, schedule: () => () => {} });
    // What a forget says to whoever follows the supervisor (the process book, genie-host's feature pushes).
    const forgotten: string[] = [];
    supervisor.onForget((id) => { forgotten.push(id); });
    const run = (id: string, workspaceId = 'work') => supervisor.trackExternal(
        { id, workspaceId, name: 'fixture command', command: `command ${id}`, cwd: '/fixture' },
        { pid: 123, stop: () => { cancelled += 1; } },
    );
    const complete = (id: string, workspaceId = 'work', code: number | null = 0, stopped = false) => {
        const handle = run(id, workspaceId); handle.output(`log ${id}\n`); handle.finish(code, stopped); return handle;
    };
    return { supervisor, forgotten, run, complete, cancelled: () => cancelled, opened: () => opened };
}

describe('transient service command history is bounded everywhere (#633)', () => {
    it('keeps the newest 100 completed commands and releases the oldest status, command and log', () => {
        const w = rig();
        expect(MAX).toBe(100);
        for (let i = 0; i <= MAX; i += 1) w.complete(`done-${i}`);
        expect(w.supervisor.list()).toHaveLength(MAX);
        expect(w.supervisor.status('done-0')).toBeNull();
        expect(w.supervisor.command('done-0')).toBeUndefined();
        expect(w.supervisor.readLog('done-0')).toBeNull();
        expect(w.supervisor.log(`done-${MAX}`)).toBe(`log done-${MAX}`);
    });

    it('bounds total retained history across workspaces rather than allowing each new workspace another unbounded tail', () => {
        const w = rig();
        for (let i = 0; i <= MAX; i += 1) w.complete(`cross-${i}`, `workspace-${i % 3}`);
        expect(w.supervisor.list()).toHaveLength(MAX);
        expect(w.supervisor.list('workspace-0').some((row) => row.id === 'cross-0')).toBe(false);
        expect(w.supervisor.status(`cross-${MAX}`)?.workspaceId).toBe(`workspace-${MAX % 3}`);
    });

    it('evicts by completion order, even when an old run finishes last and all timestamps are identical', () => {
        const w = rig(); const slow = w.run('started-first-finished-last');
        for (let i = 0; i < MAX; i += 1) w.complete(`quick-${i}`);
        slow.output('last to finish\n'); slow.finish(0);
        expect(w.supervisor.status('quick-0')).toBeNull();
        expect(w.supervisor.status('started-first-finished-last')).toMatchObject({ state: 'exited' });
        expect(w.supervisor.log('started-first-finished-last')).toBe('last to finish');
    });

    it('says an evicted run is forgotten, once, to whoever follows the supervisor; a later read has neither it nor its log', () => {
        const w = rig();
        for (let i = 0; i <= MAX; i += 1) w.complete(`evicted-${i}`);
        expect(w.forgotten).toEqual(['evicted-0']);
        // What a reader that comes later (a new snapshot, a reconnecting phone) reads: the newest MAX, without the evicted run.
        expect(w.supervisor.list()).toHaveLength(MAX);
        expect(w.supervisor.list().some((row) => row.id === 'evicted-0')).toBe(false);
        expect(w.supervisor.command('evicted-0')).toBeUndefined();
        expect(w.supervisor.readLog('evicted-0')).toBeNull();
        expect(w.supervisor.log(`evicted-${MAX}`)).toBe(`log evicted-${MAX}`);
    });

    it('a forget is said once, however often it is asked', () => {
        const w = rig(); w.complete('direct-forget');
        expect(w.supervisor.forget('direct-forget')).toBe(true);
        expect(w.supervisor.forget('direct-forget')).toBe(false);
        expect(w.forgotten).toEqual(['direct-forget']);
        expect(w.supervisor.status('direct-forget')).toBeNull();
    });

    it('a forget is said after the row and its log are gone, and with no status transition invented for it', () => {
        const w = rig(); w.complete('view-refresh');
        const observed: unknown[] = []; const changes: string[] = [];
        w.supervisor.onForget((id) => observed.push({ id, status: w.supervisor.status(id), log: w.supervisor.readLog(id) }));
        w.supervisor.onChange((status) => changes.push(`${status.id}:${status.state}`));
        expect(w.supervisor.forget('view-refresh')).toBe(true);
        expect(observed).toEqual([{ id: 'view-refresh', status: null, log: null }]);
        expect(changes).toEqual([]);
    });

    it('failed and stopped runs count toward the same completion bound', () => {
        const w = rig();
        for (let i = 0; i < MAX - 1; i += 1) w.complete(`success-${i}`);
        w.complete('failed', 'work', 2); w.complete('stopped', 'work', null, true);
        expect(w.supervisor.list()).toHaveLength(MAX);
        expect(w.supervisor.status('success-0')).toBeNull();
        expect(w.supervisor.status('failed')).toMatchObject({ state: 'failed', exitCode: 2 });
        expect(w.supervisor.status('stopped')).toMatchObject({ state: 'stopped' });
    });

    it('CONTROL: active commands and ordinary supervised processes survive a full completed-command history', () => {
        const w = rig();
        w.supervisor.start({ id: 'kept-worker', workspaceId: 'work', name: 'worker', command: 'worker', cwd: '/fixture', restart: 'never' });
        w.supervisor.stop('kept-worker');
        for (let i = 0; i <= MAX; i += 1) w.run(`active-${i}`);
        for (let i = 0; i <= MAX; i += 1) w.complete(`complete-${i}`);
        for (let i = 0; i <= MAX; i += 1) expect(w.supervisor.status(`active-${i}`)?.state).toBe('running');
        expect(w.supervisor.status('kept-worker')).toMatchObject({ state: 'stopped' });
        expect(w.cancelled()).toBe(0); expect(w.opened()).toBe(1);
    });

    it('CONTROL: a run that is still in the history is said by nobody as forgotten', () => {
        const w = rig();
        for (let i = 0; i < MAX; i += 1) w.complete(`kept-${i}`);
        expect(w.forgotten).toEqual([]);
        expect(w.supervisor.status('kept-0')).toMatchObject({ state: 'exited' });
    });
});
