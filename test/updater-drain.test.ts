import { describe, expect, it } from 'vitest';
import { DRAIN_LIMIT_MS, DRAIN_QUIET_MS } from '../src/core/upgrade-drain.js';
import { UpdateHost, type DrainAgentsPort, type UpdaterPort, type UpdateState } from '../src/main/updater.js';
import type { RunningProcess } from '../src/main/upgrade.js';

/**
 * THE UPDATE HOST DRAINS BEFORE IT INSTALLS (§7.5). With agents live, "install" first asks every one
 * to stop, write a handoff and acknowledge, and shows the roster; a quiet agent turns amber; when
 * everyone has answered — or the limit passes — every agent session is ended (§7.4, none revived),
 * the §7.2 teardown runs and the installer is handed the app. CANCEL ALWAYS ABANDONS: nothing is
 * stopped, nothing is killed, the installer is never called, and the update stays downloaded.
 */

function fakes(live: Array<{ id: string; name: string }>) {
    let now = 1_000_000;
    const asked: Array<{ id: string; text: string }> = [];
    const answered = new Map<string, number>();
    const stops: number[] = [];
    let installs = 0;
    const killed: number[] = [];
    const deferred: Array<() => void> = [];
    const changes: UpdateState[] = [];
    const port: UpdaterPort = {
        configure: () => {},
        check: async () => ({ version: '2.0.0-beta.5' }),
        download: async () => {},
        quitAndInstall: () => { installs += 1; },
    };
    const agents: DrainAgentsPort = {
        live: () => live,
        ask: (id, text) => { asked.push({ id, text }); },
        handoffSince: (id, since) => (answered.get(id) ?? -1) >= since,
        stopAll: () => { stops.push(now); },
    };
    const processes: RunningProcess[] = [{ pid: 77, executable: 'C:\\Genie\\resources\\OpenConsole.exe', parentPid: null }];
    const h = new UpdateHost({ port, installDir: 'C:\\Genie', ownPid: 1, processes: () => processes, kill: (pid) => { killed.push(pid); return true; }, clock: () => now, caseInsensitive: true, defer: (fn) => { deferred.push(fn); }, agents });
    h.onChange((s) => { changes.push(s); });
    const ready = async () => { await h.check(); await h.download(); };
    return { h, asked, answer: (id: string) => { answered.set(id, now); }, stops, installs: () => installs, killed, deferred, changes, advance: (ms: number) => { now += ms; }, now: () => now, ready };
}

const live = [{ id: 'agent_a', name: 'atlas' }, { id: 'agent_b', name: 'bolt' }];

describe('install with live agents', () => {
    it('asks every live agent for a handoff and shows the roster instead of installing; nothing is stopped or killed yet', async () => {
        const f = fakes(live);
        await f.ready();
        const result = f.h.install();
        expect(result).toMatchObject({ draining: true, killed: [] });
        expect(result!.report).toMatch(/waiting for 2 agents/i);
        expect(f.asked.map((a) => a.id)).toEqual(['agent_a', 'agent_b']);
        expect(f.asked[0]!.text).toMatch(/handoff/);
        expect(f.asked[0]!.text).toMatch(/imDone/);
        expect(f.h.state()).toMatchObject({ phase: 'draining', version: '2.0.0-beta.5', drain: { entries: [{ agentId: 'agent_a', state: 'asked' }, { agentId: 'agent_b', state: 'asked' }] } });
        expect(f.stops).toEqual([]);
        expect(f.killed).toEqual([]);
        expect(f.installs()).toBe(0);
    });

    it('answers mark the roster; a quiet agent turns amber; when all have answered the sessions end, the teardown runs and the installer is handed the app', async () => {
        const f = fakes(live);
        await f.ready();
        f.h.install();
        f.answer('agent_a');
        f.h.tick();
        expect(f.h.state().drain!.entries.map((e) => e.state)).toEqual(['answered', 'asked']);
        f.advance(DRAIN_QUIET_MS);
        f.h.tick();
        expect(f.h.state().drain!.entries.map((e) => e.state)).toEqual(['answered', 'quiet']);
        expect(f.installs()).toBe(0);
        f.answer('agent_b');
        f.h.tick();
        expect(f.h.state().phase).toBe('installing');
        expect(f.stops).toHaveLength(1);
        expect(f.killed).toEqual([77]);
        expect(f.deferred).toHaveLength(1);
        f.deferred[0]!();
        expect(f.installs()).toBe(1);
        expect(f.h.lastInstall()!.report).toMatch(/2 of 2 agents wrote a handoff/);
    });

    it('the limit is the only other exit: a never-answering agent is named in the report and stopped without a handoff', async () => {
        const f = fakes(live);
        await f.ready();
        f.h.install();
        f.answer('agent_a');
        f.advance(DRAIN_LIMIT_MS - 1);
        f.h.tick();
        expect(f.h.state().phase).toBe('draining');
        f.advance(1);
        f.h.tick();
        expect(f.h.state().phase).toBe('installing');
        expect(f.h.lastInstall()!.report).toMatch(/bolt never answered and was stopped without one/);
        expect(f.stops).toHaveLength(1);
    });

    it('CANCEL abandons: the update stays downloaded, nobody is stopped, nothing is killed, the installer is never called', async () => {
        const f = fakes(live);
        await f.ready();
        f.h.install();
        f.answer('agent_a');
        expect(f.h.cancel()).toBe(true);
        expect(f.h.state()).toMatchObject({ phase: 'downloaded', drain: null });
        f.advance(DRAIN_LIMIT_MS * 2);
        f.h.tick();
        expect(f.h.state().phase).toBe('downloaded');
        expect(f.stops).toEqual([]);
        expect(f.killed).toEqual([]);
        expect(f.installs()).toBe(0);
        expect(f.h.cancel()).toBe(false);
    });

    it('with no live agents install proceeds as before — the sessions-ended step still runs, the report says no agents were running', async () => {
        const f = fakes([]);
        await f.ready();
        const result = f.h.install();
        expect(result).toMatchObject({ killed: [{ pid: 77 }] });
        expect(result!.report).toMatch(/no agents were running/);
        expect(f.h.state().phase).toBe('installing');
        expect(f.deferred).toHaveLength(1);
    });
});
