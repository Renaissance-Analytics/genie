import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reconcileEngines, type ContainerState, type ReconcilePorts } from '../src/core/engine-reconcile.js';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { FileAddedProps } from '../src/core/file-trigger.js';
import { agentRecord, mintAgentId, type AgentId } from '../src/core/identity.js';
import { HUMAN } from '../src/core/inbox.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { ServiceInstance } from '../src/core/services.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { EnvelopeSites, type EnvelopeSitesPorts } from '../src/main/envelope-sites-host.js';
import { FlowScheduler } from '../src/main/flow-scheduler.js';
import { FlowStore } from '../src/main/flow-store.js';
import { wireHostMailWake } from '../src/main/host-mail-wake.js';
import { HostRegistry } from '../src/main/host-registry.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { ProcessBook } from '../src/main/process-book.js';
import { ProcessScheduler } from '../src/main/process-scheduler.js';
import { ProcessSupervisor, type ProcessSpec, type ProcessStatus } from '../src/main/process-supervisor.js';
import { restoreAfterRelaunch } from '../src/main/relaunch-restore.js';
import { SafeMode } from '../src/main/safe-mode-host.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { SettingsStore } from '../src/main/settings-store.js';
import { SiteManager } from '../src/main/site-manager.js';
import { Store } from '../src/main/store.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * SAFE MODE STARTS NOTHING (spec §2; Tynn #386; the owner, 2026-11-06: "we come up in safe mode, with no agents auto
 * starting … don't just restart the fucking agents. they keep crashing us"). After an unclean end, EVERY automatic start is
 * held: the agents a quit or upgrade recorded (and those cut off mid-turn), the mail wake, IssueWatch's push, a flow's
 * schedule, file trigger and interrupted run, a scheduled task, a site, a kept process, an engine's container.
 *
 * Each path is a SPY with a CONTROL in the same file: the same rig, out of safe mode, does start. Leaving safe mode starts
 * nothing by itself; it only lets the automatic behaviour run again.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); fakes.clear(); });
const settle = async (n = 10) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

// ─── the agents a quit or an upgrade recorded ────────────────────────────────────────────────────────────────────────────

function relaunchRig(safe: boolean) {
    const taken: string[] = [];
    const started: Array<[string, boolean]> = [];
    const timers: Array<() => void> = [];
    let swept = 0;
    const done = restoreAfterRelaunch({
        safeMode: () => safe,
        takeRunningAtQuit: async () => { taken.push('running'); return ['agent_idle']; },
        takeInterruptedAtQuit: async () => { taken.push('interrupted'); return ['agent_mid_turn']; },
        beforeStart: async () => { swept += 1; },
        schedule: (fn) => { timers.push(fn); },
        start: async (agentId, resume) => { started.push([agentId, resume]); },
    });
    return { done, taken, started, timers, swept: () => swept };
}

describe('the agents running at quit, and those cut off mid-turn', () => {
    it('SAFE MODE: none is started or resumed, and both lists are KEPT (never taken)', async () => {
        const r = relaunchRig(true);
        expect(await r.done).toBe('held');
        for (const t of r.timers) t();
        await settle();
        expect(r.started).toEqual([]);
        expect(r.taken).toEqual([]);
    });

    it('CONTROL, normal start: both are started, the mid-turn one told to continue', async () => {
        const r = relaunchRig(false);
        expect(await r.done).toBe('restored');
        for (const t of r.timers) t();
        await settle();
        expect(r.taken.sort()).toEqual(['interrupted', 'running']);
        expect(r.started.sort()).toEqual([['agent_idle', false], ['agent_mid_turn', true]]);
        expect(r.swept()).toBe(1);
    });
});

