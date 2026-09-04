import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * A PAUSE THAT SURVIVES A RESTART (genie#407).
 *
 * The report: *"bg processes restart automatically after upgrade even if I
 * paused them."* An upgrade is just a launch, so what this is really about is
 * `startAutostartProcesses()` — the one thing that spawns processes at boot.
 *
 * It used to start a spec when EITHER of two facts held:
 *
 *   spec.meta.autostart === true   OR   spec.meta.was_running === true
 *
 * `was_running` is a runtime desired-state and `stopProcess` already clears it,
 * so a stopped process with no `autostart` did stay down. But `autostart` is
 * CONFIGURATION — "this is a service, run it on every launch" — and the `OR`
 * let it outrank the user's most recent explicit act. Every process a GApp
 * installs (`main/apps/ipc.ts`) and every one an agent creates with
 * `manageProcess {autostart:true}` is in exactly that state, so pausing one and
 * relaunching brought it straight back.
 *
 * The rule these prove: **Genie may restore what IT stopped on the user's
 * behalf; it may never restart what the USER stopped.** A deliberate stop is
 * persisted (`meta.user_stopped`) and boot honours it, and only an explicit
 * start clears it.
 *
 * Every "stays down" assertion below carries a POSITIVE CONTROL in the same
 * test — a sibling spec that DOES come back — because "nothing spawned" is also
 * what a broken supervisor looks like.
 */

const created: string[] = [];
const killed: string[] = [];
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

function seedSpec(id: string, meta: Record<string, unknown> = {}, enabled = true): void {
    specs.set(id, {
        id,
        type: 'process',
        cwd: '/ws',
        shell: '/usr/bin/bash',
        enabled,
        meta: { command: 'npm run dev', restart_on_exit: true, ...meta },
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
        kill: (id: string) => livePtys.delete(id) && (killed.push(id), true),
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

import {
    startProcess,
    stopProcess,
    onProcessPtyExit,
    startAutostartProcesses,
} from '../process-supervisor';

beforeEach(() => {
    created.length = 0;
    killed.length = 0;
    livePtys.clear();
    specs.clear();
});

/** The launch: whatever the supervisor spawned, forgotten, then boot re-run. */
function relaunch(): string[] {
    created.length = 0;
    livePtys.clear();
    startAutostartProcesses();
    return [...created].sort();
}

describe('a pause outranks autostart', () => {
    it('a process the user stopped stays down at the next launch — even one marked autostart', async () => {
        seedSpec('paused', { autostart: true });
        // The control: same config, never touched. If the supervisor stopped
        // starting anything at all, this would go dark too and the assertion
        // below would pass for the wrong reason.
        seedSpec('untouched', { autostart: true });

        startProcess('paused');
        startProcess('untouched');
        await stopProcess('paused');
        onProcessPtyExit('paused', { exitCode: 0 });

        expect(relaunch()).toEqual(['untouched']);
    });

    it('persists the stop, so it is honoured by a launch that knows nothing of this session', async () => {
        seedSpec('paused', { autostart: true });
        startProcess('paused');
        await stopProcess('paused');

        // The DURABLE half: an in-memory `userStopped` flag dies with the
        // process that holds it, which is precisely what an upgrade does.
        expect(specs.get('paused')!.meta.user_stopped).toBe(true);
    });

    it('records the stop even when there was no live pty to kill', async () => {
        // `kill()` returns false for a pty the backend has already forgotten —
        // a process that crashed, or one Genie was restarted away from. The user
        // still asked for it down, and the ask is what has to be remembered.
        seedSpec('gone', { autostart: true });
        const r = await stopProcess('gone');

        expect(r.confirmed).toBe(true);
        expect(specs.get('gone')!.meta.user_stopped).toBe(true);
        expect(relaunch()).toEqual([]);
    });

    it('an explicit start clears the pause — the process is a service again', async () => {
        seedSpec('p', { autostart: true });
        startProcess('p');
        await stopProcess('p');
        onProcessPtyExit('p', { exitCode: 0 });
        expect(relaunch()).toEqual([]);

        startProcess('p');
        expect(specs.get('p')!.meta.user_stopped).toBe(false);
        expect(relaunch()).toEqual(['p']);
    });
});

describe('what Genie stopped on the user’s behalf still comes back', () => {
    it('a process running when Genie went down is restored — that is not a user stop', () => {
        seedSpec('was-up', { was_running: true });
        seedSpec('auto', { autostart: true });
        seedSpec('cold', {}); // configured, never started, never asked for
        expect(relaunch()).toEqual(['auto', 'was-up']);
    });

    it('a crash is not a pause — the process still restores on the next launch', () => {
        seedSpec('crasher', { autostart: true });
        startProcess('crasher');
        // A non-deliberate exit: the supervisor keeps the running intent, and
        // nothing here is the user asking for it down.
        onProcessPtyExit('crasher', { exitCode: 1 });

        expect(specs.get('crasher')!.meta.user_stopped).not.toBe(true);
        expect(relaunch()).toEqual(['crasher']);
    });
});
