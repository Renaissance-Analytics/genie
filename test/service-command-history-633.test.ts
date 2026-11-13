import { describe, expect, it } from 'vitest';
import { COMPLETED_COMMAND_HISTORY_MAX as MAX, ProcessSupervisor } from '../src/main/process-supervisor.js';
import { SupervisorReplica, SupervisorService, type SupervisorEvent } from '../src/main/supervisor-host.js';
import type { PtyPort } from '../src/main/terminal-host.js';

// Fixed-clock, in-memory supervisor + actual host/replica protocol. No file, shell, provider or OS process.
function rig() {
    let opened = 0; let cancelled = 0;
    const pty: PtyPort = {
        open: () => ({ id: `fake-pty-${++opened}`, pid: 100, shell: 'fixture', scrollback: '' }),
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
        onData: () => () => {}, onExit: () => () => {},
    };
    const supervisor = new ProcessSupervisor(pty, { now: () => 42, schedule: () => () => {} });
    const service = new SupervisorService(supervisor);
    const replica = new SupervisorReplica(async (method, args) => service.call(method, args));
    replica.rebase(service.dump());
    const events: SupervisorEvent[] = [];
    service.onEvent((event) => { events.push(event); replica.apply(event); });
    const run = (id: string, workspaceId = 'work') => supervisor.trackExternal(
        { id, workspaceId, name: 'fixture command', command: `command ${id}`, cwd: '/fixture' },
        { pid: 123, stop: () => { cancelled += 1; } },
    );
    const complete = (id: string, workspaceId = 'work', code: number | null = 0, stopped = false) => {
        const handle = run(id, workspaceId); handle.output(`log ${id}\n`); handle.finish(code, stopped); return handle;
    };
    return { supervisor, service, replica, events, run, complete, cancelled: () => cancelled, opened: () => opened };
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

    it('notifies connected replicas to release evicted statuses, commands and logs, and reconnects without them', () => {
        const w = rig();
        for (let i = 0; i <= MAX; i += 1) w.complete(`replicated-${i}`);
        expect(w.events.filter((event) => event.kind === 'forgotten')).toEqual([{ kind: 'forgotten', id: 'replicated-0' }]);
        expect(w.replica.list()).toHaveLength(MAX);
        expect(w.replica.status('replicated-0')).toBeNull();
        expect(w.replica.command('replicated-0')).toBeUndefined();
        expect(w.replica.readLog('replicated-0')).toBeNull();
        const reconnect = new SupervisorReplica(async () => null); reconnect.rebase(w.service.dump());
        expect(reconnect.list()).toHaveLength(MAX);
        expect(reconnect.status('replicated-0')).toBeNull();
        expect(reconnect.log(`replicated-${MAX}`)).toBe(`log replicated-${MAX}`);
    });

    it('direct host forget is propagated once, including to an already connected window', () => {
        const w = rig(); w.complete('direct-forget');
        expect(w.supervisor.forget('direct-forget')).toBe(true);
        expect(w.supervisor.forget('direct-forget')).toBe(false);
        expect(w.events.filter((event) => event.kind === 'forgotten')).toEqual([{ kind: 'forgotten', id: 'direct-forget' }]);
        expect(w.replica.status('direct-forget')).toBeNull();
    });

    it('the replica notifies its process view after deleting a forgotten row, without inventing a status transition', () => {
        const w = rig(); w.complete('view-refresh');
        const observed: unknown[] = [];
        const off = w.replica.onForget((id) => observed.push({ id, status: w.replica.status(id), log: w.replica.readLog(id) }));
        w.replica.apply({ kind: 'forgotten', id: 'view-refresh' });
        expect(observed).toEqual([{ id: 'view-refresh', status: null, log: null }]);
        off();
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

    it('CONTROL: an explicit remote forget emits one forgotten event, not duplicates', () => {
        const w = rig(); w.complete('remote-forget');
        expect(w.service.call('forget', ['remote-forget'])).toBe(true);
        expect(w.events.filter((event) => event.kind === 'forgotten')).toEqual([{ kind: 'forgotten', id: 'remote-forget' }]);
        expect(w.replica.status('remote-forget')).toBeNull();
    });
});
