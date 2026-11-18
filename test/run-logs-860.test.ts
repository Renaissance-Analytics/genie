import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { joinLogs, RESTART_NOTE } from '../src/core/output-tail.js';
import { KEPT_RUNS, lastFailure, withRun, type ProcessSchedule } from '../src/core/scheduled-task.js';
import { parseRoute, sameFlowWindow } from '../src/core/route.js';
import { KeptProcessLogs } from '../src/main/kept-process-logs.js';
import { ProcessBook } from '../src/main/process-book.js';
import { ProcessScheduler, type NudgeOutcome } from '../src/main/process-scheduler.js';
import { nudgeOnRoster } from '../src/main/scheduled-nudge.js';
import type { ProcessSpec, ProcessStatus } from '../src/main/process-supervisor.js';
import { processTools } from '../src/main/mcp-tools-processes.js';
import { applyHostingFeatureAction, hostingFeatureSnapshot } from '../src/main/feature-hosting.js';
import type { HostedProcess } from '../src/main/process-book.js';

/**
 * EVERYTHING THAT RUNS HAS A LOG THE PERSON CAN READ (Tynn #860). The owner, 2026-11-18: "anything that executes tasks
 * needs to provide a log I can read. I have scheduled jobs failing but no idea why." A nudge said "Last run: Failed just
 * now" and nothing else; a process "stopped by restart" had no output to show, because the supervisor's tail lived in
 * memory and died with the Genie that kept it.
 */

const WS = { id: 'ws-example', path: resolve(tmpdir(), 'genie2-860-ws') };

function fakeSupervisor() {
    const started: ProcessSpec[] = [];
    const statuses = new Map<string, ProcessStatus>();
    const logs = new Map<string, string>();
    const changes = new Set<(s: ProcessStatus) => void>();
    const outputs = new Set<(id: string, data: string) => void>();
    const set = (s: ProcessStatus) => { statuses.set(s.id, s); for (const l of changes) l(s); };
    return {
        started,
        print: (id: string, data: string) => { logs.set(id, (logs.get(id) ?? '') + data); for (const l of outputs) l(id, data); },
        exit: (id: string, code: number) => set({ ...statuses.get(id)!, state: 'exited', exitCode: code, pid: null }),
        start: (spec: ProcessSpec): ProcessStatus => { started.push(spec); if (!logs.has(spec.id)) logs.set(spec.id, ''); const s: ProcessStatus = { id: spec.id, workspaceId: spec.workspaceId, name: spec.name, state: 'running', pid: 4242, exitCode: null, restarts: 0, since: 0 }; set(s); return s; },
        stop: (id: string) => { const s = statuses.get(id); if (s) set({ ...s, state: 'stopped', pid: null }); return true; },
        forget: (id: string) => { logs.delete(id); return statuses.delete(id); },
        list: (workspaceId?: string) => [...statuses.values()].filter((s) => workspaceId === undefined || s.workspaceId === workspaceId),
        status: (id: string) => statuses.get(id) ?? null,
        readLog: (id: string, lines?: number) => {
            const text = logs.get(id);
            if (text === undefined) return null;
            const all = text.replace(/\n$/, '').split('\n').filter((l, i, a) => !(a.length === 1 && l === ''));
            const take = lines === undefined ? all : all.slice(-lines);
            return { text: take.join('\n'), lines: take.length, dropped: 0 };
        },
        onChange: (l: (s: ProcessStatus) => void) => { changes.add(l); return () => { changes.delete(l); }; },
        onOutput: (l: (id: string, data: string) => void) => { outputs.add(l); return () => { outputs.delete(l); }; },
    };
}

let home: string;
let sup: ReturnType<typeof fakeSupervisor>;
let book: ProcessBook;
let now = new Date(2026, 10, 18, 9, 0, 0).getTime();
let nudgeAnswer: () => boolean | NudgeOutcome | Promise<boolean | NudgeOutcome>;

