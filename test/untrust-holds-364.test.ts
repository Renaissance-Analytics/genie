import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { FileAddedProps } from '../src/core/file-trigger.js';
import { FlowScheduler } from '../src/main/flow-scheduler.js';
import { FlowStore } from '../src/main/flow-store.js';
import { FlowsService } from '../src/main/flows-host.js';
import * as book364 from '../src/main/process-book.js';
import { ProcessBook } from '../src/main/process-book.js';
import { ProcessScheduler } from '../src/main/process-scheduler.js';
import type { ProcessSpec, ProcessStatus } from '../src/main/process-supervisor.js';

/**
 * AFTER THE PERSON UNTRUSTS A WORKSPACE (Tynn #364). Its kept processes were left running and startable, and its armed
 * flows went on firing. Now, once its verdict says it is not trusted: its kept processes are stopped and none starts (the
 * person's Start included), its scheduled tasks and its flows do not fire (Run now included), and each says so in its
 * status, "held: workspace not trusted". Trusted again, they go on as normal: what was wanted starts again, what the
 * person had stopped stays stopped, and the schedules are armed again. The verdict is read when each acts, never kept.
 */

type Verdict = 'trusted' | 'untrusted' | 'unread';
const HELD = 'held: workspace not trusted';
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

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

const WS = { id: 'ws-example', path: resolve(tmpdir(), 'untrust-364-ws') };
const worker = { workspaceId: WS.id, workspacePath: WS.path, name: 'queue worker', command: 'php artisan queue:work', restart: 'on-failure' as const };
const watcher = { workspaceId: WS.id, workspacePath: WS.path, name: 'watcher', command: 'npm run watch', restart: 'always' as const };
const nightly = { workspaceId: WS.id, workspacePath: WS.path, name: 'nightly', command: 'npm run report', restart: 'never' as const, schedule: { cron: '* * * * *', kind: 'command' as const } };

