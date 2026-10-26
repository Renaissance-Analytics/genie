import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProcessBook } from '../src/main/process-book.js';
import { ProcessScheduler } from '../src/main/process-scheduler.js';
import type { ProcessSpec, ProcessStatus } from '../src/main/process-supervisor.js';

/**
 * A SCHEDULED TASK IS A BACKGROUND PROCESS WITH A SCHEDULE (the owner, 2026-10-26: "a scheduled command is a BG Process in
 * a workspace, just with a schedule"). Genie 1's model, ported (main/terminal/process-scheduler.ts at v0.7.0-beta.342):
 * - a kept process that carries a five-field cron, evaluated in this machine's local time; `command` runs the process,
 *   `agent-nudge` hands a prompt to an agent (never into a live turn);
 * - ONE-SHOT per fire: no restart policy, never brought back at launch as a running process — the schedule decides;
 * - enabled ("Scheduled") or paused ("Paused — not firing"); Run now runs it either way (not in a sleeping workspace);
 * - overlap guard: a run still going at the next fire is SKIPPED, not doubled;
 * - each run's outcome kept: ok / failed / skipped, and when;
 * - missed runs are not caught up — the next fire is always forward from now.
 */

const WS = { id: 'ws-example', path: resolve(tmpdir(), 'genie2-sched-ws') };

function fakeSupervisor() {
    const started: ProcessSpec[] = [];
    const statuses = new Map<string, ProcessStatus>();
    const listeners = new Set<(s: ProcessStatus) => void>();
    const set = (s: ProcessStatus) => { statuses.set(s.id, s); for (const l of listeners) l(s); };
    return {
        started,
        exit: (id: string, code: number) => set({ ...statuses.get(id)!, state: 'exited', exitCode: code, pid: null }),
        start: (spec: ProcessSpec): ProcessStatus => { started.push(spec); const s: ProcessStatus = { id: spec.id, workspaceId: spec.workspaceId, name: spec.name, state: 'running', pid: 4242, exitCode: null, restarts: 0, since: 0 }; set(s); return s; },
        stop: (id: string) => { const s = statuses.get(id); if (s) set({ ...s, state: 'stopped', pid: null }); return true; },
        forget: (id: string) => statuses.delete(id),
        list: (workspaceId?: string) => [...statuses.values()].filter((s) => workspaceId === undefined || s.workspaceId === workspaceId),
        status: (id: string) => statuses.get(id) ?? null,
        onChange: (l: (s: ProcessStatus) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    };
}

let home: string;
let sup: ReturnType<typeof fakeSupervisor>;
let book: ProcessBook;
let asleep = false;
const NOW = new Date(2026, 9, 26, 2, 0, 0).getTime();
let now = NOW;
const timers: Array<{ fn: () => void; at: number }> = [];
const nudges: Array<[string, string, string]> = [];
let nudgeOk = true;

function scheduler() {
    return new ProcessScheduler({
        book,
        supervisor: sup,
        envFor: () => ({}),
        asleep: () => asleep,
        nudge: (agent, text, from) => { nudges.push([agent, text, from]); return nudgeOk; },
        now: () => now,
        schedule: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return () => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); }; },
    });
}

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'genie2-sched-'));
    sup = fakeSupervisor();
    asleep = false;
    now = NOW;
    timers.length = 0;
    nudges.length = 0;
    nudgeOk = true;
    book = await ProcessBook.open(home, { supervisor: sup, envFor: () => ({}), asleep: () => asleep });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const nightly = { workspaceId: WS.id, workspacePath: WS.path, name: 'nightly report', command: 'npm run report', folder: 'repos/app', restart: 'never' as const, schedule: { cron: '0 3 * * *', kind: 'command' as const } };