const nudgeTask = { workspaceId: WS.id, workspacePath: WS.path, name: 'stoic ticket watch', command: '', restart: 'never' as const, schedule: { cron: '*/10 * * * *', kind: 'agent-nudge' as const, prompt: 'check the ticket queue', agent: 'stoic@moic-suite' } };
const commandTask = { workspaceId: WS.id, workspacePath: WS.path, name: 'nightly report', command: 'npm run report', restart: 'never' as const, schedule: { cron: '0 3 * * *', kind: 'command' as const } };

function scheduler() {
    return new ProcessScheduler({
        book, supervisor: sup, envFor: () => ({}), asleep: () => false,
        nudge: () => { const a = nudgeAnswer(); now += 250; return a; },
        now: () => now,
        schedule: () => () => {},
    });
}

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'genie2-860-'));
    sup = fakeSupervisor();
    now = new Date(2026, 10, 18, 9, 0, 0).getTime();
    nudgeAnswer = () => true;
    book = await ProcessBook.open(home, { supervisor: sup, envFor: () => ({}), asleep: () => false, now: () => now });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const scheduleOf = (id: string) => book.list(WS.id).find((p) => p.id === id)!.schedule!;

describe('a scheduled run is recorded with what happened (Tynn #860)', () => {
    it('a nudge that cannot be delivered keeps the REASON, its start and end, and the text it tried to send', async () => {
        const t = await book.create(nudgeTask);
        nudgeAnswer = () => ({ ok: false, reason: 'no agent answers to "stoic@moic-suite"' });
        const started = now;
        expect(await scheduler().runNow(t.id)).toBe('failed');
        const s = scheduleOf(t.id);
        expect(s.lastRunStatus).toBe('failed');
        expect(s.runs).toEqual([{ at: started, endedAt: started + 250, status: 'failed', reason: 'no agent answers to "stoic@moic-suite"', sent: 'check the ticket queue' }]);
        expect(lastFailure(s)).toBe('no agent answers to "stoic@moic-suite"');
    });

    it('a nudge that throws keeps the error text; a bare false still says something', async () => {
        const t = await book.create(nudgeTask);
        nudgeAnswer = () => { throw new Error('the session engine is not connected'); };
        await scheduler().runNow(t.id);
        expect(scheduleOf(t.id).runs![0]!.reason).toMatch(/the session engine is not connected/);
        nudgeAnswer = () => false;
        await scheduler().runNow(t.id);
        expect(scheduleOf(t.id).runs![0]!.reason).toMatch(/\S/);
        expect(scheduleOf(t.id).runs).toHaveLength(2);
    });

    it('CONTROL: a delivered nudge is ok, with no reason, and lastFailure is null', async () => {
        const t = await book.create(nudgeTask);
        await scheduler().runNow(t.id);
        const s = scheduleOf(t.id);
        expect(s.runs![0]).toMatchObject({ status: 'ok', sent: 'check the ticket queue' });
        expect(s.runs![0]!.reason).toBeUndefined();
        expect(lastFailure(s)).toBeNull();
    });

    it('a command run ends with its exit: the code is the reason, the end is when it exited', async () => {
        const t = await book.create(commandTask);
        const s = scheduler();
        const started = now;
        expect(await s.runNow(t.id)).toBe('started');
        now += 5_000;
        sup.exit(t.id, 3);
        await s.settled();
        expect(scheduleOf(t.id).runs![0]).toEqual({ at: started, endedAt: started + 5_000, status: 'failed', reason: 'exited with code 3' });
    });

    it('a skipped run says why', async () => {
        const t = await book.create(commandTask);
        const s = scheduler();
        await s.runNow(t.id);
        expect(await s.runNow(t.id)).toBe('skipped');
        expect(scheduleOf(t.id).runs![0]).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/still running/) });
    });

    it('keeps the newest runs first, at most KEPT_RUNS', () => {
        let s: ProcessSchedule = { cron: '* * * * *', kind: 'command' };
        for (let i = 0; i < KEPT_RUNS + 5; i++) s = withRun(s, { at: i, endedAt: i, status: 'ok' });
        expect(s.runs).toHaveLength(KEPT_RUNS);
        expect(s.runs![0]!.at).toBe(KEPT_RUNS + 4);
        expect(s.lastRunAt).toBe(KEPT_RUNS + 4);
        expect(s.lastRunStatus).toBe('ok');
    });
});

