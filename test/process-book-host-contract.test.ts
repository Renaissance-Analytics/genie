import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { ProcessBook } from '../src/main/process-book.js';
import { ProcessesService } from '../src/main/processes-host.js';
import { ProcessScheduler } from '../src/main/process-scheduler.js';
import type { ProcessSpec, ProcessStatus } from '../src/main/process-supervisor.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';

/**
 * THE PROCESS BOOK AND THE SCHEDULER ARE GENIE-HOST'S (the host split, P3.3c: plan §11e). What the person keeps running is
 * kept — and restored — by the host, and a scheduled task fires on the host's clock with no window. A window lists and
 * manages them through a replica: the list it shows is the host's, its actions the host's, in the host's words.
 */

const TOKEN = 'processes-token';
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const tick = async (n = 8) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

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

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

async function rig() {
    const home = await mkdtemp(join(tmpdir(), 'processes-contract-'));
    const ws = await mkdtemp(join(tmpdir(), 'processes-ws-'));
    dirs.push(home, ws);
    const sup = fakeSupervisor();
    const book = await ProcessBook.open(home, { supervisor: sup, envFor: () => ({}), asleep: () => false });
    let now = new Date(2026, 10, 2, 2, 0, 0).getTime();
    const timers: Array<{ fn: () => void; at: number }> = [];
    const scheduler = new ProcessScheduler({
        book, supervisor: sup, envFor: () => ({}), asleep: () => false, nudge: () => true, now: () => now,
        schedule: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return () => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); }; },
    });
    scheduler.plan();
    const service = new ProcessesService({ book, scheduler, supervisor: sup });
    const server = new SessionEngineServer({ token: TOKEN, build: 't', processes: service });
    server.attach(new SessionHost({ userData: mkdtempSync(join(tmpdir(), 'processes-host-')), driverFor: () => null, processTree: noProcessTree, ...server.hostOptions() }));
    const window = async () => {
        const [h, w] = memoryPair();
        server.accept(h);
        const client = new SessionEngineClient();
        expect(await client.connect(w, TOKEN)).toMatchObject({ ok: true });
        return { book: client.processBook(), close: () => w.close() };
    };
    const advanceTo = (t: number) => { now = t; for (const timer of timers.filter((x) => x.at <= now).splice(0)) { timers.splice(timers.indexOf(timer), 1); timer.fn(); } };
    return { ws, sup, book, window, advanceTo, now: () => now };
}

describe('the process book and the scheduler, in genie-host', () => {
    it('a window keeps a process: the host writes it down and starts it; the window lists it, and owns it', async () => {
        const r = await rig();
        const w = await r.window();
        const status = await w.book.create({ workspaceId: 'ws', workspacePath: r.ws, name: 'queue', command: 'php artisan queue:work', restart: 'always' });
        await tick();
        expect(r.book.kept().map((p) => p.name)).toEqual(['queue']);
        expect(r.sup.started.map((s) => s.name)).toEqual(['queue']);
        expect(w.book.owns(status.id)).toBe(true);
        expect(w.book.list('ws')).toEqual(r.book.list('ws'));
    });

    it('a refusal is the host\'s, in its words, and nothing is kept', async () => {
        const r = await rig();
        const w = await r.window();
        await expect(w.book.create({ workspaceId: 'ws', workspacePath: r.ws, name: '', command: 'x', restart: 'always' })).rejects.toThrow(/needs a name/);
        expect(r.book.kept()).toEqual([]);
    });

    it('a scheduled task fires on the HOST\'s clock with no window, and the next window lists its run', async () => {
        const r = await rig();
        const first = await r.window();
        await first.book.create({ workspaceId: 'ws', workspacePath: r.ws, name: 'nightly', command: 'npm run report', restart: 'never', schedule: { cron: '0 3 * * *', kind: 'command' }, enabled: true });
        await tick();
        first.close();
        await tick();
        expect(r.sup.started).toEqual([]); // CONTROL: nothing before its time
        r.advanceTo(new Date(2026, 10, 2, 3, 0, 1).getTime());
        await tick();
        expect(r.sup.started.map((s) => s.name)).toEqual(['nightly']);
        const next = await r.window();
        expect(next.book.list('ws')).toEqual(r.book.list('ws'));
    });

    it('Stop from a window: the host stops it and remembers it is not wanted', async () => {
        const r = await rig();
        const w = await r.window();
        const status = await w.book.create({ workspaceId: 'ws', workspacePath: r.ws, name: 'queue', command: 'php artisan queue:work', restart: 'always' });
        await w.book.stop(status.id);
        await tick();
        expect(r.sup.status(status.id)?.state).toBe('stopped');
        expect(r.book.kept().find((p) => p.id === status.id)?.wanted).toBe(false);
    });
});
