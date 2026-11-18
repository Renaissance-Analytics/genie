import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId } from '../src/core/identity.js';
import { relaunchPlan } from '../src/core/upgrade-drain.js';
import { Registry } from '../src/main/registry.js';
import { restoreAfterRelaunch } from '../src/main/relaunch-restore.js';
import { recordShutdown, type ShutdownRecordPorts } from '../src/main/shutdown-record.js';
import { Store } from '../src/main/store.js';
import { hostDrainAgents } from '../src/main/updates-host.js';

/**
 * A SHUTDOWN DURING THE RESTORE KEEPS EVERY AGENT STILL WAITING TO START (Tynn #754). The owner's beta.63 → beta.64
 * upgrade: attempt 1 recorded 31 agents and stopped; beta.63 relaunched, TOOK both lists (read them and wrote [] at once)
 * and scheduled the 31 starts 3 s apart. Six had started when the updater's second attempt drained again, and that
 * record kept only agents with a session: 6. The 25 still waiting were lost with the process.
 *
 * The saved lists now stay on disk until each agent's start went through; a shutdown record adds the ones still waiting
 * (and keeps the mid-turn ones marked to resume); a start that lands after a shutdown was recorded cannot erase it.
 */

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-restore-754-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const settle = async (n = 20) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

/** A session in the fake host: `inTurn` is the resume prompt's turn, still in flight. */
type Sessions = Map<string, { inTurn: boolean }>;

/** The estate as the LAST shutdown left it: agents a–d, with `running` and `interrupted` saved on disk. */
async function saved(running: readonly ('a' | 'b' | 'c' | 'd')[], interrupted: readonly ('a' | 'b' | 'c' | 'd')[] = []) {
    const first = new Registry(new Store(dir));
    await first.load({ name: 'alphar', healthy: true });
    await first.addWorkspace({ id: 'tynn', path: dir });
    const ids = {} as Record<'a' | 'b' | 'c' | 'd', AgentId>;
    for (const n of ['a', 'b', 'c', 'd'] as const) ids[n] = (await first.register({ workspaceId: 'tynn', provider: 'claude', name: n })).id;
    await first.markRunningAtQuit(running.map((n) => ids[n]));
    await first.markInterruptedAtQuit(interrupted.map((n) => ids[n]));

    // THE RELAUNCH: one Store, as genie-host keeps one, and the window's Registry over it.
    const store = new Store(dir);
    const registry = new Registry(store);
    await registry.load({ name: 'alphar', healthy: true });
    const sessions: Sessions = new Map();
    const nameOf = (id: string) => (Object.keys(ids) as Array<keyof typeof ids>).find((k) => ids[k] === id) ?? id;
    return { store, registry, ids, sessions, nameOf };
}

/** The window's boot restore over that registry: the timers are held so each test fires only the ones it means. */
function restore(e: Awaited<ReturnType<typeof saved>>, options: { safe?: boolean; refuse?: ReadonlySet<string> } = {}) {
    const timers: Array<() => void> = [];
    const log: string[] = [];
    const done = restoreAfterRelaunch({
        safeMode: () => options.safe ?? false,
        pending: () => e.registry.beginRestore(),
        started: (id) => e.registry.restoreStarted(id as AgentId),
        name: e.nameOf,
        schedule: (fn) => { timers.push(fn); },
        start: async (id, resume) => {
            if (options.refuse?.has(id)) throw new Error('Genie is shutting down; new agent sessions wait for restart.');
            e.sessions.set(id, { inTurn: resume });
        },
        log: (line) => { log.push(line); },
    });
    return { done, timers, log };
}

/** The window's quit record (main.ts recordShutdownNow) over the same registry and fake host. */
function windowRecord(e: Awaited<ReturnType<typeof saved>>): ShutdownRecordPorts {
    return {
        agents: () => e.registry.listAgents(),
        probe: (id) => { const s = e.sessions.get(id); return s ? { running: true, turnState: s.inTurn ? 'working' : 'idle', inTurn: s.inTurn } : null; },
        pending: () => e.registry.pendingRestore(),
        markRunningAtQuit: (ids) => e.registry.markRunningAtQuit(ids),
        markInterruptedAtQuit: (ids) => e.registry.markInterruptedAtQuit(ids),
    };
}

/** What is on disk now, by name. */
async function onDisk(e: Awaited<ReturnType<typeof saved>>) {
    const fresh = new Store(dir);
    return { running: (await fresh.readRunningAtQuit()).map(e.nameOf), interrupted: (await fresh.readInterruptedAtQuit()).map(e.nameOf) };
}

/** What the NEXT launch starts, by name. */
async function nextBoot(e: Awaited<ReturnType<typeof saved>>) {
    const registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    const { running, interrupted } = await registry.beginRestore();
    return relaunchPlan({ runningAtQuit: running, interruptedAtQuit: interrupted }).map((s) => ({ name: e.nameOf(s.agentId), resume: s.resume }));
}