describe('a nudge says why it could not be delivered (genie-host\'s nudge, Tynn #860)', () => {
    const deps = (resolution: Parameters<typeof nudgeOnRoster>[0]['resolve'] extends (a: string) => infer R ? R : never, deliver: () => boolean | Promise<boolean> = () => true) => ({ resolve: () => resolution, deliver });
    it('an address that names no agent', async () => {
        expect(await nudgeOnRoster(deps({ kind: 'none' }), 'stoic@moic-suite', 'hi', 'watch')).toEqual({ ok: false, reason: expect.stringMatching(/no agent.*stoic@moic-suite/) });
    });
    it('an address that names two', async () => {
        expect(await nudgeOnRoster(deps({ kind: 'ambiguous', forms: ['stoic@a', 'stoic@b'] }), 'stoic', 'hi', 'watch')).toEqual({ ok: false, reason: expect.stringMatching(/stoic@a, stoic@b/) });
    });
    it('an agent with no running session (the host\'s deliver answers false)', async () => {
        expect(await nudgeOnRoster(deps({ kind: 'one', id: 'a1' as never }, () => false), 'stoic@moic-suite', 'hi', 'watch')).toEqual({ ok: false, reason: expect.stringMatching(/stoic@moic-suite is not running/) });
    });
    it('a delivery that throws', async () => {
        expect(await nudgeOnRoster(deps({ kind: 'one', id: 'a1' as never }, () => { throw new Error('pipe closed'); }), 'stoic@moic-suite', 'hi', 'watch')).toEqual({ ok: false, reason: expect.stringMatching(/pipe closed/) });
    });
    it('CONTROL: delivered, from the task by name', async () => {
        const by: string[] = [];
        expect(await nudgeOnRoster({ resolve: () => ({ kind: 'one', id: 'a1' as never }), deliver: (_id, _text, from) => { by.push(from); return true; } }, 'stoic@moic-suite', 'hi', 'watch')).toEqual({ ok: true });
        expect(by).toEqual(['scheduled task "watch"']);
    });
});