// ─── the mail wake ───────────────────────────────────────────────────────────────────────────────────────────────────────

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
interface Fake { prompts: string[]; events: DriverEvents }
const fakes = new Map<string, Fake>();
const driverFor: DriverFor = (record) => {
    const factory: SessionDriverFactory = (options) => {
        const fake: Fake = { prompts: [], events: options.events };
        fakes.set(record.id, fake);
        return { start: () => {}, prompt: (content: unknown) => { fake.prompts.push(typeof content === 'string' ? content : JSON.stringify(content)); }, kill: () => {}, cliSessionId: null };
    };
    return factory;
};

async function wakeRig(safe: () => boolean) {
    const dir = await mkdtemp(join(tmpdir(), 'safe-wake-'));
    const ws = await mkdtemp(join(tmpdir(), 'safe-wake-ws-'));
    const store = new Store(dir);
    const atlas = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'atlas' });
    await store.writeWorkspaces([{ id: 'ws', path: ws }]);
    await store.writeAgents([atlas]);
    const registry = new HostRegistry(store);
    await registry.refresh();
    const inbox = await InboxStore.open(dir);
    const settings = await SettingsStore.open(dir);
    const host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree });
    const log: string[] = [];
    const off = wireHostMailWake({ inbox, host, registry, settings, osaDir: dir, log: (l) => log.push(l), safeMode: safe });
    cleanups.push(async () => { off(); host.stopAll(); await host.settled(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
    return { inbox, host, atlas, log };
}

describe('the mail wake', () => {
    it('SAFE MODE: mail to a stopped agent starts nothing; the notice waits, and why is said', async () => {
        const r = await wakeRig(() => true);
        await r.inbox.send({ from: HUMAN, to: r.atlas.id as AgentId, text: 'the deploy finished' });
        await settle();
        expect(r.host.probe(r.atlas.id as AgentId)).toBeNull();
        expect(r.log.join('\n')).toMatch(/safe mode/i);
    });

    it('CONTROL, normal mode: the same mail starts it', async () => {
        const r = await wakeRig(() => false);
        await r.inbox.send({ from: HUMAN, to: r.atlas.id as AgentId, text: 'the deploy finished' });
        await settle();
        expect(r.host.probe(r.atlas.id as AgentId)?.running).toBe(true);
    });
});

// ─── flows: a schedule, a file trigger, an interrupted run ───────────────────────────────────────────────────────────────

const user = { kind: 'user' } as const;
const scheduleDoc = {
    $schema: FLOW_SCHEMA_URL, version: 1,
    graph: { nodes: [{ id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '* * * * *', timezone: 'UTC' } }, { id: 'l', kind: 'log', position: { x: 200, y: 0 }, config: { message: 'tick' } }], edges: [{ id: 'e1', source: 't', target: 'l' }] },
};
const fileDoc = {
    $schema: FLOW_SCHEMA_URL, version: 1,
    graph: { nodes: [{ id: 't', kind: 'genie/file_added', position: { x: 0, y: 0 }, config: { workspace: 'tynn', folder: 'uploads' } }, { id: 'l', kind: 'log', position: { x: 200, y: 0 }, config: { message: 'got it' } }], edges: [{ id: 'e1', source: 't', target: 'l' }] },
};

async function flowRig(safe: () => boolean) {
    const dir = await mkdtemp(join(tmpdir(), 'safe-flows-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const store = await FlowStore.open(dir);
    const armedTimers: number[] = [];
    const runs: string[] = [];
    const scheduler = new FlowScheduler({
        store,
        now: Date.now,
        schedule: (_fn, ms) => { armedTimers.push(ms); return () => {}; },
        run: async (flow) => { runs.push(flow.name); },
        safeMode: safe,
    });
    cleanups.push(() => scheduler.stop());
    return { dir, store, scheduler, armedTimers, runs };
}
const fileIn = (ws: string, relPath: string): FileAddedProps => ({ workspaceId: 'tynn', path: join(ws, relPath), relPath, name: relPath.split('/').pop()!, extension: relPath.split('.').pop()!, sizeBytes: 10 });

describe('flows', () => {
    it('SAFE MODE: an armed schedule arms no timer; a matching file starts no run; an interrupted run is not resumed', async () => {
        const r = await flowRig(() => true);
        await r.store.create({ workspaceId: 'tynn', name: 'minutely', document: scheduleDoc, by: user, armed: true });
        const file = await r.store.create({ workspaceId: 'tynn', name: 'on a file', document: fileDoc, by: user, armed: true });
        await r.store.markInFlight(file.id, { at: new Date().toISOString(), trigger: 'manual', nodes: { t: 'ran' } });
        r.scheduler.plan();
        expect(r.armedTimers).toEqual([]);
        expect(r.scheduler.nextDue()).toBeNull();
        expect(r.scheduler.fileAdded(fileIn(r.dir, 'uploads/a.txt'))).toBe(false);
        await r.scheduler.resumeInterrupted();
        await r.scheduler.settled();
        expect(r.runs).toEqual([]);
        // The interrupted run is KEPT for later, not dropped.
        expect(r.store.interrupted().map((f) => f.id)).toEqual([file.id]);
    });

    it('CONTROL, normal mode: the schedule is armed, the file starts its flow, the interrupted run resumes', async () => {
        const r = await flowRig(() => false);
        await r.store.create({ workspaceId: 'tynn', name: 'minutely', document: scheduleDoc, by: user, armed: true });
        const file = await r.store.create({ workspaceId: 'tynn', name: 'on a file', document: fileDoc, by: user, armed: true });
        await r.store.markInFlight(file.id, { at: new Date().toISOString(), trigger: 'manual', nodes: { t: 'ran' } });
        r.scheduler.plan();
        expect(r.armedTimers.length).toBeGreaterThan(0);
        await r.scheduler.resumeInterrupted();
        await r.scheduler.settled();
        expect(r.scheduler.fileAdded(fileIn(r.dir, 'uploads/a.txt'))).toBe(true);
        await r.scheduler.settled();
        expect(r.runs.sort()).toEqual(['on a file', 'on a file']);
    });
});

// ─── kept processes and scheduled tasks ──────────────────────────────────────────────────────────────────────────────────

function fakeSupervisor() {
    const started: ProcessSpec[] = [];
    const statuses = new Map<string, ProcessStatus>();
    const listeners = new Set<(s: ProcessStatus) => void>();
    const set = (s: ProcessStatus) => { statuses.set(s.id, s); for (const l of listeners) l(s); };
    return {
        started,
        start: (spec: ProcessSpec): ProcessStatus => { started.push(spec); const s: ProcessStatus = { id: spec.id, workspaceId: spec.workspaceId, name: spec.name, state: 'running', pid: 4242, exitCode: null, restarts: 0, since: 0 }; set(s); return s; },
        stop: (id: string) => { const s = statuses.get(id); if (s) set({ ...s, state: 'stopped', pid: null }); return true; },
        forget: (id: string) => statuses.delete(id),
        list: (workspaceId?: string) => [...statuses.values()].filter((s) => workspaceId === undefined || s.workspaceId === workspaceId),
        status: (id: string) => statuses.get(id) ?? null,
        onChange: (l: (s: ProcessStatus) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    };
}
const WS = { id: 'ws-example', path: resolve(tmpdir(), 'safe-mode-ws') };
const worker = { workspaceId: WS.id, workspacePath: WS.path, name: 'queue worker', command: 'php artisan queue:work', restart: 'on-failure' as const };
const nightly = { workspaceId: WS.id, workspacePath: WS.path, name: 'nightly', command: 'npm run report', restart: 'never' as const, schedule: { cron: '* * * * *', kind: 'command' as const } };

async function bookRig(safe: () => boolean) {
    const home = await mkdtemp(join(tmpdir(), 'safe-book-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    // The run before: the person kept a worker running, and a task on a schedule.
    const before = await ProcessBook.open(home, { supervisor: fakeSupervisor(), envFor: () => ({}), asleep: () => false });
    await before.create(worker);
    await before.create(nightly);
    // This launch, with a fresh supervisor: nothing is running yet.
    const sup = fakeSupervisor();
    const book = await ProcessBook.open(home, { supervisor: sup, envFor: () => ({}), asleep: () => false, safeMode: safe });
    const armed: number[] = [];
    const scheduler = new ProcessScheduler({ book, supervisor: sup, envFor: () => ({}), asleep: () => false, nudge: () => true, now: Date.now, schedule: (_fn, ms) => { armed.push(ms); return () => {}; }, safeMode: safe });
    cleanups.push(() => scheduler.stop());
    return { sup, book, scheduler, armed };
}

describe('kept processes and scheduled tasks', () => {
    it('SAFE MODE: the kept worker stays down (held back, saying why) and the schedule arms nothing', async () => {
        const r = await bookRig(() => true);
        const restored = r.book.restore();
        r.scheduler.plan();
        expect(r.sup.started).toEqual([]);
        expect(restored.started).toEqual([]);
        expect(restored.heldBack).toHaveLength(1);
        expect(r.book.list(WS.id).find((p) => p.name === 'queue worker')).toMatchObject({ state: 'stopped', reason: expect.stringMatching(/safe mode/i) });
        expect(r.armed).toEqual([]);
    });

    it('CONTROL, normal mode: the worker is started again and the schedule is armed', async () => {
        const r = await bookRig(() => false);
        r.book.restore();
        r.scheduler.plan();
        expect(r.sup.started.map((s) => s.name)).toEqual(['queue worker']);
        expect(r.armed).toHaveLength(1);
    });
});

// ─── sites ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

function sitesRig(safe: () => boolean) {
    const files = new Map<string, string>();
    const site = { repo: 'shop', runMode: 'host', kind: 'http', enabled: true, name: 'shop', genName: 'shop.gen', hostServe: { mode: 'php', root: 'public' } };
    files.set(join('/ws', 'acme', 'project.json'), JSON.stringify({ $schema: 'https://example.invalid/project.schema.json', name: 'Acme', repos: [{ name: 'shop', slug: 'shop', path: 'repos/shop' }], sites: { k1: site }, hosting: { enabled: true, type: 'static' } }));
    const dirs = new Set([join('/ws', 'acme', 'repos', 'shop')]);
    const opened: string[] = [];
    const held: string[] = [];
    const pty: PtyPort = {
        open: (o) => { opened.push(o.command); return { id: `t${opened.length}`, pid: 1, shell: 'sh', scrollback: '' }; },
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
    };
    let port = 4100;
    const sites = new SiteManager({ supervisor: new ProcessSupervisor(pty, { now: () => 0, schedule: () => () => {} }), allocatePort: () => ++port, caddyBin: '/opt/caddy', configDir: '/cfg', writeConfig: () => {}, phpWorkers: 1 });
    const ports: EnvelopeSitesPorts = {
        fs: { readText: async (p) => files.get(p) ?? null, writeTextAtomic: async (p, t) => { files.set(p, t); }, exists: async (p) => dirs.has(p) || files.has(p) },
        runState: { load: async () => [], save: async () => {} },
        trust: { load: async () => null, save: async () => {} },
        envFor: () => ({}),
        safeMode: safe,
        held: (siteId) => held.push(siteId),
    };
    return { sites, opened, held, envelope: new EnvelopeSites(sites, ports) };
}

describe('sites', () => {
    it('SAFE MODE: the site a launch would start stays down, and is named as held', async () => {
        const r = sitesRig(() => true);
        await r.envelope.sync([{ id: 'acme', path: join('/ws', 'acme') }]);
        expect(r.opened).toEqual([]);
        expect(r.sites.get('site_shop')?.state).not.toBe('running');
        expect(r.held).toEqual(['site_shop']);
    });

    it('CONTROL, normal mode: it is started', async () => {
        const r = sitesRig(() => false);
        await r.envelope.sync([{ id: 'acme', path: join('/ws', 'acme') }]);
        expect(r.sites.get('site_shop')?.state).toBe('running');
        expect(r.opened.length).toBeGreaterThan(0);
    });
});

// ─── engines: a stopped container is not started; a running one is left alone ────────────────────────────────────────────

const engine = (id: string): ServiceInstance => ({ id, engine: 'postgres', version: '17', scope: { kind: 'dedicated', workspaceId: 'example' }, publishedPort: 4102, credentials: {}, active: true });

function engineRig(safe: boolean) {
    const states: Record<string, ContainerState> = { svc_up: 'running', svc_down: 'exited' };
    const started: string[] = [];
    const ports: ReconcilePorts = {
        available: async () => ({ ok: true, version: '28' }),
        instances: () => [engine('svc_up'), engine('svc_down')],
        state: async (id) => states[id]!,
        personStopped: () => new Set(),
        start: async (id) => { started.push(id); states[id] = 'running'; },
        answers: async () => true,
        now: () => 0,
        sleep: async () => {},
        safeMode: () => safe,
    };
    return { ports, started, states };
}

describe('engines', () => {
    it('SAFE MODE: a stopped container is not started; the running one is left running', async () => {
        const r = engineRig(true);
        const report = await reconcileEngines(r.ports);
        expect(r.started).toEqual([]);
        expect(r.states.svc_up).toBe('running');
        expect(report.engines.find((e) => e.id === 'svc_up')?.outcome).toBe('running');
        expect(report.engines.find((e) => e.id === 'svc_down')?.outcome).toBe('held');
    });

    it('CONTROL, normal mode: the stopped one is started', async () => {
        const r = engineRig(false);
        await reconcileEngines(r.ports);
        expect(r.started).toEqual(['svc_down']);
    });
});

// ─── Leave safe mode starts nothing by itself ────────────────────────────────────────────────────────────────────────────

describe('Leave safe mode', () => {
    it('starts no agent, process, site or flow by itself; it only lets the clocks arm again', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'safe-leave-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        // A run, then a run that was killed: this start is in safe mode.
        SafeMode.open(dir, { now: () => 1_000, pid: 1 }).writeCleanExit('a window asked');
        SafeMode.open(dir, { now: () => 2_000, pid: 2 }).beat(['agent_idle']);
        const mode = SafeMode.open(dir, { now: () => 3_000, pid: 3 });
        expect(mode.active()).toBe(true);
        const safe = () => mode.active();

        const book = await bookRig(safe);
        const flows = await flowRig(safe);
        const site = sitesRig(safe);
        const wake = await wakeRig(safe);
        await flows.store.create({ workspaceId: 'tynn', name: 'minutely', document: scheduleDoc, by: user, armed: true });
        // Boot, in safe mode.
        book.book.restore();
        book.scheduler.plan();
        flows.scheduler.plan();
        await site.envelope.sync([{ id: 'acme', path: join('/ws', 'acme') }]);
        // As genie-host wires it: leaving re-plans the clocks, and starts nothing else.
        mode.onChange(() => { book.scheduler.plan(); flows.scheduler.plan(); });
        mode.leave();
        await settle();

        expect(book.sup.started).toEqual([]);
        expect(site.opened).toEqual([]);
        expect(flows.runs).toEqual([]);
        expect(wake.host.probe(wake.atlas.id as AgentId)).toBeNull();
        // The clocks are armed again — what fires later is automatic behaviour, back on.
        expect(book.armed).toHaveLength(1);
        expect(flows.armedTimers.length).toBeGreaterThan(0);
        // And CONTROL: automatic behaviour is back — the next mail starts its agent.
        await wake.inbox.send({ from: HUMAN, to: wake.atlas.id as AgentId, text: 'now' });
        await settle();
        expect(wake.host.probe(wake.atlas.id as AgentId)?.running).toBe(true);
    });
});
