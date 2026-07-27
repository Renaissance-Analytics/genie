import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Host-layer scheduler tests (story #227). A scheduled task is a `terminal_specs`
 * process spec carrying `meta.schedule`; the scheduler arms ONE timer to the next
 * occurrence, runs the spec, then re-arms — never a polling interval.
 *
 * The module boundaries are mocked exactly like process-restart.test.ts (electron,
 * fancy-term-host, db, adapters) plus the AgentInbox broker, so the assertions are
 * about scheduling behaviour and nothing else. Fake timers drive the clock, so a
 * "tomorrow at 03:00" schedule is exercised in microseconds.
 */

const created: string[] = [];
const killed: string[] = [];
/** Nudges the broker was asked to deliver: [terminalId, text]. */
const nudged: Array<[string, string]> = [];
let deliverReturns = true;

type Spec = {
    id: string;
    workspace_id: string | null;
    label: string;
    type: string;
    cwd: string;
    shell: string;
    enabled?: boolean;
    meta: Record<string, unknown>;
};
const specs = new Map<string, Spec>();

function seedTask(id: string, meta: Record<string, unknown>, enabled = true): void {
    specs.set(id, {
        id,
        workspace_id: 'ws-1',
        label: id,
        type: 'process',
        cwd: '/ws',
        shell: '/usr/bin/bash',
        enabled,
        meta: { command: 'npm run nightly', ...meta },
    });
}

vi.mock('electron', () => ({
    BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('@particle-academy/fancy-term-host', () => ({
    terminalManager: () => ({
        create: (opts: { id: string }) => {
            created.push(opts.id);
            return { id: opts.id, pid: 1, shell: 'bash' };
        },
        kill: (id: string) => {
            killed.push(id);
            return true;
        },
    }),
    resolveDefaultShell: () => ({ command: '/usr/bin/bash', args: [] }),
}));
vi.mock('../../db', () => ({
    getTerminalSpec: (id: string) => specs.get(id) ?? null,
    listTerminalSpecs: () => [...specs.values()],
    updateTerminalSpec: (id: string, patch: { meta?: Record<string, unknown> }) => {
        const s = specs.get(id);
        if (s && patch.meta) s.meta = { ...patch.meta };
    },
}));
vi.mock('../genie-adapter', () => ({ dbSettingsProvider: () => ({}) }));
vi.mock('../../agentinbox/broker', () => ({
    agentInboxBroker: {
        deliverHumanMessageToTerminal: (terminalId: string, text: string) => {
            nudged.push([terminalId, text]);
            return deliverReturns;
        },
        getInfo: (agentId: string) =>
            agentId === 'agent-known' ? { agentId, terminalId: 'term-of-agent' } : null,
    },
}));

import { onProcessPtyExit } from '../process-supervisor';
import {
    armSchedule,
    disarmSchedule,
    forgetSchedule,
    nextRunAt,
    runScheduleNow,
    startSchedules,
} from '../process-scheduler';

/** Local-time literal (month 1-based) so fixtures read like wall-clock time. */
function local(y: number, mo: number, d: number, h = 0, mi = 0): Date {
    return new Date(y, mo - 1, d, h, mi, 0, 0);
}

/** Finish the in-flight pty run of `id` with `exitCode` (the ipc.ts exit hook). */
function finishRun(id: string, exitCode = 0): void {
    onProcessPtyExit(id, { exitCode });
}

beforeEach(() => {
    created.length = 0;
    killed.length = 0;
    nudged.length = 0;
    deliverReturns = true;
    specs.clear();
    vi.useFakeTimers();
    vi.setSystemTime(local(2026, 7, 24, 10, 0));
});

afterEach(() => {
    for (const id of specs.keys()) forgetSchedule(id);
    vi.useRealTimers();
});

describe('armSchedule — one timer to the next occurrence', () => {
    it('does not run on arm; fires at the next occurrence, then re-arms for the one after', () => {
        seedTask('t1', { schedule: '*/5 * * * *' });
        armSchedule('t1');
        expect(created).toEqual([]); // arming is not running
        expect(nextRunAt('t1')).toBe(local(2026, 7, 24, 10, 5).getTime());

        vi.advanceTimersByTime(5 * 60_000); // → 10:05
        expect(created).toEqual(['t1']);
        finishRun('t1');
        // Re-armed for the FOLLOWING occurrence, not left dangling.
        expect(nextRunAt('t1')).toBe(local(2026, 7, 24, 10, 10).getTime());

        vi.advanceTimersByTime(5 * 60_000); // → 10:10
        expect(created).toEqual(['t1', 't1']);
    });

    it('refuses to arm an invalid expression (no timer, no next run)', () => {
        seedTask('bad', { schedule: 'every tuesday-ish' });
        armSchedule('bad');
        expect(nextRunAt('bad')).toBeNull();
        vi.advanceTimersByTime(24 * 60 * 60_000);
        expect(created).toEqual([]);
    });

    it('refuses to arm a spec still pending approval', () => {
        seedTask('pending', { schedule: '*/5 * * * *', schedule_pending_approval: true }, false);
        armSchedule('pending');
        expect(nextRunAt('pending')).toBeNull();
        vi.advanceTimersByTime(60 * 60_000);
        expect(created).toEqual([]);
    });

    it('disarmSchedule cancels the pending fire', () => {
        seedTask('t2', { schedule: '*/5 * * * *' });
        armSchedule('t2');
        disarmSchedule('t2');
        expect(nextRunAt('t2')).toBeNull();
        vi.advanceTimersByTime(10 * 60_000);
        expect(created).toEqual([]);
    });

    it('re-arming an already-armed spec replaces the timer rather than stacking one', () => {
        seedTask('t3', { schedule: '*/5 * * * *' });
        armSchedule('t3');
        armSchedule('t3');
        armSchedule('t3');
        vi.advanceTimersByTime(5 * 60_000);
        expect(created).toEqual(['t3']); // one fire, not three
    });
});

describe('run tracking', () => {
    it('records last_run_at + last_run_status=ok for a clean exit', () => {
        seedTask('r1', { schedule: '*/5 * * * *' });
        armSchedule('r1');
        vi.advanceTimersByTime(5 * 60_000);
        expect(specs.get('r1')!.meta.last_run_at).toBe(local(2026, 7, 24, 10, 5).getTime());
        finishRun('r1', 0);
        expect(specs.get('r1')!.meta.last_run_status).toBe('ok');
    });

    it('records last_run_status=failed for a non-zero exit', () => {
        seedTask('r2', { schedule: '*/5 * * * *' });
        armSchedule('r2');
        vi.advanceTimersByTime(5 * 60_000);
        finishRun('r2', 1);
        expect(specs.get('r2')!.meta.last_run_status).toBe('failed');
    });

    it('a scheduled run does NOT auto-restart on a crash exit — the schedule drives the next run', () => {
        // restart_on_exit is the process default (true); a scheduled task must
        // ignore it, or a failing nightly job would hot-loop until the next fire.
        seedTask('r3', { schedule: '0 3 * * *', restart_on_exit: true });
        armSchedule('r3');
        vi.advanceTimersByTime(17 * 60 * 60_000); // → tomorrow 03:00
        expect(created).toEqual(['r3']);
        finishRun('r3', 1);
        vi.advanceTimersByTime(60 * 60_000); // an hour of backoff windows
        expect(created).toEqual(['r3']); // still exactly one run
    });

    it('never persists was_running for a scheduled task (it must not restore as a service)', () => {
        seedTask('r4', { schedule: '*/5 * * * *' });
        armSchedule('r4');
        vi.advanceTimersByTime(5 * 60_000);
        expect(specs.get('r4')!.meta.was_running).toBeUndefined();
    });
});

describe('overlap — a fire while the previous run is still in flight is SKIPPED', () => {
    it('skips the occurrence and records last_run_status=skipped, without killing the live run', () => {
        seedTask('o1', { schedule: '*/5 * * * *' });
        armSchedule('o1');
        vi.advanceTimersByTime(5 * 60_000); // 10:05 — starts, never finishes
        expect(created).toEqual(['o1']);

        vi.advanceTimersByTime(5 * 60_000); // 10:10 — previous run still live
        expect(created).toEqual(['o1']); // NOT spawned a second time
        expect(specs.get('o1')!.meta.last_run_status).toBe('skipped');
        expect(killed).toEqual([]); // the live run is left alone

        // Still armed: once the long run finishes, the next occurrence runs.
        finishRun('o1');
        vi.advanceTimersByTime(5 * 60_000); // 10:15
        expect(created).toEqual(['o1', 'o1']);
    });
});

describe('missed runs — the Host was down at fire time', () => {
    it('computes the next fire FORWARD from now instead of catching up', () => {
        // Daily 03:00; the Host boots at 10:00, seven hours past today's fire.
        seedTask('m1', { schedule: '0 3 * * *', last_run_at: local(2026, 7, 20, 3, 0).getTime() });
        armSchedule('m1');
        expect(created).toEqual([]); // no catch-up run on arm
        expect(nextRunAt('m1')).toBe(local(2026, 7, 25, 3, 0).getTime());

        vi.advanceTimersByTime(17 * 60 * 60_000); // → tomorrow 03:00
        expect(created).toEqual(['m1']);
    });
});

describe('startSchedules — survives an app restart', () => {
    it('arms every enabled, approved scheduled spec on launch and skips the rest', () => {
        seedTask('boot-armed', { schedule: '0 3 * * *' });
        seedTask('boot-disabled', { schedule: '0 3 * * *' }, false);
        seedTask('boot-pending', { schedule: '0 3 * * *', schedule_pending_approval: true }, false);
        seedTask('boot-plain', {}); // an ordinary process — the supervisor's job
        seedTask('boot-bad', { schedule: 'nonsense' });

        startSchedules();

        expect(nextRunAt('boot-armed')).toBe(local(2026, 7, 25, 3, 0).getTime());
        expect(nextRunAt('boot-disabled')).toBeNull();
        expect(nextRunAt('boot-pending')).toBeNull();
        expect(nextRunAt('boot-plain')).toBeNull();
        expect(nextRunAt('boot-bad')).toBeNull();

        // And the armed one really fires after the restart.
        vi.advanceTimersByTime(17 * 60 * 60_000);
        expect(created).toEqual(['boot-armed']);
    });
});

describe('agent-nudge kind', () => {
    it('delivers the prompt to the target terminal instead of spawning a pty', () => {
        seedTask('n1', {
            schedule: '0 9 * * *',
            schedule_kind: 'agent-nudge',
            nudge_target_terminal_id: 'term-7',
            nudge_prompt: 'Sweep the IssueWatch feed and report.',
        });
        armSchedule('n1');
        vi.advanceTimersByTime(23 * 60 * 60_000); // → tomorrow 09:00

        expect(created).toEqual([]); // no process spawned
        expect(nudged).toEqual([['term-7', 'Sweep the IssueWatch feed and report.']]);
        expect(specs.get('n1')!.meta.last_run_status).toBe('ok');
        expect(specs.get('n1')!.meta.last_run_at).toBe(local(2026, 7, 25, 9, 0).getTime());
    });

    it('resolves an agent id to its terminal', () => {
        seedTask('n2', {
            schedule: '0 9 * * *',
            schedule_kind: 'agent-nudge',
            nudge_agent_id: 'agent-known',
            nudge_prompt: 'stand-up',
        });
        armSchedule('n2');
        vi.advanceTimersByTime(23 * 60 * 60_000);
        expect(nudged).toEqual([['term-of-agent', 'stand-up']]);
    });

    it('records failed when the target has no registered agent, and stays armed', () => {
        deliverReturns = false;
        seedTask('n3', {
            schedule: '0 9 * * *',
            schedule_kind: 'agent-nudge',
            nudge_target_terminal_id: 'term-gone',
            nudge_prompt: 'ping',
        });
        armSchedule('n3');
        vi.advanceTimersByTime(23 * 60 * 60_000);
        expect(specs.get('n3')!.meta.last_run_status).toBe('failed');
        // A failed nudge must not disarm the task — tomorrow it tries again.
        expect(nextRunAt('n3')).toBe(local(2026, 7, 26, 9, 0).getTime());
    });

    it('records failed (and nudges nothing) when the prompt or target is missing', () => {
        seedTask('n4', { schedule: '0 9 * * *', schedule_kind: 'agent-nudge' });
        armSchedule('n4');
        vi.advanceTimersByTime(23 * 60 * 60_000);
        expect(nudged).toEqual([]);
        expect(specs.get('n4')!.meta.last_run_status).toBe('failed');
    });
});

describe('runScheduleNow — the run-now button', () => {
    it('runs immediately and leaves the arm intact', () => {
        seedTask('now1', { schedule: '0 3 * * *' });
        armSchedule('now1');
        const armed = nextRunAt('now1');

        runScheduleNow('now1');
        expect(created).toEqual(['now1']);
        expect(nextRunAt('now1')).toBe(armed); // the schedule is untouched
        finishRun('now1');
        expect(specs.get('now1')!.meta.last_run_status).toBe('ok');
    });

    it('is skipped (not overlapped) while a run is in flight', () => {
        seedTask('now2', { schedule: '0 3 * * *' });
        runScheduleNow('now2');
        runScheduleNow('now2');
        expect(created).toEqual(['now2']);
        expect(specs.get('now2')!.meta.last_run_status).toBe('skipped');
    });
});
