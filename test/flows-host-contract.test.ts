import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { FlowScheduler } from '../src/main/flow-scheduler.js';
import { FlowStore, type Actor } from '../src/main/flow-store.js';
import { FlowsService } from '../src/main/flows-host.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';

/**
 * FLOWS ARE GENIE-HOST'S (the host split, P3.3d: plan §11e). The flows file, the scheduler and the runner live in the host,
 * so an armed flow fires on the host's clock with no window. A window — the canvas editor, the Flows tab — reads them from
 * a replica (every flow, its runs, how many are running) and edits, arms and runs them through the host, in its words.
 */

const TOKEN = 'flows-token';
const user: Actor = { kind: 'user' };
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const tick = async (n = 8) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };
const doc = (cron: string) => ({
    $schema: FLOW_SCHEMA_URL,
    version: 1,
    graph: {
        nodes: [
            { id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron, timezone: 'UTC' } },
            { id: 'l', kind: 'log', position: { x: 200, y: 0 }, config: { message: 'tick' } },
        ],
        edges: [{ id: 'e1', source: 't', target: 'l' }],
    },
});

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

async function rig() {
    const home = await mkdtemp(join(tmpdir(), 'flows-contract-'));
    dirs.push(home);
    let clock = Date.UTC(2026, 10, 2, 2, 59, 0);
    const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
    const store = await FlowStore.open(home, () => clock);
    const ran: string[] = [];
    const scheduler = new FlowScheduler({
        store,
        now: () => clock,
        schedule: (fn, ms) => { const t = { at: clock + ms, fn, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
        run: async (flow) => { ran.push(flow.name); return { outcome: 'ok' } as never; },
    });
    scheduler.plan();
    const service = new FlowsService({ store, scheduler });
    const server = new SessionEngineServer({ token: TOKEN, build: 't', flows: service });
    server.attach(new SessionHost({ userData: mkdtempSync(join(tmpdir(), 'flows-host-')), driverFor: () => null, processTree: noProcessTree, ...server.hostOptions() }));
    const window = async () => {
        const [h, w] = memoryPair();
        server.accept(h);
        const client = new SessionEngineClient();
        expect(await client.connect(w, TOKEN)).toMatchObject({ ok: true });
        return { flows: client.flows(), close: () => w.close() };
    };
    const runUntil = (t: number) => { clock = t; for (let g = 0; g < 50; g += 1) { const due = timers.filter((x) => !x.cancelled && x.at <= clock)[0]; if (!due) return; due.cancelled = true; due.fn(); } };
    return { store, ran, window, runUntil };
}

describe('flows in genie-host', () => {
    it('a flow saved and armed from a window is the host\'s: the window reads it back as the host has it', async () => {
        const r = await rig();
        const w = await r.window();
        const created = await w.flows.create({ workspaceId: 'ws', name: 'nightly', document: doc('0 3 * * *'), by: user });
        await w.flows.arm(created.id, user);
        await tick();
        expect(r.store.get(created.id)?.armed).toBe(true);
        expect(w.flows.get(created.id)).toEqual(r.store.get(created.id));
        expect(w.flows.list('ws')).toEqual(r.store.list('ws'));
    });

    it('an armed flow fires on the HOST\'s clock with no window; the next window sees its run', async () => {
        const r = await rig();
        const first = await r.window();
        const created = await first.flows.create({ workspaceId: 'ws', name: 'nightly', document: doc('0 3 * * *'), by: user, armed: true });
        await tick();
        first.close();
        await tick();
        expect(r.ran).toEqual([]); // CONTROL: nothing before its time
        r.runUntil(Date.UTC(2026, 10, 2, 3, 0, 1));
        await tick();
        expect(r.ran).toEqual(['nightly']);
        const next = await r.window();
        expect(next.flows.get(created.id)?.runs.length).toBe(r.store.get(created.id)?.runs.length);
        expect(next.flows.get(created.id)?.runs.length).toBeGreaterThan(0);
    });

    it('a refusal is the host\'s, in its words: a flow nobody has cannot be armed', async () => {
        const r = await rig();
        const w = await r.window();
        await expect(w.flows.arm('flow_nobody', user)).rejects.toThrow();
    });
});
