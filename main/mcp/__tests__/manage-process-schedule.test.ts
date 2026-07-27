import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The manageProcess MCP tool's SCHEDULED-TASK surface (story #227).
 *
 * A scheduled task IS a process with a schedule, so it rides the SAME tool — no
 * second tool to discover, no second mental model. What's new here is the third
 * approval gate: `schedule_approval` mirrors `process_approval` exactly (same
 * default-on column, same forceQuestion modal, same deny-means-nothing-happens),
 * because an agent arming a recurring unattended job deserves at least the
 * scrutiny of it starting a one-off one.
 */

type Spec = {
    id: string;
    workspace_id: string | null;
    label: string;
    cwd: string;
    type: string;
    enabled?: boolean;
    meta: Record<string, unknown>;
};

const specs = new Map<string, Spec>();
const armed: string[] = [];
const disarmed: string[] = [];
const forgotten: string[] = [];
const ranNow: string[] = [];
/** Questions raised through forceQuestion, so a test can assert what the user saw. */
const asked: Array<{ header: string; question: string }> = [];

let scheduleApproval = true;
let processApproval = false;
/** What the user "clicks" on the next forceQuestion. */
let answer: 'Approve' | 'Deny' | 'cancel' = 'Approve';
/** Runs at the moment the modal is raised — lets a test inspect the in-flight state. */
let answerHook: (() => void) | null = null;

const WS = {
    id: 'ws-1',
    path: '/ws',
    project_name: 'Demo',
};

vi.mock('electron', () => ({
    BrowserWindow: { getAllWindows: () => [] },
    app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', on: () => {} },
    ipcMain: { handle: () => {}, on: () => {} },
    shell: { openExternal: () => {} },
}));

vi.mock('../../db', () => ({
    listWorkspaces: () => [WS],
    getWorkspace: (id: string) => (id === WS.id ? WS : undefined),
    listTerminalSpecs: () => [...specs.values()],
    getTerminalSpec: (id: string) => specs.get(id) ?? null,
    createTerminalSpec: (input: Spec) => {
        const row = { enabled: true, ...input };
        specs.set(input.id, row);
        return row;
    },
    updateTerminalSpec: (id: string, patch: Partial<Spec>) => {
        const s = specs.get(id);
        if (!s) return null;
        Object.assign(s, patch);
        return s;
    },
    deleteTerminalSpec: (id: string) => specs.delete(id),
    workspaceProcessApproval: () => processApproval,
    workspaceTerminalApproval: () => true,
    workspaceScheduleApproval: () => scheduleApproval,
    getAllSettings: () => ({}),
    getWorkspaceIssuewatchPolicyBuckets: () => ({}),
    removeWorkspace: () => {},
}));

vi.mock('../../ask/force-question', () => ({
    forceQuestion: async (questions: Array<{ header: string; question: string }>) => {
        asked.push({ header: questions[0].header, question: questions[0].question });
        answerHook?.();
        if (answer === 'cancel') return { cancelled: true, answers: [] };
        return { cancelled: false, answers: [{ selected: [answer] }] };
    },
}));

vi.mock('../../terminal/process-scheduler', () => ({
    armSchedule: (id: string) => armed.push(id),
    disarmSchedule: (id: string) => disarmed.push(id),
    forgetSchedule: (id: string) => forgotten.push(id),
    runScheduleNow: (id: string) => ranNow.push(id),
    nextRunAt: (id: string) => (id === 'sched-1' ? Date.parse('2026-07-25T03:00:00Z') : null),
}));

vi.mock('../../terminal/process-supervisor', () => ({
    startProcess: vi.fn(),
    stopProcess: vi.fn(),
    restartProcess: vi.fn(),
    forgetProcess: vi.fn(),
    getProcessStatuses: () => ({}),
}));

vi.mock('../../terminal/ipc', () => ({
    broadcastTerminalSpecsChanged: vi.fn(),
    killTerminalById: vi.fn(),
    createAgentTerminal: vi.fn(),
    writeToTerminal: vi.fn(),
    readTerminalOutput: vi.fn(),
    agentSessionTranscriptExists: vi.fn(),
}));

vi.mock('../../workspace/detect', () => ({
    detectFolder: () => ({ repos: ['genie'] }),
}));

vi.mock('../../ipc', () => ({
    broadcastWorkspacesChanged: vi.fn(),
}));

// Several of host-tools' imports reach main/tray.ts, which imports background.ts
// and runs the Electron app bootstrap (requestSingleInstanceLock) at MODULE LOAD.
// Cutting the chain here keeps the test about manageProcess.
vi.mock('../../tray', () => ({
    rebuildMenu: vi.fn(),
    createTray: vi.fn(),
    setInboxBadge: vi.fn(),
    setUpdateAvailable: vi.fn(),
}));

import { manageProcessForMcp } from '../host-tools';

function seedCaller(): void {
    specs.set('term-1', {
        id: 'term-1',
        workspace_id: WS.id,
        label: 'agent',
        cwd: '/ws',
        type: 'terminal',
        meta: {},
    });
}

