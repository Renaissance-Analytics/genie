import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * A supervised process that ENDED raises an alert (genie#546).
 *
 * The owner asked to hear about the things that finish while they are looking
 * somewhere else. A background process ending is one of those — and a process
 * that CRASHED is the one that most needs saying out loud, because the only
 * other signal it gives is a status pill in a panel nobody has open.
 *
 * Behavioural, through the real supervisor, with the module boundaries mocked
 * the way `process-restart.test.ts` next door does it. The point is not that
 * `alertKindForProcessStatus` returns the right string — that is tested as a
 * pure function — it is that the supervisor CALLS it, on the exits that are
 * endings and not on the ones that are not.
 */

const livePtys = new Set<string>();
type Spec = {
    id: string;
    type: string;
    cwd: string;
    shell: string;
    enabled?: boolean;
    meta: Record<string, unknown>;
};
const specs = new Map<string, Spec>();

function seedSpec(id: string, meta: Record<string, unknown> = {}): void {
    specs.set(id, {
        id,
        type: 'process',
        cwd: '/ws',
        shell: '/usr/bin/bash',
        enabled: true,
        meta: { command: 'npm run dev', restart_on_exit: true, ...meta },
    });
}

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('@particle-academy/fancy-term-host', () => ({
    terminalManager: () => ({
        create: (opts: { id: string }) => {
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
}));
vi.mock('../genie-adapter', () => ({ dbSettingsProvider: () => ({}) }));

const alerts = vi.hoisted(() => ({ played: [] as string[] }));
vi.mock('../../notify-sound', () => ({
    playAlert: (kind: string) => {
        alerts.played.push(kind);
        return true;
    },
}));

import {
    startProcess,
    stopProcess,
    restartProcess,
    onProcessPtyExit,
} from '../process-supervisor';

beforeEach(() => {
    livePtys.clear();
    specs.clear();
    alerts.played.length = 0;
});

describe('an ending is announced', () => {
    it('raises processExit when a process the user stopped finally exits', async () => {
        seedSpec('p1', { restart_on_exit: false });
        startProcess('p1');
        await stopProcess('p1');
        alerts.played.length = 0;
        onProcessPtyExit('p1', { exitCode: 0 });
        expect(alerts.played).toEqual(['processExit']);
    });

    it('raises FAILURE when a process dies non-zero with nothing left to retry', () => {
        // restart_on_exit off → decideOnExit settles straight to 'crashed'
        // rather than walking the backoff, so this is the terminal state.
        seedSpec('p2', { restart_on_exit: false });
        startProcess('p2');
        alerts.played.length = 0;
        onProcessPtyExit('p2', { exitCode: 1 });
        expect(alerts.played).toEqual(['failure']);
    });
});

describe('a non-ending is NOT announced', () => {
    it('says nothing while a crashed process is still working through its retries', () => {
        // POSITIVE CONTROL for the two above: without this, a wiring that fired
        // on EVERY exit would pass both of them and then chime five times on the
        // way to a single crash.
        seedSpec('p3', { restart_on_exit: true });
        startProcess('p3');
        alerts.played.length = 0;
        onProcessPtyExit('p3', { exitCode: 1 });
        expect(alerts.played).toEqual([]);
    });

    it('says nothing about the old pty dying during a deliberate Restart', () => {
        seedSpec('p4');
        startProcess('p4');
        alerts.played.length = 0;
        // A Restart kills the pty and arms restartRequested; that exit is a step
        // in a restart, not a process ending.
        restartProcess('p4');
        onProcessPtyExit('p4', { exitCode: 0 });
        expect(alerts.played).toEqual([]);
    });

    it('says nothing when a SCHEDULED one-shot run finishes its occurrence', () => {
        // A nightly job ends every night by design. Chiming there is the
        // definition of routine progress, which is what the rule excludes.
        seedSpec('cron1', { schedule: '0 3 * * *' });
        startProcess('cron1');
        alerts.played.length = 0;
        onProcessPtyExit('cron1', { exitCode: 0 });
        expect(alerts.played).toEqual([]);
    });
});
