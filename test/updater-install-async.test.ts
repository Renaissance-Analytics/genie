import { describe, expect, it } from 'vitest';
import { UpdateHost, type DrainAgentsPort, type UpdaterPort, type UpdateState } from '../src/main/updater.js';
import type { RunningProcess } from '../src/main/upgrade.js';

/**
 * "RESTART TO INSTALL" NEVER HOLDS THE WINDOW (genie#1201; the owner, 2026-10-26: "the whole Genie UI freezes, turns a
 * pale white … the mouse turns into the spinning circle. After a few moments it finally restarts. We need a better UX
 * during that time."). Install used to do everything inside the click's IPC call, synchronously — stop every agent
 * (each stop reading the machine with PowerShell), read every process again, taskkill each — and only then say
 * "installing". Now it says so FIRST, with what it is waiting for, and does the work without holding main:
 *   agents stopping (N of M left) → closing what runs from the install directory → restarting.
 */

function deferred<T = void>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

function fakes(live: Array<{ id: string; name: string }>, opts: { stopWaitMs?: number } = {}) {
    let installs = 0;
    const killed: number[] = [];
    const quits: Array<() => void> = [];
    const changes: UpdateState[] = [];
    const stops = deferred();
    let report: ((left: number) => void) | null = null;
    const listing = deferred<readonly RunningProcess[]>();
    const port: UpdaterPort = { configure: () => {}, check: async () => ({ version: '2.0.0-beta.45' }), download: async () => {}, quitAndInstall: () => { installs += 1; } };
    const agents: DrainAgentsPort = { live: () => live, stopAll: (onLeft) => { report = onLeft ?? null; return stops.promise; } };
    const h = new UpdateHost({
        port, installDir: 'C:\\Genie', ownPid: 1,
        processes: () => listing.promise,
        kill: async (pid) => { killed.push(pid); return true; },
        clock: () => 1_000_000, caseInsensitive: true,
        defer: (fn) => { quits.push(fn); },
        agents,
        ...(opts.stopWaitMs !== undefined ? { stopWaitMs: opts.stopWaitMs } : {}),
    });
    h.onChange((s) => { changes.push(s); });
    return {
        h, killed, quits, changes, installs: () => installs,
        left: (n: number) => report?.(n),
        stopped: () => stops.resolve(),
        listed: (p: readonly RunningProcess[]) => listing.resolve(p),
        ready: async () => { await h.check(); await h.download(); },
    };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const ORPHAN: RunningProcess = { pid: 77, executable: 'C:\\Genie\\resources\\OpenConsole.exe', parentPid: null };

describe('restart to install', () => {
    it('says "installing" AT ONCE — before a single agent has stopped — with what it is waiting for', async () => {
        const f = fakes([{ id: 'a', name: 'atlas' }, { id: 'b', name: 'bolt' }]);
        await f.ready();
        const pending = f.h.install();
        expect(pending).not.toBeNull();
        // The click's answer has not waited for anything: the state the window draws is already the restart screen.
        expect(f.h.state()).toMatchObject({ phase: 'installing', installing: { step: 'agents', agents: 2, left: 2 } });
        expect(f.changes.at(-1)).toMatchObject({ phase: 'installing', installing: { step: 'agents', left: 2 } });
        f.left(1);
        expect(f.h.state().installing).toMatchObject({ step: 'agents', left: 1 });
        f.left(0);
        f.stopped();
        await tick();
        expect(f.h.state().installing).toMatchObject({ step: 'processes' });
        expect(f.quits).toHaveLength(0); // nothing quits while what runs from the install directory is unknown
        f.listed([ORPHAN]);
        const result = await pending!;
        expect(f.killed).toEqual([77]);
        expect(f.h.state().installing).toMatchObject({ step: 'restarting' });
        expect(result.report).toMatch(/Ended 2 agent sessions \(atlas, bolt\)/);
        expect(f.quits).toHaveLength(1);
        f.quits[0]!();
        expect(f.installs()).toBe(1);
    });

    it('a second click while installing starts nothing twice', async () => {
        const f = fakes([]);
        await f.ready();
        expect(f.h.install()).not.toBeNull();
        expect(f.h.install()).toBeNull();
    });

    it('an agent that will not finish stopping does not hold the install forever: it goes on, and says so', async () => {
        const f = fakes([{ id: 'a', name: 'atlas' }], { stopWaitMs: 20 });
        await f.ready();
        const pending = f.h.install()!;
        await new Promise((r) => setTimeout(r, 40));
        f.listed([]);
        const result = await pending;
        expect(result.report).toMatch(/still stopping/);
        expect(f.quits).toHaveLength(1);
    });
});
