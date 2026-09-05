import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * BOOT'S AUTOSTART PASS MUST NOT RESTART WHAT IS ALREADY RUNNING (genie#389).
 *
 * `startAutostartProcesses`'s own doc says *"startProcess() no-ops if the pty is
 * already live (e.g. a detached host kept it alive and Genie reattached), so
 * this only spawns the ones that actually died."* That was not true:
 * `startProcess` treats a redundant start as a RESTART, so every process a
 * surviving host kept alive was killed and respawned by the boot pass.
 *
 * Latent until now, because nothing else started a process before that pass.
 * The drain's staggered restore does — it brings back exactly what was running,
 * three seconds apart, and the autostart pass then ran over the top of it and
 * restarted every one of them in a single tick, which is the thundering herd
 * the stagger exists to prevent.
 *
 * The fix is the behaviour that was already documented: a live process is left
 * alone.
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

function seedSpec(id: string, meta: Record<string, unknown> = {}): void {
    specs.set(id, {
        id,
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

import { startProcess, startAutostartProcesses } from '../process-supervisor';

beforeEach(() => {
    created.length = 0;
    killed.length = 0;
    livePtys.clear();
    specs.clear();
});

describe('startAutostartProcesses', () => {
    it('leaves a RUNNING process alone instead of restarting it', () => {
        seedSpec('restored', { autostart: true });
        // The drain's restore already brought this one back, staggered.
        startProcess('restored');
        created.length = 0;
        killed.length = 0;

        startAutostartProcesses();

        expect(killed).toEqual([]);
        expect(created).toEqual([]);
    });

    it('still starts the ones that are NOT running', () => {
        // POSITIVE CONTROL. "Nothing was started" is also what a pass that
        // starts nothing at all looks like — which would silently drop every
        // configured service across an upgrade.
        seedSpec('restored', { autostart: true });
        seedSpec('down', { autostart: true });
        startProcess('restored');
        created.length = 0;

        startAutostartProcesses();

        expect(created).toEqual(['down']);
    });
});