describe('a kept process\'s output outlives the Genie that ran it (Tynn #860)', () => {
    const dir = () => join(home, 'process-logs');
    const sched = { schedule: (fn: () => void) => { fn(); return () => {}; } };

    it('joinLogs puts the earlier output first, says where Genie restarted, and counts what was cut', () => {
        const j = joinLogs({ text: 'a\nb', lines: 2, dropped: 4 }, { text: 'c', lines: 1, dropped: 1 })!;
        expect(j.text).toBe(`a\nb\n[genie] ${RESTART_NOTE}\nc`);
        expect(j.dropped).toBe(5);
        expect(joinLogs(null, null)).toBeNull();
        expect(joinLogs(null, { text: 'c', lines: 1, dropped: 0 })!.text).toBe('c');
        expect(joinLogs({ text: 'a\nb', lines: 2, dropped: 0 }, null, 1)!.text).toBe('b');
    });

    it('what a kept process printed is read back after a restart, when the new Genie\'s supervisor has nothing', async () => {
        const logs = await KeptProcessLogs.open(dir(), { supervisor: sup, owns: (id) => id === 'p1', ...sched });
        sup.start({ id: 'p1', workspaceId: WS.id, name: 'worker', command: 'x', cwd: WS.path, restart: 'never' });
        sup.print('p1', 'booted\nprocessed 3 jobs\n');
        sup.exit('p1', 1);
        await logs.flush();
        const sup2 = fakeSupervisor();
        const after = await KeptProcessLogs.open(dir(), { supervisor: sup2, owns: (id) => id === 'p1', ...sched });
        expect(after.read('p1')).toMatchObject({ text: 'booted\nprocessed 3 jobs' });
        // Started again in the new Genie: the earlier run, then where Genie restarted, then this run.
        sup2.start({ id: 'p1', workspaceId: WS.id, name: 'worker', command: 'x', cwd: WS.path, restart: 'never' });
        sup2.print('p1', 'booted again\n');
        expect(after.read('p1')!.text).toBe(`booted\nprocessed 3 jobs\n[genie] ${RESTART_NOTE}\nbooted again`);
        expect(after.read('p1', 1)!.text).toBe('booted again');
    });

    it('CONTROL: a process the book does not keep (a site\'s server) is never written; forget removes the file', async () => {
        const logs = await KeptProcessLogs.open(dir(), { supervisor: sup, owns: (id) => id === 'p1', ...sched });
        sup.start({ id: 'site', workspaceId: WS.id, name: 'site', command: 'x', cwd: WS.path, restart: 'never' });
        sup.print('site', 'GET /\n');
        sup.start({ id: 'p1', workspaceId: WS.id, name: 'worker', command: 'x', cwd: WS.path, restart: 'never' });
        sup.print('p1', 'hello\n');
        await logs.flush();
        expect((await readdir(dir())).sort()).toEqual(['p1.json']);
        await logs.forget('p1');
        expect(await readdir(dir())).toEqual([]);
        const fresh = await KeptProcessLogs.open(dir(), { supervisor: fakeSupervisor(), owns: () => true, ...sched });
        expect(fresh.read('p1')).toBeNull();
    });

    it('the book lists a stopped kept process WITH its kept output, reads it whole by `log`, and forgets it on remove', async () => {
        const logs = await KeptProcessLogs.open(dir(), { supervisor: sup, owns: () => true, ...sched });
        const b = await ProcessBook.open(home, { supervisor: sup, envFor: () => ({}), asleep: () => false, logs });
        const p = await b.create({ workspaceId: WS.id, workspacePath: WS.path, name: 'worker', command: 'x', restart: 'never' });
        sup.print(p.id, 'line 1\nline 2\n');
        await logs.flush();
        // The next Genie: the supervisor never ran it; the row says "stopped by restart" and still has its output.
        const sup2 = fakeSupervisor();
        const logs2 = await KeptProcessLogs.open(dir(), { supervisor: sup2, owns: () => true, ...sched });
        const b2 = await ProcessBook.open(home, { supervisor: sup2, envFor: () => ({}), asleep: () => false, logs: logs2 });
        b2.restore();
        const row = b2.list(WS.id).find((r) => r.id === p.id)!;
        expect(row.reason).toMatch(/stopped by restart/);
        expect(row.log).toMatchObject({ text: 'line 1\nline 2', lines: 2 });
        expect(b2.log(p.id)).toMatchObject({ text: 'line 1\nline 2' });
        await b2.remove(p.id);
        expect(logs2.read(p.id)).toBeNull();
    });
});