describe('Tynn #754: a shutdown inside the restore keeps the agents still waiting to start', () => {
    it('the issue\'s case, the upgrade drain (genie-host): saved [a,b,c,d], only a started; the record is still [a,b,c,d]', async () => {
        const e = await saved(['a', 'b', 'c', 'd']);
        const r = restore(e);
        expect(await r.done).toBe('restored');
        expect(r.timers).toHaveLength(4);
        r.timers[0]!();
        await settle();
        expect([...e.sessions.keys()].map(e.nameOf)).toEqual(['a']);

        // The updater's second attempt: genie-host's drain over the same Store, then every session ends.
        const drain = hostDrainAgents({
            agents: () => e.registry.listAgents(),
            probe: (id) => (e.sessions.has(id) ? { running: true, turnState: 'idle', inTurn: false } : null),
            readPending: async () => ({ running: await e.store.readRunningAtQuit(), interrupted: await e.store.readInterruptedAtQuit() }),
            writeRunningAtQuit: (ids) => e.store.writeRunningAtQuit(ids),
            writeInterruptedAtQuit: (ids) => e.store.writeInterruptedAtQuit(ids),
            stopAll: async () => { e.sessions.clear(); },
        });
        await drain.stopAll();
        expect(await onDisk(e)).toEqual({ running: ['a', 'b', 'c', 'd'], interrupted: [] });
        expect(await nextBoot(e)).toEqual(['a', 'b', 'c', 'd'].map((name) => ({ name, resume: false })));
    });

    it('a quit (the window\'s record) inside the restore: saved [a,b,c,d], only a started; the record is still [a,b,c,d]', async () => {
        const e = await saved(['a', 'b', 'c', 'd']);
        const r = restore(e);
        await r.done;
        r.timers[0]!();
        await settle();
        await recordShutdown(windowRecord(e));
        expect(await onDisk(e)).toEqual({ running: ['a', 'b', 'c', 'd'], interrupted: [] });
    });

    it('MID-TURN, none started yet: a stays marked to resume, b and c to start', async () => {
        const e = await saved(['a', 'b', 'c'], ['a']);
        const r = restore(e);
        await r.done;
        await recordShutdown(windowRecord(e));
        expect(await onDisk(e)).toEqual({ running: ['a', 'b', 'c'], interrupted: ['a'] });
        expect(await nextBoot(e)).toEqual([{ name: 'a', resume: true }, { name: 'b', resume: false }, { name: 'c', resume: false }]);
    });

    it('MID-TURN, a resumed and still in its turn: a is mid-turn again, b and c still wait', async () => {
        const e = await saved(['a', 'b', 'c'], ['a']);
        const r = restore(e);
        await r.done;
        r.timers[0]!();
        await settle();
        expect(e.sessions.get(e.ids.a)).toEqual({ inTurn: true });
        await recordShutdown(windowRecord(e));
        expect(await onDisk(e)).toEqual({ running: ['a', 'b', 'c'], interrupted: ['a'] });
    });

    it('a start that is refused stays saved for the next launch, and a start that lands after the record cannot erase it', async () => {
        const e = await saved(['a', 'b']);
        const r = restore(e, { refuse: new Set([e.ids.a]) });
        await r.done;
        r.timers[0]!();
        await settle();
        expect(await onDisk(e)).toEqual({ running: ['a', 'b'], interrupted: [] });
        // The shutdown is recorded with b still waiting; b's start then lands before the process ends.
        await recordShutdown(windowRecord(e));
        r.timers[1]!();
        await settle();
        expect(e.sessions.has(e.ids.b)).toBe(true);
        expect(await onDisk(e)).toEqual({ running: ['a', 'b'], interrupted: [] });
    });

    it('the restore is in the log: how many, how many mid-turn, and each agent\'s outcome', async () => {
        const e = await saved(['a', 'b', 'c'], ['a']);
        const r = restore(e, { refuse: new Set([e.ids.c]) });
        await r.done;
        for (const t of r.timers) t();
        await settle();
        expect(r.log[0]).toBe('restore: 3 agents (1 mid-turn): a, b, c');
        expect(r.log).toContain('restore: a started (resumed)');
        expect(r.log).toContain('restore: b started');
        expect(r.log).toContain('restore: c could not start, kept for the next launch: Genie is shutting down; new agent sessions wait for restart.');
    });

    it('SAFE MODE: nothing starts, and a shutdown in safe mode keeps both lists', async () => {
        const e = await saved(['a', 'b'], ['a']);
        const r = restore(e, { safe: true });
        expect(await r.done).toBe('held');
        expect(r.timers).toEqual([]);
        await recordShutdown(windowRecord(e));
        expect(await onDisk(e)).toEqual({ running: ['a', 'b'], interrupted: ['a'] });
    });

    it('CONTROL: once every start went through the saved lists are empty, so the next launch starts nobody twice', async () => {
        const e = await saved(['a', 'b', 'c'], ['a']);
        const r = restore(e);
        await r.done;
        for (const t of r.timers) t();
        await settle();
        expect([...e.sessions.keys()].map(e.nameOf).sort()).toEqual(['a', 'b', 'c']);
        expect(await onDisk(e)).toEqual({ running: [], interrupted: [] });
        expect(await nextBoot(e)).toEqual([]);
    });

    it('CONTROL: an agent restored and then stopped by the person is not recorded', async () => {
        const e = await saved(['a', 'b']);
        const r = restore(e);
        await r.done;
        for (const t of r.timers) t();
        await settle();
        e.sessions.delete(e.ids.a);
        await recordShutdown(windowRecord(e));
        expect(await onDisk(e)).toEqual({ running: ['b'], interrupted: [] });
    });
});
