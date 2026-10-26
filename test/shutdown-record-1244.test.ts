import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentId, AgentRecord } from '../src/core/identity.js';
import type { ProcessInfo, ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents } from '../src/core/session.js';
import { relaunchPlan } from '../src/core/upgrade-drain.js';
import { McpPreparationError } from '../src/main/mcp-preparation-error.js';
import { Registry } from '../src/main/registry.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { recordShutdown, recordThenStopAll, type ShutdownRecordPorts } from '../src/main/shutdown-record.js';
import { Store } from '../src/main/store.js';

/**
 * EVERY AGENT GENIE STARTED AND NOBODY STOPPED COMES BACK (genie#1244). The owner's beta.45 → beta.47 upgrade started
 * 3 of 11 agents again. The other 8 had been started by beta.45's own boot relaunch, and that start FAILED (per-agent Tynn
 * preparation refused: their ledgers end with "The run failed: Sign in to Tynn…" at 19:27:56–19:28:24 and nothing after).
 * Nobody stopped them; they sat Broken with a Restart fix for three hours. At the upgrade the record kept only agents
 * whose provider PROCESS was alive (`probe.running`), so the 8 fell off the list and the next boot started only 3.
 *
 * What the person stopped stays stopped: a person's Stop removes the session, so that agent is not on the list.
 */

const ROOT_PID = process.pid;
let dir: string;
const hosts: SessionHost[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-shutdown-record-')); });
afterEach(async () => { for (const h of hosts.splice(0)) { void h.stopAll(); await h.drained(0); await h.settled(); } await rm(dir, { recursive: true, force: true }); });

type Kind = 'idle' | 'working' | 'broken' | 'stopped';

async function estate() {
    const registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await registry.addWorkspace({ id: 'tynn', path: dir });
    const agents = {} as Record<Kind, AgentRecord>;
    for (const kind of ['idle', 'working', 'broken', 'stopped'] as const) agents[kind] = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: kind });
    const kindOf = (id: string): Kind => (Object.keys(agents) as Kind[]).find((k) => agents[k].id === id)!;

    let processes: ProcessInfo[] = [{ pid: ROOT_PID, ppid: 1, started: 1, name: 'genie-test' }];
    const tree: ProcessTree = {
        snapshot: () => [...processes],
        killTree: (targets) => { const ids = new Set(targets.map((p) => p.pid)); processes = processes.filter((p) => !ids.has(p.pid)); return { killed: targets.length, refused: false }; },
    };
    const events = new Map<string, DriverEvents>();
    let next = 0;
    const driverFor: DriverFor = (agent) => ({ events: callbacks }) => {
        const pid = ROOT_PID + 1_000_000 + ++next;
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
    const host = new SessionHost({
        userData: dir, driverFor, processTree: tree, stopGraceMs: 0,
        // beta.45's boot: the per-agent Tynn preparation was refused for this agent, so its run failed before any provider ran.
        prepareMcpServers: async (record) => { if (kindOf(record.id) === 'broken') throw new McpPreparationError('refused'); return []; },
    });
    hosts.push(host);

    for (const kind of ['idle', 'working', 'broken', 'stopped'] as const) expect(host.start(agents[kind], dir)).toEqual({ ok: true });
    await vi.waitFor(() => {
        expect(host.probe(agents.idle.id)?.running).toBe(true);
        expect(host.probe(agents.working.id)?.running).toBe(true);
        expect(host.probe(agents.broken.id)?.turnState).toBe('failed');
    });
    // IDLE: it answered its last message and waits for the next (a session that was never prompted still reads its
    // start as `working` — core/session.ts — so the idle agent here has finished a turn, as the owner's had).
    expect(host.prompt(agents.idle.id, 'hello', 'you')).toBe(true);
    await vi.waitFor(() => expect(host.probe(agents.idle.id)?.inTurn).toBe(true));
    events.get(agents.idle.id)!.onTurnEnd!({ stopReason: 'end_turn', isError: false, raw: 'end_turn' });
    await vi.waitFor(() => expect(host.probe(agents.idle.id)?.turnState).toBe('idle'));
    expect(host.prompt(agents.working.id, 'build it', 'you')).toBe(true);
    await vi.waitFor(() => expect(host.probe(agents.working.id)?.turnState).toBe('working'));
    // The person's Stop.
    expect(host.stop(agents.stopped.id)).toBe(true);
    await host.ended(agents.stopped.id);

    const ports: ShutdownRecordPorts = {
        agents: () => registry.snapshot().agents,
        probe: (id) => host.probe(id),
        markRunningAtQuit: (ids) => registry.markRunningAtQuit(ids),
        markInterruptedAtQuit: (ids) => registry.markInterruptedAtQuit(ids),
    };
    return { registry, host, agents, ports };
}

