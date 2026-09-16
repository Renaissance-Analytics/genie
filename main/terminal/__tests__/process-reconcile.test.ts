import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * A SUPERVISED PROCESS THAT IS GONE MUST NOT READ AS RUNNING (genie#655).
 *
 * The owner: "`manageProcess list` reports three supervised processes as
 * `status: "running"` … but none of them exist on the host. Queued work sits
 * unclaimed with no signal anywhere that the workers are gone." A job dispatched
 * to that queue was still unreserved six minutes later.
 *
 * The supervisor's status map is written at spawn and at the pty's EXIT EVENT,
 * so a process whose pty disappears without one is remembered as `running`
 * forever. That is exactly what a pty-host loss does: the host dies taking every
 * pty with it, and recovery (genie#203) re-attaches `type: 'terminal'` specs
 * only — a headless process is never re-created and the supervisor is never
 * told. Status is then a memory of a dead machine.
 *
 * `reconcileProcesses()` is the answer: ask the BACKEND who is alive and make
 * the map agree, routing a vanished process through the same exit handling a
 * real exit gets, so `restart_on_exit`, the backoff and the pause all still
 * decide what happens next.
 */

const created: string[] = [];
const livePtys = new Set<string>();

type Spec = {
    id: string;
    workspace_id: string;
    label: string;
    type: string;
    cwd: string;
    shell: string;
    enabled?: boolean;
    meta: Record<string, unknown>;
};
const specs = new Map<string, Spec>();

function seed(id: string, meta: Record<string, unknown> = {}): void {
    specs.set(id, {
        id,
        workspace_id: 'ws-1',
        label: id,
        type: 'process',
        cwd: '/ws',
        shell: '/usr/bin/bash',
        enabled: true,
        meta: { command: 'php artisan queue:work', ...meta },
    });
}

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('@particle-academy/fancy-term-host', () => ({
    terminalManager: () => ({
        create: (opts: { id: string }) => {
            created.push(opts.id);
            livePtys.add(opts.id);
            return { id: opts.id, pid: 1, shell: 'bash' };
        },
        kill: (id: string) => livePtys.delete(id),
        isLive: (id: string) => livePtys.has(id),
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
    isWorkspaceHibernated: () => false,
}));
vi.mock('../genie-adapter', () => ({ dbSettingsProvider: () => ({}) }));
vi.mock('../../agentinbox/broker', () => ({
    agentInboxBroker: {
        deliverMachineMessageToTerminal: () => true,
        deliverHumanMessageToTerminal: () => true,
        getInfo: () => null,
    },
}));

import {
    getProcessLog,
    getProcessStatuses,
    reconcileProcesses,
    startProcess,
    startProcessReconcile,
    stopProcess,
    stopProcessReconcile,
} from '../process-supervisor';

/** What a pty-host loss does to every pty at once, with no exit events. */
const hostDies = (): void => livePtys.clear();

beforeEach(() => {
    created.length = 0;
    livePtys.clear();
    specs.clear();
    vi.useRealTimers();
});

// Every test file shares one fork, so a fake clock left installed here would
// silently break the next file (genie#76).
afterEach(() => {
    stopProcessReconcile();
    vi.useRealTimers();
});

describe('reconcileProcesses — the backend decides who is running', () => {
    it('does NOT report a process as running once its pty is gone, and brings it back', async () => {
        vi.useFakeTimers();
        seed('worker-chat');
        startProcess('worker-chat');
        expect(getProcessStatuses()['worker-chat']).toBe('running');

        hostDies();
        // Before the sweep, the map is still the old machine's memory — this is
        // the reported bug, and it is what the sweep has to end.
        expect(getProcessStatuses()['worker-chat']).toBe('running');

        reconcileProcesses();
        expect(getProcessStatuses()['worker-chat']).not.toBe('running');

        // …and it comes back, through the ordinary crash-restart path.
        created.length = 0;
        await vi.advanceTimersByTimeAsync(2_000);
        expect(created).toEqual(['worker-chat']);
        expect(getProcessStatuses()['worker-chat']).toBe('running');
    });

    it('says in the process log why it acted, because nothing else recorded an exit', () => {
        seed('worker-batch');
        startProcess('worker-batch');
        hostDies();
        reconcileProcesses();
        expect(getProcessLog('worker-batch')).toMatch(/no longer running|gone/i);
    });

    it('leaves a vanished process that opted OUT of restart crashed, not running, not restarted', () => {
        seed('worker-once', { restart_on_exit: false });
        startProcess('worker-once');
        hostDies();
        created.length = 0;

        reconcileProcesses();
        expect(getProcessStatuses()['worker-once']).toBe('crashed');
        expect(created).toEqual([]);
    });

    it('never restarts a process the USER stopped — a sweep is not a start', async () => {
        seed('worker-paused');
        startProcess('worker-paused');
        // Real timers for the stop: it AWAITS its own confirmation window, which
        // a fake clock nobody advances never ends.
        await stopProcess('worker-paused', 0);
        vi.useFakeTimers();
        created.length = 0;

        reconcileProcesses();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(created).toEqual([]);
        expect(getProcessStatuses()['worker-paused']).toBe('stopped');
    });

    it('POSITIVE CONTROL: a process whose pty is alive is left exactly as it is', async () => {
        vi.useFakeTimers();
        seed('worker-fine');
        startProcess('worker-fine');
        created.length = 0;

        reconcileProcesses();
        await vi.advanceTimersByTimeAsync(5_000);
        // Not restarted, not re-reported — the sweep only acts on a difference.
        expect(created).toEqual([]);
        expect(getProcessStatuses()['worker-fine']).toBe('running');
    });

    it('adopts a pty that is alive but that this Genie never started', () => {
        // The other half of the same lie: a launch that reattached to a surviving
        // host skips the spawn (the pty is live), so nothing ever wrote a status
        // and the list reported `stopped` for a process that is running.
        seed('worker-adopted', { autostart: true });
        livePtys.add('worker-adopted');
        expect(getProcessStatuses()['worker-adopted']).toBeUndefined();

        reconcileProcesses();
        expect(getProcessStatuses()['worker-adopted']).toBe('running');
        expect(created).toEqual([]);
    });
});

describe('the sweep runs on its own', () => {
    it('reconciles on a heartbeat, so nothing has to ask before the truth is told', async () => {
        vi.useFakeTimers();
        seed('worker-heartbeat', { restart_on_exit: false });
        startProcess('worker-heartbeat');
        const stop = startProcessReconcile(30_000);

        hostDies();
        // Nobody calls `manageProcess list`, nobody opens the Processes panel —
        // the owner's complaint was precisely that no signal ever arrived.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(getProcessStatuses()['worker-heartbeat']).toBe('crashed');

        // And it can be turned off: a second Genie instance in one process (the
        // E2E harness) must not stack sweeps.
        stop();
        startProcess('worker-heartbeat');
        hostDies();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(getProcessStatuses()['worker-heartbeat']).toBe('running');
    });
});
