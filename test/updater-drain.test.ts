import { describe, expect, it } from 'vitest';
import { UpdateHost, type DrainAgentsPort, type UpdaterPort, type UpdateState } from '../src/main/updater.js';
import type { RunningProcess } from '../src/main/upgrade.js';

/**
 * Legacy ports without a safe-point hook still stop immediately, with no handoff requirement.
 * The real host's bounded current-turn/early-thumb gate (Tynn #616) is covered separately in
 * graceful-install-616.test.ts. These controls retain the pre-existing stop/teardown contract.
 */
function fakes(live: Array<{ id: string; name: string }>) {
    let stops = 0;
    let installs = 0;
    const killed: number[] = [];
    const deferred: Array<() => void> = [];
    const changes: UpdateState[] = [];
    const port: UpdaterPort = { configure: () => {}, check: async () => ({ version: '2.0.0-beta.21' }), download: async () => {}, quitAndInstall: () => { installs += 1; } };
    // The port has no way to ASK an agent anything: no handoff is requested, by construction.
    const agents: DrainAgentsPort = { live: () => live, stopAll: () => { stops += 1; } };
    const processes: RunningProcess[] = [{ pid: 77, executable: 'C:\\Genie\\resources\\OpenConsole.exe', parentPid: null }];
    const h = new UpdateHost({ port, installDir: 'C:\\Genie', ownPid: 1, processes: () => processes, kill: (pid) => { killed.push(pid); return true; }, clock: () => 1_000_000, caseInsensitive: true, defer: (fn) => { deferred.push(fn); }, agents });
    h.onChange((s) => { changes.push(s); });
    return { h, stops: () => stops, installs: () => installs, killed, deferred, changes, ready: async () => { await h.check(); await h.download(); } };
}

describe('install with live agents', () => {
    it('asks nobody, ends the sessions, runs the teardown and hands the installer the app — at once', async () => {
        const f = fakes([{ id: 'agent_a', name: 'atlas' }, { id: 'agent_b', name: 'bolt' }]);
        await f.ready();
        const result = await f.h.install();
        expect(f.stops()).toBe(1);
        expect(result).toMatchObject({ killed: [{ pid: 77 }] });
        expect(result).not.toHaveProperty('draining');
        expect(result!.report).toMatch(/Ended 2 agent sessions \(atlas, bolt\); each resumes its own thread when started again/);
        expect(f.h.state().phase).toBe('installing');
        expect(f.deferred).toHaveLength(1);
        f.deferred[0]!();
        expect(f.installs()).toBe(1);
    });

    it('with no live agents (positive control): the same install, and the report says none were running', async () => {
        const f = fakes([]);
        await f.ready();
        const result = await f.h.install();
        expect(result).toMatchObject({ killed: [{ pid: 77 }] });
        expect(result!.report).toMatch(/no agents were running/);
        expect(f.h.state().phase).toBe('installing');
    });
});