describe('a scheduled background process', () => {
    it('is kept with its schedule and NOT started when it is added; a launch does not start it either', async () => {
        const added = await book.create(nightly);
        expect(sup.started).toEqual([]);
        const row = book.list(WS.id).find((p) => p.id === added.id)!;
        expect(row).toMatchObject({ name: 'nightly report', state: 'stopped', command: 'npm run report', schedule: { cron: '0 3 * * *', kind: 'command', enabled: true } });
        expect(book.restore().started).toEqual([]);
        expect(sup.started).toEqual([]);
    });

    it('fires at its time as a ONE-SHOT run of its command in its folder, and keeps the outcome', async () => {
        const added = await book.create(nightly);
        const s = scheduler();
        s.plan();
        expect(timers.map((t) => new Date(t.at).getHours())).toEqual([3]);
        now = timers[0]!.at;
        timers[0]!.fn();
        expect(sup.started).toEqual([expect.objectContaining({ id: added.id, command: 'npm run report', cwd: join(WS.path, 'repos/app'), restart: 'never' })]);
        sup.exit(added.id, 0);
        await s.settled();
        expect(book.list(WS.id).find((p) => p.id === added.id)!.schedule).toMatchObject({ lastRunStatus: 'ok', lastRunAt: now });
        // Re-armed for the next night, forward from now.
        expect(timers).toHaveLength(1);
        expect(timers[0]!.at).toBeGreaterThan(now);
    });

    it('a non-zero exit is a failed run', async () => {
        const added = await book.create(nightly);
        const s = scheduler();
        await s.runNow(added.id);
        sup.exit(added.id, 2);
        await s.settled();
        expect(book.list(WS.id).find((p) => p.id === added.id)!.schedule?.lastRunStatus).toBe('failed');
    });

    it('paused, it does not fire; Enable schedule arms it; Pause schedule disarms it — and Run now still runs it', async () => {
        const added = await book.create(nightly);
        const s = scheduler();
        await book.pauseSchedule(added.id);
        s.plan();
        expect(timers).toEqual([]);
        expect(book.list(WS.id)[0]!.schedule?.enabled).toBe(false);
        await book.enableSchedule(added.id);
        s.plan();
        expect(timers).toHaveLength(1);
        await book.pauseSchedule(added.id);
        s.plan();
        expect(timers).toEqual([]);
        await s.runNow(added.id);
        expect(sup.started).toHaveLength(1);
    });

    it('OVERLAP: a run still going when the next is due is SKIPPED, never doubled', async () => {
        const added = await book.create(nightly);
        const s = scheduler();
        await s.runNow(added.id);
        expect(await s.runNow(added.id)).toBe('skipped');
        expect(sup.started).toHaveLength(1);
        expect(book.list(WS.id)[0]!.schedule?.lastRunStatus).toBe('skipped');
    });

    it('a sleeping workspace fires nothing and runs nothing, not even Run now', async () => {
        const added = await book.create(nightly);
        asleep = true;
        const s = scheduler();
        s.plan();
        expect(timers).toEqual([]);
        expect(await s.runNow(added.id)).toBe('held');
        expect(sup.started).toEqual([]);
    });

    it('AGENT NUDGE: each fire hands the prompt to the agent, as the task (never into a live turn — delivery waits for the turn to end)', async () => {
        const added = await book.create({ workspaceId: WS.id, workspacePath: WS.path, name: 'standup', command: '', restart: 'never', schedule: { cron: '0 9 * * 1-5', kind: 'agent-nudge', prompt: 'post the standup', agent: 'ws-example:claude:atlas' } });
        const s = scheduler();
        expect(await s.runNow(added.id)).toBe('ok');
        expect(nudges).toEqual([['ws-example:claude:atlas', 'post the standup', 'standup']]);
        expect(sup.started).toEqual([]);
        nudgeOk = false;
        expect(await s.runNow(added.id)).toBe('failed');
    });

    it('refuses what could never run: an unreadable schedule, a nudge with no prompt or no agent — nothing kept', async () => {
        await expect(book.create({ ...nightly, schedule: { cron: 'every day', kind: 'command' } })).rejects.toThrow(/not a schedule Genie can evaluate/);
        await expect(book.create({ ...nightly, command: '', schedule: { cron: '0 9 * * *', kind: 'agent-nudge', agent: 'atlas' } })).rejects.toThrow(/prompt/);
        await expect(book.create({ ...nightly, command: '', schedule: { cron: '0 9 * * *', kind: 'agent-nudge', prompt: 'hi' } })).rejects.toThrow(/agent/);
        expect(book.kept()).toEqual([]);
    });

    it('survives a restart: the schedule and its state are on disk', async () => {
        const added = await book.create(nightly);
        await book.pauseSchedule(added.id);
        const again = await ProcessBook.open(home, { supervisor: sup, envFor: () => ({}), asleep: () => false });
        expect(again.kept()[0]).toMatchObject({ id: added.id, wanted: false, schedule: { cron: '0 3 * * *', kind: 'command' } });
    });
});
