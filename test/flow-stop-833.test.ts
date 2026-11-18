import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { Button } from '@particle-academy/react-fancy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flowPillSignals } from '../src/core/flow-pill-signals.js';
import type { FlowPill } from '../src/core/flow-pills.js';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import { mintAgentId } from '../src/core/identity.js';
import { PERSON_ONLY_ACTIONS } from '../src/main/approval-queue.js';
import type { FlowPorts } from '../src/main/flow-executors.js';
import { createFlowRunner, supervisedCommand } from '../src/main/flow-runner.js';
import { FlowScheduler } from '../src/main/flow-scheduler.js';
import { FlowStore, type FlowRecord } from '../src/main/flow-store.js';
import { FlowsService } from '../src/main/flows-host.js';
import { flowTools } from '../src/main/mcp-tools-flows.js';
import type { Caller } from '../src/main/mcp-tools.js';
import { FlowRow } from '../src/renderer/components/FeatureSurfaces.js';
import { FlowPills, StopFlowButton } from '../src/renderer/components/FlowPills.js';
import type { FeatureAction } from '../src/renderer/features.js';

/**
 * TYNN #833 — "I should be able to stop a flow." Nothing could end a run once it started: the scheduler kept only its
 * promise, and the engine's own abort is looked at only BETWEEN steps, so a command, an agent wait or a Wait held the run
 * (and the title bar's pill) until it ended by itself.
 *
 * Stop now ends the run AT ONCE, whatever step it is on: the flow's running command is killed (its supervised process
 * stopped), any other running step is let go, nothing after it runs, and the run is recorded `stopped` by whoever stopped
 * it — out of flight, so the pill clears. A stopped run is not retried: the next fire or Run now is a new run. The person
 * stops a run from the title bar's pill and from the Flows view; an agent stops one it made itself, and a person's flow
 * only with the person's approval.
 */

