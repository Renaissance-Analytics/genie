import { describe, expect, it } from 'vitest';
import { UpdateHost, type DrainAgentsPort, type UpdaterPort, type UpdateState } from '../src/main/updater.js';
import type { RunningProcess } from '../src/main/upgrade.js';

/**
 * AN UPGRADE ASKS NO AGENT FOR A HANDOFF (the owner, 2026-10-12: "agents no longer need to write a handoff when genie
 * upgrades. the only point of the handoff was in case the TUI chat was not able to be resumed"). An agent is a session
 * that resumes its own thread; the drain that asked every live agent to write one with imDone and waited up to two
 * minutes is gone. Install ends every agent session (§7.4 — none revived), runs the §7.2 teardown and hands the
 * installer the app, at once; the report names the sessions it ended and says each resumes its thread when started.
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
        const result = f.h.install();
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
        const result = f.h.install();
        expect(result).toMatchObject({ killed: [{ pid: 77 }] });
        expect(result!.report).toMatch(/no agents were running/);
        expect(f.h.state().phase).toBe('installing');
    });
});