function task(id: string, meta: Record<string, unknown>, enabled = true): void {
    specs.set(id, {
        id,
        workspace_id: WS.id,
        label: id,
        cwd: '/ws',
        type: 'process',
        enabled,
        meta,
    });
}

/** The scheduled task specs currently in the store. */
function scheduled(): Spec[] {
    return [...specs.values()].filter((s) => s.type === 'process' && s.meta.schedule);
}

beforeEach(() => {
    specs.clear();
    armed.length = 0;
    disarmed.length = 0;
    forgotten.length = 0;
    ranNow.length = 0;
    asked.length = 0;
    scheduleApproval = true;
    processApproval = false;
    answer = 'Approve';
    answerHook = null;
    seedCaller();
});

describe('create with a schedule — the approval gate mirrors process_approval', () => {
    it('asks the user, and on approve ENABLES + ARMS the task', async () => {
        const res = await manageProcessForMcp('term-1', {
            action: 'create',
            label: 'Nightly build',
            command: 'npm run build',
            schedule: '0 3 * * *',
        });

        expect(res.ok).toBe(true);
        expect(asked).toHaveLength(1);
        // The user must see the RECURRENCE, not just the command — that is the
        // whole difference from a one-off process approval.
        expect(asked[0].question).toContain('0 3 * * *');
        expect(asked[0].question).toContain('Daily at 03:00');
        expect(asked[0].question).toContain('npm run build');

        const created = scheduled();
        expect(created).toHaveLength(1);
        expect(created[0].enabled).toBe(true);
        expect(created[0].meta.schedule_pending_approval).toBeFalsy();
        expect(armed).toEqual([created[0].id]);
    });

    it('the task EXISTS (disabled + pending) while the modal is up, so the user can see it', async () => {
        // The spec is created before the question so a headless/deferred approval
        // leaves a visible record instead of vanishing. Disabled + flagged means
        // startSchedules() will never arm it while it waits.
        // SNAPSHOT the values — the spec object is mutated in place when the
        // approval lands, so holding the reference would observe the final state
        // rather than the in-flight one this test is about.
        let seen: { enabled?: boolean; pending: unknown; armedSoFar: number } | undefined;
        answerHook = () => {
            const s = scheduled()[0];
            if (s) {
                seen = {
                    enabled: s.enabled,
                    pending: s.meta.schedule_pending_approval,
                    armedSoFar: armed.length,
                };
            }
        };
        await manageProcessForMcp('term-1', {
            action: 'create',
            label: 'Nightly build',
            command: 'npm run build',
            schedule: '0 3 * * *',
        });
        expect(seen).toBeDefined();
        expect(seen!.enabled).toBe(false);
        expect(seen!.pending).toBe(true);
        // …and nothing was armed while it sat pending.
        expect(seen!.armedSoFar).toBe(0);
    });

    it('on DENY removes the spec and arms nothing', async () => {
        answer = 'Deny';
        const res = await manageProcessForMcp('term-1', {
            action: 'create',
            label: 'Nightly build',
            command: 'npm run build',
            schedule: '0 3 * * *',
        });

        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/denied/i);
        expect(scheduled()).toHaveLength(0);
        expect(armed).toEqual([]);
    });

    it('treats a DISMISSED modal as a deny (never arms on dismissal)', async () => {
        answer = 'cancel';
        const res = await manageProcessForMcp('term-1', {
            action: 'create',
            label: 'Nightly build',
            command: 'npm run build',
            schedule: '0 3 * * *',
        });
        expect(res.ok).toBe(false);
        expect(scheduled()).toHaveLength(0);
        expect(armed).toEqual([]);
    });

    it('arms directly, with NO question, when the workspace has the gate turned off', async () => {
        scheduleApproval = false;
        const res = await manageProcessForMcp('term-1', {
            action: 'create',
            label: 'Nightly build',
            command: 'npm run build',
            schedule: '0 3 * * *',
        });
        expect(res.ok).toBe(true);
        expect(asked).toEqual([]);
        expect(armed).toHaveLength(1);
        expect(scheduled()[0].enabled).toBe(true);
    });

    it('a scheduled create is gated by schedule_approval, NOT by process_approval', async () => {
        // Loosened process approval must not loosen the schedule gate.
        processApproval = false;
        scheduleApproval = true;
        await manageProcessForMcp('term-1', {
            action: 'create',
            label: 'Nightly',
            command: 'npm run build',
            schedule: '0 3 * * *',
        });
        expect(asked).toHaveLength(1);
        expect(asked[0].header).toMatch(/schedul/i);
    });

    it('rejects an invalid cron expression before creating anything', async () => {
        const res = await manageProcessForMcp('term-1', {
            action: 'create',
            label: 'Broken',
            command: 'npm run build',
            schedule: 'every other tuesday',
        });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/schedule/i);
        expect(asked).toEqual([]); // never bother the user with a broken expression
        expect(scheduled()).toHaveLength(0);
    });

    it('creates an agent-nudge task from the nudge payload', async () => {
        scheduleApproval = false;
        const res = await manageProcessForMcp('term-1', {
            action: 'create',
            label: 'Morning sweep',
            schedule: '0 9 * * 1-5',
            scheduleKind: 'agent-nudge',
            nudgeTerminalId: 'term-1',
            prompt: 'Review overnight IssueWatch deltas.',
        });
        expect(res.ok).toBe(true);
        const t = scheduled()[0];
        expect(t.meta.schedule_kind).toBe('agent-nudge');
        expect(t.meta.nudge_target_terminal_id).toBe('term-1');
        expect(t.meta.nudge_prompt).toBe('Review overnight IssueWatch deltas.');
        // A nudge needs no command — requiring one would be a paper cut.
        expect(t.meta.command).toBeUndefined();
    });

    it('rejects an agent-nudge task with no prompt', async () => {
        scheduleApproval = false;
        const res = await manageProcessForMcp('term-1', {
            action: 'create',
            label: 'Empty nudge',
            schedule: '0 9 * * *',
            scheduleKind: 'agent-nudge',
            nudgeTerminalId: 'term-1',
        });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/prompt/i);
        expect(scheduled()).toHaveLength(0);
    });

    it('still requires a command for a plain (unscheduled) process', async () => {
        const res = await manageProcessForMcp('term-1', { action: 'create', label: 'x' });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/command/i);
    });
});