const USER = { kind: 'user' } as const;
const n = (id: string, kind: string, config: Record<string, unknown> = {}, x = 0) => ({ id, kind, position: { x, y: 0 }, config });
const e = (source: string, target: string) => ({ id: `${source}-${target}`, source, target });
const doc = (nodes: unknown[], edges: unknown[]) => ({ $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes, edges } });
const homes: string[] = [];
afterEach(async () => { for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

/** The supervisor as a flow's command sees it: a command that never exits by itself, and a Stop that ends it. */
function supervisor() {
    const listeners = new Set<(s: { id: string; state: string; exitCode?: number }) => void>();
    const states = new Map<string, { id: string; state: string }>();
    const stopped: string[] = [];
    const sup = {
        start: (o: { id: string }) => { states.set(o.id, { id: o.id, state: 'running' }); },
        status: (id: string) => states.get(id) ?? null,
        onChange: (l: (s: { id: string; state: string }) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
        readLog: () => ({ text: '' }),
        stop: (id: string) => { stopped.push(id); const s = { id, state: 'stopped' }; states.set(id, s); for (const l of [...listeners]) l(s); return true; },
    };
    return { sup, stopped, states };
}

async function setup(nodes: unknown[], edges: unknown[], extra: Partial<FlowPorts> = {}) {
    const home = await mkdtemp(join(tmpdir(), 'genie2-stop-833-'));
    homes.push(home);
    const store = await FlowStore.open(home);
    const flow = await store.create({ workspaceId: 'ws', name: 'nightly report', by: USER, document: doc(nodes, edges) });
    const s = supervisor();
    const processId = `flow-run:${flow.id}`;
    const ports = (): FlowPorts => ({
        runCommand: supervisedCommand({ supervisor: s.sup as never, workspacePath: () => home }, { processId, name: 'flow: nightly report' }),
        stopCommand: () => { s.sup.stop(processId); },
        promptAgent: async () => '',
        addKnowledge: async () => ({ id: 'k' }),
        ...extra,
    });
    const scheduler = new FlowScheduler({ store, now: Date.now, schedule: () => () => {}, run: createFlowRunner({ asleep: () => false, ports }) });
    const runs = () => store.get(flow.id)!.runs;
    return { store, scheduler, flowId: flow.id, processId, s, runs };
}

const commandFlow = (): [unknown[], unknown[]] => [[n('t', 'manual_trigger'), n('c', 'genie/terminal_run', { workspace: 'ws', command: 'python long.py' }, 200), n('l', 'log', { level: 'info', message: 'after' }, 400)], [e('t', 'c'), e('c', 'l')]];

describe('Stop ends a running flow at once, whatever step it is on (Tynn #833)', () => {
    it('during a COMMAND: its process is stopped, the run is recorded stopped by you, nothing after it runs, the pill clears', async () => {
        const f = await setup(...commandFlow());
        void f.scheduler.runNow(f.flowId).catch(() => {});
        await vi.waitFor(() => expect(f.s.states.get(f.processId)?.state).toBe('running'), { timeout: 2_000, interval: 10 });
        expect(flowPillSignals(f.store.list(), Date.now()).flowsLive.map((x) => x.flowId)).toEqual([f.flowId]);
        expect(await f.scheduler.stopRun(f.flowId, USER)).toEqual({ ok: true });
        await vi.waitFor(() => expect(f.runs()).toHaveLength(1), { timeout: 2_000, interval: 10 });
        expect(f.runs()[0]).toMatchObject({ outcome: 'stopped', stoppedBy: 'you', reason: expect.stringMatching(/stopped by you/), nodes: { t: 'ran', c: 'stopped', l: 'not reached' } });
        expect(f.s.stopped).toEqual([f.processId]);
        expect(f.store.get(f.flowId)!.inFlight).toBeUndefined();
        const pills = flowPillSignals(f.store.list(), Date.now());
        expect(pills.flowsLive).toEqual([]);
        expect(pills.flowsEnded).toEqual([]);
    });

    it('during an AGENT WAIT (a step waiting for a reply that never comes): the step is let go, the run stopped', async () => {
        const f = await setup([n('t', 'manual_trigger'), n('p', 'genie/agent_prompt', { agent: 'claude:atlas', prompt: 'x', waitForReply: true }, 200)], [e('t', 'p')], { promptAgent: () => new Promise<string>(() => {}) });
        void f.scheduler.runNow(f.flowId).catch(() => {});
        await vi.waitFor(() => expect(f.store.get(f.flowId)!.inFlight?.nodes.p).toBe('running'), { timeout: 2_000, interval: 10 });
        expect(await f.scheduler.stopRun(f.flowId, USER)).toEqual({ ok: true });
        await vi.waitFor(() => expect(f.runs()).toHaveLength(1), { timeout: 2_000, interval: 10 });
        expect(f.runs()[0]).toMatchObject({ outcome: 'stopped', stoppedBy: 'you', nodes: { t: 'ran', p: 'stopped' } });
    });

    it('during a WAIT step: let go at once, not at the end of its hour', async () => {
        const f = await setup([n('t', 'manual_trigger'), n('w', 'wait', { mode: 'duration', duration: '1h' }, 200)], [e('t', 'w')], { sleep: () => new Promise<void>(() => {}) });
        void f.scheduler.runNow(f.flowId).catch(() => {});
        await vi.waitFor(() => expect(f.store.get(f.flowId)!.inFlight?.nodes.w).toBe('running'), { timeout: 2_000, interval: 10 });
        expect(await f.scheduler.stopRun(f.flowId, USER)).toEqual({ ok: true });
        await vi.waitFor(() => expect(f.runs()).toHaveLength(1), { timeout: 2_000, interval: 10 });
        expect(f.runs()[0]).toMatchObject({ outcome: 'stopped', nodes: { w: 'stopped' } });
    });

    it('a stopped run is NOT retried, and does not hold the next: Run now afterwards is a new run that ran', async () => {
        let first = true;
        const f = await setup([n('t', 'manual_trigger'), n('w', 'wait', { mode: 'duration', duration: '1h' }, 200)], [e('t', 'w')], { sleep: () => { if (first) { first = false; return new Promise<void>(() => {}); } return Promise.resolve(); } });
        void f.scheduler.runNow(f.flowId).catch(() => {});
        await vi.waitFor(() => expect(f.store.get(f.flowId)!.inFlight?.nodes.w).toBe('running'), { timeout: 2_000, interval: 10 });
        expect(await f.scheduler.stopRun(f.flowId, USER)).toEqual({ ok: true });
        await vi.waitFor(() => expect(f.runs()).toHaveLength(1), { timeout: 2_000, interval: 10 });
        await f.scheduler.settled();
        await f.scheduler.runNow(f.flowId);
        expect(f.runs().map((r) => r.outcome)).toEqual(['stopped', 'ran']);
    });

    it('CONTROL: Stop with no run going answers so, and records nothing', async () => {
        const f = await setup(...commandFlow());
        expect(await f.scheduler.stopRun(f.flowId, USER)).toEqual({ ok: false, reason: expect.stringMatching(/not running/) });
        expect(f.runs()).toEqual([]);
    });

    it('Stop twice: the second answers not running; one run is recorded', async () => {
        const f = await setup(...commandFlow());
        void f.scheduler.runNow(f.flowId).catch(() => {});
        await vi.waitFor(() => expect(f.s.states.get(f.processId)?.state).toBe('running'), { timeout: 2_000, interval: 10 });
        expect(await f.scheduler.stopRun(f.flowId, USER)).toEqual({ ok: true });
        await vi.waitFor(() => expect(f.runs()).toHaveLength(1), { timeout: 2_000, interval: 10 });
        await f.scheduler.settled();
        expect(await f.scheduler.stopRun(f.flowId, USER)).toMatchObject({ ok: false });
        expect(f.runs()).toHaveLength(1);
    });
});

describe('the person\'s Stop reaches the host\'s scheduler (Tynn #833)', () => {
    it('a window\'s flows.stopRun is a call the host answers (the replica\'s path), as the person', async () => {
        const f = await setup(...commandFlow());
        const service = new FlowsService({ store: f.store, scheduler: f.scheduler });
        void f.scheduler.runNow(f.flowId).catch(() => {});
        await vi.waitFor(() => expect(f.s.states.get(f.processId)?.state).toBe('running'), { timeout: 2_000, interval: 10 });
        await expect(service.call('stopRun', [f.flowId, USER])).resolves.toEqual({ ok: true });
        await vi.waitFor(() => expect(f.runs()).toHaveLength(1), { timeout: 2_000, interval: 10 });
        expect(f.runs()[0]).toMatchObject({ outcome: 'stopped', stoppedBy: 'you' });
    });
});

describe('Stop in the title bar\'s pill and the Flows view (Tynn #833)', () => {
    const NOW = 1_000_000;
    const pill = (state: FlowPill['state']): FlowPill => ({ flowId: 'flow_a', name: 'nightly report', workspaceId: 'w1', state });
    const live = { flowId: 'flow_a', name: 'nightly report', workspaceId: 'w1', at: new Date(NOW - 1000).toISOString() };
    const failed = { flowId: 'flow_b', name: 'weekly', workspaceId: 'w1', outcome: 'failed' as const, endedAt: new Date(NOW - 1000).toISOString() };

    it('a running (and a paused) pill has a Stop button; a failed or held one does not', () => {
        const html = renderToStaticMarkup(createElement(FlowPills, { live: [live], ended: [failed], now: NOW, onOpen: () => {}, onStop: () => {} }));
        expect(html).toContain('data-flow-stop="flow_a"');
        expect(html).toContain('aria-label="Stop nightly report"');
        expect(html).not.toContain('data-flow-stop="flow_b"');
    });

    it('the pill\'s Stop is a react-fancy Button that stops THAT flow, and does not open it', () => {
        const stopped: string[] = [];
        for (const state of ['running', 'paused'] as const) {
            const el = StopFlowButton({ pill: pill(state), onStop: (id) => stopped.push(id) }) as { type?: unknown; props?: Record<string, unknown> } | null;
            expect(el?.type).toBe(Button);
            (el!.props!.onClick as (ev: { stopPropagation(): void }) => void)({ stopPropagation: () => {} });
        }
        expect(stopped).toEqual(['flow_a', 'flow_a']);
    });

    const view = (over: Partial<FlowRecord> = {}): FlowRecord => ({
        id: 'flow_a', workspaceId: 'w1', name: 'nightly report', armed: true, createdBy: USER, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', refusals: [], runs: [],
        document: doc([n('t', 'manual_trigger'), n('c', 'genie/terminal_run', { workspace: 'w1', command: 'npm run report' }, 200)], [e('t', 'c')]),
        ...over,
    });
    const press = (node: unknown, label: string): void => {
        const walk = (x: unknown): void => {
            if (x === null || typeof x !== 'object') return;
            if (Array.isArray(x)) { x.forEach(walk); return; }
            const el = x as { type?: unknown; props?: Record<string, unknown> };
            if (el.type === Button && el.props?.children === label && typeof el.props.onClick === 'function') (el.props.onClick as () => void)();
            walk(el.props?.children);
        };
        walk(node);
    };
    const row = (flow: FlowRecord, sent: FeatureAction[]) => FlowRow({ flow: flow as never, workspaces: [], now: NOW, confirming: null, onAction: (a) => { sent.push(a); }, onAsk: () => {} });

    it('a flow row with a run going has Stop, which sends flows.stop; CONTROL: a row with none has no Stop', () => {
        const sent: FeatureAction[] = [];
        press(row(view({ inFlight: { at: new Date(NOW).toISOString(), trigger: 'manual', nodes: { t: 'ran', c: 'running' } } }), sent), 'Stop');
        expect(sent).toEqual([{ kind: 'flows.stop', flowId: 'flow_a' }]);
        const idle: FeatureAction[] = [];
        press(row(view(), idle), 'Stop');
        expect(idle).toEqual([]);
        expect(renderToStaticMarkup(createElement(FlowRow, { flow: view() as never, workspaces: [], now: NOW, confirming: null, onAction: () => {}, onAsk: () => {} }))).not.toContain('data-flow-stop');
    });

    it('a run the person stopped reads "stopped by you"; CONTROL: one Genie\'s quit stopped still reads "stopped by quit"', () => {
        const run = (over: Record<string, unknown>) => ({ at: '2026-11-01T00:00:00.000Z', endedAt: '2026-11-01T00:00:01.000Z', trigger: 'manual' as const, outcome: 'stopped' as const, ...over });
        const html = (r: Record<string, unknown>) => renderToStaticMarkup(createElement(FlowRow, { flow: view({ runs: [run(r) as never] }) as never, workspaces: [], now: NOW, confirming: null, onAction: () => {}, onAsk: () => {} }));
        // The row prints the run's reason too, so the reason here never carries the words the LABEL is judged by.
        expect(html({ stoppedBy: 'you', reason: 'the person pressed Stop' })).toContain('stopped by you');
        expect(html({ stoppedBy: 'atlas', reason: 'an agent pressed Stop' })).toContain('stopped by atlas');
        expect(html({ reason: 'Genie quit while this run was going' })).toContain('stopped by quit');
        expect(html({ reason: 'Genie quit while this run was going' })).not.toContain('stopped by you');
    });
});

describe('an agent\'s Stop: its own flow, or the person\'s with the person\'s approval (Tynn #833)', () => {
    async function agentTool(options: { approve?: 'allowed' | 'denied' | 'absent' } = {}) {
        const home = await mkdtemp(join(tmpdir(), 'genie2-stop-833-tool-'));
        homes.push(home);
        const store = await FlowStore.open(home);
        const agentId = mintAgentId();
        const caller: Caller = { agentId, agentName: 'atlas', workspaceId: 'ws', workspacePath: home };
        const persons = await store.create({ workspaceId: 'ws', name: 'the person\'s', by: USER, document: doc([n('t', 'manual_trigger')], []) });
        const own = await store.create({ workspaceId: 'ws', name: 'atlas\'s own', by: { kind: 'agent', id: agentId, name: 'atlas' }, document: doc([n('t', 'manual_trigger')], []) });
        const stops: Array<[string, unknown]> = [];
        const asked: Array<[string, string]> = [];
        const verdict: 'allowed' | 'denied' = options.approve === 'allowed' ? 'allowed' : 'denied';
        const tool = flowTools({
            resolveCaller: () => caller,
            flows: {
                store, runNow: async () => { throw new Error('not here'); },
                stopRun: async (id, by) => { stops.push([id, by]); return { ok: true }; },
                ...(options.approve === 'absent' ? {} : { approve: async (_c: Caller, action: string, detail: string) => { asked.push([action, detail]); return verdict; } }),
            },
        }).find((t) => t.definition.name === 'flows')!;
        const stop = async (id: string) => { const r = await tool.handler({ action: 'stop', id, terminalId: 'term-1' }, { server: 'genie', tool: 'flows', headers: {} }); return { ...r, json: JSON.parse(r.text) as Record<string, unknown> }; };
        return { persons, own, stops, asked, stop, agentId };
    }

    it('its OWN flow: stopped, as the agent, with nobody asked', async () => {
        const t = await agentTool();
        const r = await t.stop(t.own.id);
        expect(r.isError).toBe(false);
        expect(t.stops).toEqual([[t.own.id, { kind: 'agent', id: t.agentId, name: 'atlas' }]]);
        expect(t.asked).toEqual([]);
    });

    it('the PERSON\'S flow, approval DENIED: refused in words, nothing stopped', async () => {
        const t = await agentTool({ approve: 'denied' });
        const r = await t.stop(t.persons.id);
        expect(r.isError).toBe(true);
        expect(String(r.json.error)).toMatch(/approv/);
        expect(t.asked.map(([a]) => a)).toEqual(['flows.stop']);
        expect(t.stops).toEqual([]);
    });

    it('the PERSON\'S flow, approval GIVEN: stopped', async () => {
        const t = await agentTool({ approve: 'allowed' });
        const r = await t.stop(t.persons.id);
        expect(r.isError).toBe(false);
        expect(t.stops.map(([id]) => id)).toEqual([t.persons.id]);
    });

    it('the PERSON\'S flow with nobody to ask: refused, nothing stopped', async () => {
        const t = await agentTool({ approve: 'absent' });
        const r = await t.stop(t.persons.id);
        expect(r.isError).toBe(true);
        expect(t.stops).toEqual([]);
    });

    it('stopping a person\'s flow is never auto-approved by an agent\'s autonomy', () => {
        expect(PERSON_ONLY_ACTIONS).toContain('flows.stop');
    });
});
