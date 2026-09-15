import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * A HIBERNATING workspace's processes and scheduled tasks stay down (genie#672).
 *
 * "Hibernated workspaces have all processes and terminals completely shut down
 * and do not wake up after upgrades or restarts, only when a user manually wakes
 * them up." Launch's autostart pass, a start from any caller, and a schedule's
 * timer are all ways a process comes up on its own; each refuses while its
 * workspace is asleep. Waking brings them back — autostart processes, and the
 * schedules re-armed.
 */

const created: string[] = [];
const livePtys = new Set<string>();
const asleep = new Set<string>();

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

function seed(id: string, workspaceId: string, meta: Record<string, unknown>): void {
    specs.set(id, {
        id,
        workspace_id: workspaceId,
        label: id,
        type: 'process',
        cwd: '/ws',
        shell: '/usr/bin/bash',
        enabled: true,
        meta: { command: 'npm run dev', ...meta },
    });
}

vi.mock('electron', () => ({
    BrowserWindow: { getAllWindows: () => [] },
}));
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
    isWorkspaceHibernated: (id: string) => asleep.has(id),
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
    getProcessStatuses,
    onProcessPtyExit,
    startAutostartProcesses,
    startProcess,
    stopProcessForHibernation,
} from '../process-supervisor';
import {
    armWorkspaceSchedules,
    disarmWorkspaceSchedules,
    nextRunAt,
    runScheduleNow,
    startSchedules,
} from '../process-scheduler';

beforeEach(() => {
    created.length = 0;
    livePtys.clear();
    specs.clear();
    asleep.clear();
});

describe('processes in a hibernating workspace', () => {
    it('launch’s autostart pass skips them, and still starts an awake workspace’s', () => {
        seed('p-asleep', 'ws-asleep', { autostart: true });
        seed('p-awake', 'ws-awake', { autostart: true });
        asleep.add('ws-asleep');

        startAutostartProcesses();

        expect(created).toEqual(['p-awake']);
    });

    it('a start from any caller is refused', () => {
        seed('p-asleep', 'ws-asleep', {});
        asleep.add('ws-asleep');
        startProcess('p-asleep');
        expect(created).toEqual([]);
    });

    it('waking starts that workspace’s autostart processes — and only that workspace’s', () => {
        seed('p-mine', 'ws-1', { autostart: true });
        seed('p-other', 'ws-2', { autostart: true });
        startAutostartProcesses('ws-1');
        expect(created).toEqual(['p-mine']);
    });
});

describe('stopping a process for hibernation', () => {
    it('stops it WITHOUT recording a user pause, so the wake brings it back', () => {
        seed('p-1', 'ws-1', {});
        startProcess('p-1');
        expect(created).toEqual(['p-1']);
        const wasRunning = specs.get('p-1')?.meta.was_running;

        asleep.add('ws-1');
        stopProcessForHibernation('p-1');
        onProcessPtyExit('p-1', { exitCode: 143 });

        // Not paused by the user, and still remembered as running.
        expect(specs.get('p-1')?.meta.user_stopped).not.toBe(true);
        expect(specs.get('p-1')?.meta.was_running).toBe(wasRunning);
        // It did not restart itself on exit.
        expect(created).toEqual(['p-1']);
        expect(getProcessStatuses()['p-1']).toBe('stopped');

        asleep.delete('ws-1');
        created.length = 0;
        startAutostartProcesses('ws-1');
        expect(created).toEqual(['p-1']);
    });
});

describe('scheduled tasks in a hibernating workspace', () => {
    it('are not armed at launch; an awake workspace’s are', () => {
        seed('t-asleep', 'ws-asleep', { schedule: '0 3 * * *' });
        seed('t-awake', 'ws-awake', { schedule: '0 3 * * *' });
        asleep.add('ws-asleep');

        startSchedules();

        expect(nextRunAt('t-asleep')).toBeNull();
        expect(nextRunAt('t-awake')).not.toBeNull();
    });

    it('hibernating disarms them, and waking re-arms them', () => {
        seed('t-1', 'ws-1', { schedule: '0 3 * * *' });
        startSchedules();
        expect(nextRunAt('t-1')).not.toBeNull();

        asleep.add('ws-1');
        disarmWorkspaceSchedules('ws-1');
        expect(nextRunAt('t-1')).toBeNull();

        asleep.delete('ws-1');
        armWorkspaceSchedules('ws-1');
        expect(nextRunAt('t-1')).not.toBeNull();
    });

    it('a run-now is refused while asleep', () => {
        seed('t-1', 'ws-1', { schedule: '0 3 * * *' });
        asleep.add('ws-1');
        runScheduleNow('t-1');
        expect(created).toEqual([]);
        expect(specs.get('t-1')?.meta.last_run_status).toBeUndefined();
    });
});