describe('agents read the same (the `processes` tool, Tynn #860)', () => {
    it('`list` carries each scheduled run with its reason; `logs` reads the port (the book\'s kept output)', async () => {
        const run = { at: Date.UTC(2026, 10, 18, 9), endedAt: Date.UTC(2026, 10, 18, 9, 0, 1), status: 'failed' as const, reason: 'stoic@moic-suite is not running', sent: 'check the ticket queue' };
        const row: HostedProcess = { id: 'p1', workspaceId: WS.id, name: 'stoic ticket watch', state: 'stopped', pid: null, exitCode: null, restarts: 0, since: 0, durable: true, schedule: { cron: '*/10 * * * *', kind: 'agent-nudge', agent: 'stoic@moic-suite', prompt: 'check the ticket queue', enabled: true, nextRunAt: null, lastRunAt: run.at, lastRunStatus: 'failed', runs: [run] } };
        const [tool] = processTools({
            resolveCaller: () => ({ workspaceId: WS.id, workspacePath: WS.path } as never),
            approve: async () => 'allowed',
            processes: { book: { list: () => [row] } as never, logs: (id) => (id === 'p1' ? { text: 'kept from before', lines: 1, dropped: 0 } : null) },
        });
        const call = async (args: Record<string, unknown>) => JSON.parse((await tool!.handler({ terminalId: 't', ...args } as never, { headers: {} } as never)).text);
        const listed = await call({ action: 'list' });
        expect(listed.processes[0].schedule.runs).toEqual([{ at: new Date(run.at).toISOString(), endedAt: new Date(run.endedAt).toISOString(), status: 'failed', reason: run.reason, sent: run.sent }]);
        expect(listed.processes[0].schedule.lastRunReason).toBe(run.reason);
        expect((await call({ action: 'logs', process: 'p1' })).log).toBe('kept from before');
    });
});

describe('the Log button reads the kept output in Hosting (Tynn #860)', () => {
    const row: HostedProcess = { id: 'p1', workspaceId: WS.id, name: 'worker', state: 'stopped', pid: null, exitCode: null, restarts: 0, since: 0, durable: true, reason: 'stopped by restart (restart: never); use Start to run it again', log: { text: 'from before', lines: 1, dropped: 0 } };
    const services = {
        trustSteps: () => [], sites: { list: () => [] }, supervisor: { readLog: () => null }, externalFrontDoor: { state: 'off' }, hostingProblems: () => [],
        workspaceVisible: () => true, engineStatuses: async () => [], routes: () => [],
    } as never;
    const ports = { processes: { list: () => [row], owns: (id: string) => id === 'p1', log: async (id: string) => (id === 'p1' ? { text: 'all of it', lines: 1, dropped: 0 } : null) } } as never;

    it('a stopped row keeps the book\'s output when the supervisor has none', async () => {
        const snap = await hostingFeatureSnapshot(services, {}, ports);
        expect(snap.hosting!.processes[0]!.log).toMatchObject({ text: 'from before' });
    });

    it('`hosting.openProcessLog` opens the whole kept log in the snapshot; `hosting.closeProcessLog` closes it', async () => {
        const next: Record<string, unknown> = {};
        expect(await applyHostingFeatureAction(services, { kind: 'hosting.openProcessLog', processId: 'p1' }, {}, next as never, ports)).toBe(true);
        const snap = await hostingFeatureSnapshot(services, next as never, ports);
        expect(snap.hosting!.processLog).toEqual({ processId: 'p1', text: 'all of it', lines: 1, dropped: 0 });
        const closed: Record<string, unknown> = {};
        await applyHostingFeatureAction(services, { kind: 'hosting.closeProcessLog' }, next as never, closed as never, ports);
        expect((await hostingFeatureSnapshot(services, closed as never, ports)).hosting!.processLog ?? null).toBeNull();
    });
});

describe('a flow run opens in its run review (Tynn #860)', () => {
    it('genie://flow/<id>?run=<n> names the run; the flow\'s window is the same window whichever run it shows', () => {
        expect(parseRoute('genie://flow/flow_a?run=2')).toMatchObject({ surface: 'flow', flowId: 'flow_a', run: 2 });
        expect(parseRoute('genie://flow/flow_a')).toMatchObject({ surface: 'flow', flowId: 'flow_a', run: null });
        expect(sameFlowWindow('app://index.html#genie://flow/flow_a', 'genie://flow/flow_a?run=2')).toBe(true);
        expect(sameFlowWindow('app://index.html#genie://flow/flow_a?run=1', 'genie://flow/flow_a')).toBe(true);
        expect(sameFlowWindow('app://index.html#genie://flow/flow_ab', 'genie://flow/flow_a')).toBe(false);
    });
});