async function bookRig(initial: Verdict = 'trusted') {
    const home = await mkdtemp(join(tmpdir(), 'untrust-book-364-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const verdict = { now: initial };
    const sup = fakeSupervisor();
    const trust = (id: string): Verdict => (id === WS.id ? verdict.now : 'trusted');
    const book = await ProcessBook.open(home, { supervisor: sup, envFor: () => ({}), asleep: () => false, trust } as Parameters<typeof ProcessBook.open>[1]);
    const armed: number[] = [];
    const scheduler = new ProcessScheduler({ book, supervisor: sup, envFor: () => ({}), asleep: () => false, nudge: () => true, now: Date.now, schedule: (_fn, ms) => { armed.push(ms); return () => {}; }, trust } as ConstructorParameters<typeof ProcessScheduler>[0]);
    cleanups.push(() => scheduler.stop());
    return { home, sup, book, scheduler, armed, verdict, trust };
}
const row = (book: ProcessBook, name: string) => book.list(WS.id).find((p) => p.name === name);

describe('kept processes', () => {
    it('the person untrusts the workspace: what runs is stopped, still wanted, and its row says why', async () => {
        const r = await bookRig();
        const p = await r.book.create(worker);
        expect(row(r.book, 'queue worker')).toMatchObject({ state: 'running' }); // CONTROL
        r.verdict.now = 'untrusted';
        r.book.trustMoved(WS.id);
        expect(r.sup.status(p.id)).toMatchObject({ state: 'stopped' });
        expect(row(r.book, 'queue worker')).toMatchObject({ state: 'stopped', reason: HELD });
        expect(r.book.kept().find((k) => k.id === p.id)?.wanted).toBe(true);
        expect(book364.UNTRUSTED_REASON).toBe(HELD);
    });

    it('none starts while it is not trusted: Start, Restart and a new one are refused, saying why', async () => {
        const r = await bookRig();
        const p = await r.book.create(worker);
        r.verdict.now = 'untrusted';
        r.book.trustMoved(WS.id);
        const before = r.sup.started.length;
        await expect(r.book.start(p.id)).rejects.toThrow(HELD);
        await expect(r.book.restart(p.id)).rejects.toThrow(HELD);
        await expect(r.book.create(watcher)).rejects.toThrow(HELD);
        expect(r.sup.started.length).toBe(before);
    });

    it('the verdict is read when it acts: untrusted with nobody told yet, Start is still refused', async () => {
        const r = await bookRig();
        const p = await r.book.create(worker);
        await r.book.stop(p.id);
        r.verdict.now = 'untrusted';
        await expect(r.book.start(p.id)).rejects.toThrow(HELD);
        expect(row(r.book, 'queue worker')).toMatchObject({ state: 'stopped', reason: HELD });
    });

    it('trusted again: what was wanted starts again; what the person had stopped stays stopped', async () => {
        const r = await bookRig();
        const a = await r.book.create(worker);
        const b = await r.book.create(watcher);
        await r.book.stop(b.id);
        r.verdict.now = 'untrusted';
        r.book.trustMoved(WS.id);
        const before = r.sup.started.length;
        r.verdict.now = 'trusted';
        r.book.trustMoved(WS.id);
        expect(r.sup.started.slice(before).map((s) => s.id)).toEqual([a.id]);
        expect(row(r.book, 'queue worker')).toMatchObject({ state: 'running' });
        expect(row(r.book, 'watcher')).toMatchObject({ state: 'stopped' });
        expect(row(r.book, 'watcher')?.reason).toBeUndefined();
    });

    it('at launch: a workspace not trusted restores nothing, and one not read yet waits for its verdict, then starts', async () => {
        const first = await bookRig();
        await first.book.create(worker);
        for (const [verdict, words] of [['untrusted', HELD], ['unread', /trust/]] as const) {
            const sup = fakeSupervisor();
            const now = { v: verdict as Verdict };
            const book = await ProcessBook.open(first.home, { supervisor: sup, envFor: () => ({}), asleep: () => false, trust: () => now.v } as Parameters<typeof ProcessBook.open>[1]);
            const restored = book.restore();
            expect(sup.started).toEqual([]);
            expect(restored.started).toEqual([]);
            expect(book.list(WS.id).find((p) => p.name === 'queue worker')).toMatchObject({ state: 'stopped', reason: expect.stringMatching(words) });
            now.v = 'trusted';
            book.trustMoved(WS.id);
            expect(sup.started.map((s) => s.name)).toEqual(['queue worker']);
        }
    });

    it('CONTROL: another workspace, trusted, is not touched', async () => {
        const r = await bookRig();
        const other = await r.book.create({ ...worker, workspaceId: 'ws-other' });
        r.verdict.now = 'untrusted';
        r.book.trustMoved(WS.id);
        expect(r.sup.status(other.id)).toMatchObject({ state: 'running' });
    });
});

describe('scheduled tasks', () => {
    it('not trusted: nothing is armed, Run now is held, and the run says why', async () => {
        const r = await bookRig();
        const task = await r.book.create(nightly);
        r.scheduler.plan();
        expect(r.armed.length).toBeGreaterThan(0); // CONTROL
        r.armed.length = 0;
        r.verdict.now = 'untrusted';
        r.scheduler.plan();
        expect(r.armed).toEqual([]);
        expect(await r.scheduler.runNow(task.id)).toBe('held');
        await r.scheduler.settled();
        expect(r.sup.started).toEqual([]);
        expect(r.book.scheduledTasks().find((t) => t.id === task.id)?.schedule?.runs?.[0]).toMatchObject({ status: 'skipped', reason: HELD });
        expect(row(r.book, 'nightly')).toMatchObject({ reason: HELD, schedule: { nextRunAt: null } });
        r.verdict.now = 'trusted';
        r.scheduler.plan();
        expect(r.armed.length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------- flows

const user = { kind: 'user' } as const;
const scheduleDoc = {
    $schema: FLOW_SCHEMA_URL, version: 1,
    graph: { nodes: [{ id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '* * * * *', timezone: 'UTC' } }, { id: 'l', kind: 'log', position: { x: 200, y: 0 }, config: { message: 'tick' } }], edges: [{ id: 'e1', source: 't', target: 'l' }] },
};
const fileDoc = {
    $schema: FLOW_SCHEMA_URL, version: 1,
    graph: { nodes: [{ id: 't', kind: 'genie/file_added', position: { x: 0, y: 0 }, config: { workspace: 'tynn', folder: 'uploads' } }, { id: 'l', kind: 'log', position: { x: 200, y: 0 }, config: { message: 'got it' } }], edges: [{ id: 'e1', source: 't', target: 'l' }] },
};

async function flowRig() {
    const dir = await mkdtemp(join(tmpdir(), 'untrust-flows-364-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const store = await FlowStore.open(dir);
    const armed: number[] = [];
    const runs: string[] = [];
    const verdict = { now: 'trusted' as Verdict };
    const trust = (id: string): Verdict => (id === 'tynn' ? verdict.now : 'trusted');
    const scheduler = new FlowScheduler({ store, now: Date.now, schedule: (_fn, ms) => { armed.push(ms); return () => {}; }, run: async (flow) => { runs.push(flow.name); }, trust } as ConstructorParameters<typeof FlowScheduler>[0]);
    cleanups.push(() => scheduler.stop());
    return { dir, store, scheduler, armed, runs, verdict, trust };
}
const fileIn = (ws: string, relPath: string): FileAddedProps => ({ workspaceId: 'tynn', path: join(ws, relPath), relPath, name: relPath.split('/').pop()!, extension: relPath.split('.').pop()!, sizeBytes: 10 });

describe('flows', () => {
    it('not trusted: no schedule is armed, a file starts nothing, Run now is held saying why, and an interrupted run waits', async () => {
        const r = await flowRig();
        const minutely = await r.store.create({ workspaceId: 'tynn', name: 'minutely', document: scheduleDoc, by: user, armed: true });
        const file = await r.store.create({ workspaceId: 'tynn', name: 'on a file', document: fileDoc, by: user, armed: true });
        r.verdict.now = 'untrusted';
        await r.store.markInFlight(file.id, { at: new Date().toISOString(), trigger: 'manual', nodes: { t: 'ran' } });
        // Each create and mark planned already (the store's onChange): only the timers armed from here count.
        r.armed.length = 0;
        r.scheduler.plan();
        expect(r.armed).toEqual([]);
        expect(r.scheduler.nextDue()).toBeNull();
        expect(r.scheduler.fileAdded(fileIn(r.dir, 'uploads/a.txt'))).toBe(false);
        await r.scheduler.resumeInterrupted();
        const held = await r.scheduler.runNow(minutely.id);
        await r.scheduler.settled();
        expect(r.runs).toEqual([]);
        expect(held).toMatchObject({ outcome: 'held', reason: expect.stringContaining(HELD) });
        expect(r.store.interrupted().map((f) => f.id)).toEqual([file.id]);
    });

    it('trusted again: the schedule is armed and a file starts its flow (CONTROL, the same rig)', async () => {
        const r = await flowRig();
        await r.store.create({ workspaceId: 'tynn', name: 'minutely', document: scheduleDoc, by: user, armed: true });
        await r.store.create({ workspaceId: 'tynn', name: 'on a file', document: fileDoc, by: user, armed: true });
        r.verdict.now = 'untrusted';
        r.armed.length = 0;
        r.scheduler.plan();
        expect(r.armed).toEqual([]);
        r.verdict.now = 'trusted';
        r.scheduler.plan();
        expect(r.armed.length).toBeGreaterThan(0);
        expect(r.scheduler.fileAdded(fileIn(r.dir, 'uploads/a.txt'))).toBe(true);
        await r.scheduler.settled();
        expect(r.runs).toEqual(['on a file']);
    });

    it("the Flows list says it: each flow of the workspace carries why it is held", async () => {
        const r = await flowRig();
        const f = await r.store.create({ workspaceId: 'tynn', name: 'minutely', document: scheduleDoc, by: user, armed: true });
        const service = new FlowsService(undefined, { held: (ws: string) => (r.trust(ws) === 'untrusted' ? HELD : null) } as never);
        service.attach({ store: r.store, scheduler: r.scheduler });
        expect(service.dump().flows.find((x) => x.id === f.id)).not.toHaveProperty('held'); // CONTROL
        r.verdict.now = 'untrusted';
        expect(service.dump().flows.find((x) => x.id === f.id)).toMatchObject({ held: HELD });
    });
});

// ---------------------------------------------------------------- the host

describe('genie-host', () => {
    const host = readFileSync(join(__dirname, '..', 'src', 'main', 'genie-host.ts'), 'utf8');
    it('reads the verdict for the book, its scheduler and the flows, and tells them when it moves', () => {
        expect(host).toMatch(/trust:\s*hostTrustState/);
        expect(host).toMatch(/onVerdict\(\(id\)\s*=>\s*\{[^}]*trustMoved\(id\)/);
        expect(host).toMatch(/held:\s*\(workspaceId\)\s*=>/);
    });
});