describe('list — a scheduled task reports its schedule and run history', () => {
    it('carries schedule, human description, next run and last-run tracking', async () => {
        task('sched-1', {
            command: 'npm run build',
            schedule: '0 3 * * *',
            schedule_kind: 'command',
            last_run_at: Date.parse('2026-07-24T03:00:00Z'),
            last_run_status: 'ok',
        });
        const res = await manageProcessForMcp('term-1', { action: 'list' });
        const row = res.processes.find((p) => p.id === 'sched-1')!;

        expect(row.schedule).toBe('0 3 * * *');
        expect(row.scheduleDescription).toBe('Daily at 03:00');
        expect(row.scheduleKind).toBe('command');
        expect(row.nextRunAt).toBe(new Date(Date.parse('2026-07-25T03:00:00Z')).toISOString());
        expect(row.lastRunAt).toBe(new Date(Date.parse('2026-07-24T03:00:00Z')).toISOString());
        expect(row.lastRunStatus).toBe('ok');
        expect(row.enabled).toBe(true);
    });

    it('leaves the schedule fields off an ordinary process', async () => {
        task('plain-1', { command: 'npm run dev' });
        const res = await manageProcessForMcp('term-1', { action: 'list' });
        const row = res.processes.find((p) => p.id === 'plain-1')!;
        expect(row.schedule).toBeUndefined();
        expect(row.nextRunAt).toBeUndefined();
    });
});

describe('enable / disable / delete / run-now', () => {
    it('disable turns the task off and disarms it', async () => {
        task('sched-1', { command: 'x', schedule: '0 3 * * *' });
        const res = await manageProcessForMcp('term-1', { action: 'disable', id: 'sched-1' });
        expect(res.ok).toBe(true);
        expect(specs.get('sched-1')!.enabled).toBe(false);
        expect(disarmed).toEqual(['sched-1']);
    });

    it('enable turns it back on and re-arms it', async () => {
        task('sched-1', { command: 'x', schedule: '0 3 * * *' }, false);
        const res = await manageProcessForMcp('term-1', { action: 'enable', id: 'sched-1' });
        expect(res.ok).toBe(true);
        expect(specs.get('sched-1')!.enabled).toBe(true);
        expect(armed).toEqual(['sched-1']);
    });

    it('delete removes the spec and forgets its timer', async () => {
        task('sched-1', { command: 'x', schedule: '0 3 * * *' });
        const res = await manageProcessForMcp('term-1', { action: 'delete', id: 'sched-1' });
        expect(res.ok).toBe(true);
        expect(specs.has('sched-1')).toBe(false);
        expect(forgotten).toEqual(['sched-1']);
    });

    it('run-now fires the task immediately without touching the schedule', async () => {
        task('sched-1', { command: 'x', schedule: '0 3 * * *' });
        const res = await manageProcessForMcp('term-1', { action: 'run-now', id: 'sched-1' });
        expect(res.ok).toBe(true);
        expect(ranNow).toEqual(['sched-1']);
        expect(disarmed).toEqual([]);
    });

    it('run-now refuses a process that has no schedule', async () => {
        task('plain-1', { command: 'npm run dev' });
        const res = await manageProcessForMcp('term-1', { action: 'run-now', id: 'plain-1' });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/schedule/i);
        expect(ranNow).toEqual([]);
    });

    it('rejects an unknown id with a pointer to `list`', async () => {
        const res = await manageProcessForMcp('term-1', { action: 'delete', id: 'nope' });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/list/i);
    });
});
