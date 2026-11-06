import { describe, expect, it } from 'vitest';
import { shutDownHosted } from '../src/main/host-shutdown.js';
import type { KeptProcess } from '../src/main/process-book.js';
import { ProcessScheduler } from '../src/main/process-scheduler.js';
import type { ProcessSpec, ProcessStatus, SupervisorApi } from '../src/main/process-supervisor.js';

/**
 * P5a.3, decision 2: "SHUT DOWN EVERYTHING" STARTS NOTHING NEW. genie-host's clocks — the process scheduler (scheduled
 * tasks) and the flows engine — are stopped BEFORE the supervised processes are, so a task that falls due during the
 * shutdown does not start one more process after the stops (and nothing is armed again). CONTROL: the same scheduler,
 * not stopped, starts it.
 */

const task = { id: 'task:nightly', workspaceId: 'ws', name: 'nightly', command: 'backup', cwd: '/w', wanted: true, schedule: { kind: 'command', cron: '* * * * *' } } as unknown as KeptProcess;

function clock() {
    const armed: Array<() => void> = [];
    const started: string[] = [];
    const scheduler = new ProcessScheduler({
        book: { scheduledTasks: () => [task], recordScheduledRun: async () => {}, onChange: () => () => {} },
        supervisor: {
            start: (spec: ProcessSpec) => { started.push(spec.id); return { id: spec.id, workspaceId: spec.workspaceId, name: spec.name, state: 'running', pid: 1, exitCode: null, restarts: 0, since: 0, reason: null } as unknown as ProcessStatus; },
            status: () => null,
            onChange: () => () => {},
        },
        envFor: () => ({}),
        asleep: () => false,
        nudge: () => false,
        now: () => 0,
        // The timer is kept, and fired by the test: "the task falls due" at a moment the test chooses.
        schedule: (fn) => { armed.push(fn); return () => {}; },
    });
    return { scheduler, armed, started };
}

const noProcesses = { list: () => [], stop: () => true } as unknown as SupervisorApi;

describe('a task falling due during "Shut down everything"', () => {
    it('does not start: the scheduler is stopped first, and nothing is armed again', async () => {
        const c = clock();
        c.scheduler.plan();
        expect(c.armed).toHaveLength(1);
        await shutDownHosted({ supervisor: noProcesses, hosting: null, endChildren: async () => {}, schedulers: [c.scheduler] });
        c.armed[0]!(); // it falls due now, mid-shutdown
        expect(c.started).toEqual([]);
        c.scheduler.plan();
        expect(c.armed).toHaveLength(1);
        expect(await c.scheduler.runNow(task.id)).toBe('held');
        expect(c.started).toEqual([]);
    });

    it('CONTROL: the same scheduler, not stopped, starts it when it falls due', () => {
        const c = clock();
        c.scheduler.plan();
        c.armed[0]!();
        expect(c.started).toEqual([task.id]);
    });
});
