import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import type { ProcessInfo, ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents } from '../src/core/session.js';
import { midTurnAgents, relaunchPlan } from '../src/core/upgrade-drain.js';
import { Registry } from '../src/main/registry.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { recordShutdown, type ShutdownRecordPorts } from '../src/main/shutdown-record.js';
import { Store } from '../src/main/store.js';

/**
 * A STARTED AGENT THAT WAS NEVER PROMPTED IS NOT MID-TURN (genie#1248). `AgentSession.start()` leaves a session reading
 * `turnState: 'working'` until a turn of its own ends, so an agent the boot relaunch started and nobody spoke to read as
 * mid-turn at the next quit. It went into the interrupted list, and the launch after told it "Genie shut down while you
 * were in the middle of a turn … Continue the work you were doing" about a turn it never had (the owner's estate,
 * 2026-10-26: 6 agents at 02:48, 7 at 19:27). Mid-turn means a turn is IN FLIGHT by Genie's own record: a prompt went
 * in (or the agent began one itself) and its end has not come — `AgentSession.inTurn`, as Restart already reads (#1238).
 */

const ROOT_PID = process.pid;
let dir: string;
const hosts: SessionHost[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-shutdown-record-1248-')); });
afterEach(async () => { for (const h of hosts.splice(0)) { void h.stopAll(); await h.drained(0); await h.settled(); } await rm(dir, { recursive: true, force: true }); });

type Kind = 'started' | 'working' | 'idle';

async function estate() {
    const registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await registry.addWorkspace({ id: 'tynn', path: dir });
    const agents = {} as Record<Kind, AgentRecord>;
    for (const kind of ['started', 'working', 'idle'] as const) agents[kind] = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: kind });

    let processes: ProcessInfo[] = [{ pid: ROOT_PID, ppid: 1, started: 1, name: 'genie-test' }];
    const tree: ProcessTree = {
        snapshot: () => [...processes],
        killTree: (targets) => { const ids = new Set(targets.map((p) => p.pid)); processes = processes.filter((p) => !ids.has(p.pid)); return { killed: targets.length, refused: false }; },
    };
    const events = new Map<string, DriverEvents>();
    let next = 0;
    const driverFor: DriverFor = (agent) => ({ events: callbacks }) => {
        const pid = ROOT_PID + 2_000_000 + ++next;
        let alive = false;
        events.set(agent.id, callbacks);
        return {
            start: () => { alive = true; processes.push({ pid, ppid: ROOT_PID, started: 3, name: 'claude-fixture' }); },
            prompt: () => {},
            kill: () => { alive = false; processes = processes.filter((p) => p.pid !== pid); },
            get running() { return alive; },
            cliSessionId: null,
            ready: Promise.resolve(),
        };
    };
    const host = new SessionHost({ userData: dir, driverFor, processTree: tree, stopGraceMs: 0, prepareMcpServers: async () => [] });
    hosts.push(host);

    // The boot relaunch starts all three.
    for (const kind of ['started', 'working', 'idle'] as const) expect(host.start(agents[kind], dir)).toEqual({ ok: true });
    await vi.waitFor(() => { for (const kind of ['started', 'working', 'idle'] as const) expect(host.probe(agents[kind].id)?.running).toBe(true); });
    // WORKING: the person sent a message and its turn has not ended.
    expect(host.prompt(agents.working.id, 'build it', 'you')).toBe(true);
    await vi.waitFor(() => expect(host.probe(agents.working.id)?.inTurn).toBe(true));
    // IDLE: it answered a message and waits for the next.
    expect(host.prompt(agents.idle.id, 'hello', 'you')).toBe(true);
    await vi.waitFor(() => expect(host.probe(agents.idle.id)?.inTurn).toBe(true));
    events.get(agents.idle.id)!.onTurnEnd!({ stopReason: 'end_turn', isError: false, raw: 'end_turn' });
    await vi.waitFor(() => expect(host.probe(agents.idle.id)?.turnState).toBe('idle'));
    // STARTED: nobody has said anything to it.

    const ports: ShutdownRecordPorts = {
        agents: () => registry.snapshot().agents,
        probe: (id) => host.probe(id),
        markRunningAtQuit: (ids) => registry.markRunningAtQuit(ids),
        markInterruptedAtQuit: (ids) => registry.markInterruptedAtQuit(ids),
    };
    return { host, agents, ports };
}

function named(agents: Record<Kind, AgentRecord>, plan: ReadonlyArray<{ agentId: string; resume: boolean }>): Array<{ name: string; resume: boolean }> {
    return plan.map((s) => ({ name: (Object.keys(agents) as Kind[]).find((k) => agents[k].id === s.agentId) ?? s.agentId, resume: s.resume }));
}

/** What the NEXT launch reads from disk and starts (main.ts boot: take both lists, relaunchPlan). */
async function nextBoot(): Promise<Array<{ agentId: string; resume: boolean }>> {
    const registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    const [running, interrupted] = await Promise.all([registry.takeRunningAtQuit(), registry.takeInterruptedAtQuit()]);
    return relaunchPlan({ runningAtQuit: running, interruptedAtQuit: interrupted }).map(({ agentId, resume }) => ({ agentId, resume }));
}

describe('genie#1248: a started agent that was never prompted is not mid-turn at quit', () => {
    it('the fixture is the bug\'s shape: the never-prompted agent READS `working` with no turn in flight', async () => {
        const { host, agents } = await estate();
        const seen = (k: Kind) => { const p = host.probe(agents[k].id); return p && { running: p.running, turnState: p.turnState, inTurn: p.inTurn }; };
        expect(seen('started')).toEqual({ running: true, turnState: 'working', inTurn: false });
        expect(seen('working')).toEqual({ running: true, turnState: 'working', inTurn: true });
        expect(seen('idle')).toEqual({ running: true, turnState: 'idle', inTurn: false });
    });

    it('QUIT: only the agent with a turn in flight is resumed and told to continue; the never-prompted one comes back unprompted', async () => {
        const { host, agents, ports } = await estate();
        await recordShutdown(ports);
        await host.stopAll();
        expect(named(agents, await nextBoot())).toEqual([
            { name: 'working', resume: true },
            { name: 'started', resume: false },
            { name: 'idle', resume: false },
        ]);
    });
});

describe('genie#1248: who was mid-turn is who had a turn in flight', () => {
    it('`inTurn` decides; `working` without a turn (a session only started) does not', () => {
        expect(midTurnAgents([
            { id: 'started', inTurn: false },
            { id: 'prompted', inTurn: true },
            { id: 'idle', inTurn: false },
            { id: 'unknown', inTurn: undefined },
            { id: 'none', inTurn: null },
        ])).toEqual(['prompted']);
    });
});