/** A plan by agent name, so a failure reads as names. */
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

describe('genie#1244: what a shutdown records is every agent Genie started and nobody stopped', () => {
    it('the fixture is the owner\'s estate: an idle agent\'s provider IS alive; the broken one\'s never ran', async () => {
        const { host, agents } = await estate();
        const seen = (id: AgentId) => { const p = host.probe(id); return p && { running: p.running, turnState: p.turnState }; };
        expect(seen(agents.idle.id)).toEqual({ running: true, turnState: 'idle' });
        expect(seen(agents.working.id)).toEqual({ running: true, turnState: 'working' });
        expect(seen(agents.broken.id)).toEqual({ running: false, turnState: 'failed' });
        expect(host.probe(agents.stopped.id)).toBeNull();
    });

    it('NORMAL QUIT: the idle, the mid-turn AND the broken agent start again; the one the person stopped does not', async () => {
        const { host, agents, ports } = await estate();
        // before-quit's 'record' step: the record lands, THEN the quit resumes and the sessions end.
        await recordShutdown(ports);
        await host.stopAll();
        const plan = await nextBoot();
        // The mid-turn agent first and told to continue; then the others, unprompted, in roster order.
        expect(named(agents, plan)).toEqual([
            { name: 'working', resume: true },
            { name: 'idle', resume: false },
            { name: 'broken', resume: false },
        ]);
    });

    it('UPGRADE (restart-to-install): the same three start again; the one the person stopped does not', async () => {
        const { host, agents, ports } = await estate();
        const stopAll = recordThenStopAll({ markRecorded: () => {}, record: () => recordShutdown(ports), stopAll: (onLeft) => host.stopAll(onLeft) });
        await stopAll();
        const plan = await nextBoot();
        expect(named(agents, plan)).toEqual([
            { name: 'working', resume: true },
            { name: 'idle', resume: false },
            { name: 'broken', resume: false },
        ]);
    });
});

describe('genie#1244: the upgrade\'s record is complete and on disk before any session is stopped', () => {
    it('no session is stopped while the record is still being written, and the stop resolves only after it landed', async () => {
        const { host, agents, ports } = await estate();
        let release!: () => void;
        const held = new Promise<void>((r) => { release = r; });
        const order: string[] = [];
        const slow: ShutdownRecordPorts = {
            ...ports,
            markRunningAtQuit: async (ids) => { await held; await ports.markRunningAtQuit(ids); order.push('recorded'); },
        };
        const stopAll = recordThenStopAll({
            markRecorded: () => { order.push('marked'); },
            record: () => recordShutdown(slow),
            stopAll: (onLeft) => { order.push('stopping'); return host.stopAll(onLeft); },
        });
        const done = stopAll();
        await new Promise((r) => setTimeout(r, 20));
        // The write is held: every session is still there.
        expect(order).toEqual(['marked']);
        expect(host.probe(agents.idle.id)?.running).toBe(true);
        release();
        await done;
        expect(order).toEqual(['marked', 'recorded', 'stopping']);
    });

    it('a record that cannot be written never blocks the upgrade: the sessions still end', async () => {
        const { host, agents, ports } = await estate();
        const failing: ShutdownRecordPorts = { ...ports, markRunningAtQuit: () => Promise.reject(new Error('disk full')) };
        const stopAll = recordThenStopAll({ markRecorded: () => {}, record: () => recordShutdown(failing), stopAll: (onLeft) => host.stopAll(onLeft) });
        await stopAll();
        expect(host.probe(agents.idle.id)).toBeNull();
    });
});

describe('genie#1244: CONTROL — the record reads the host, not a guess', () => {
    it('an agent with no session (never started, or stopped) is never recorded', async () => {
        const marked: AgentId[][] = [];
        await recordShutdown({
            agents: () => [{ id: 'agent_a' }, { id: 'agent_b' }],
            probe: (id) => (id === 'agent_a' ? { running: false, turnState: 'failed' } : null),
            markRunningAtQuit: async (ids) => { marked.push([...ids]); },
            markInterruptedAtQuit: async () => {},
        });
        expect(marked).toEqual([['agent_a']]);
    });
});
