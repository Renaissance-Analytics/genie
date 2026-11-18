import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flowPillSignals } from '../src/core/flow-pill-signals.js';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { Resolution } from '../src/core/inbox.js';
import { agentPrompter, createFlowRunner, type AgentSessionsPort } from '../src/main/flow-runner.js';
import { FlowScheduler } from '../src/main/flow-scheduler.js';
import { FlowStore } from '../src/main/flow-store.js';
import { runtimeDir } from '../src/main/paths.js';
import { readJson } from '../src/main/store.js';

/**
 * TYNN #826, THE TITLE BAR: the owner's screenshot showed a flow's prompt delivered to the agent at 19:09 (in its chat as
 * `flow "…" → agent · 19:09`, and acted on) while the title bar's flow pill still read RUNNING. The pill reads the flow's
 * run IN FLIGHT (core/flow-pill-signals.ts: `inFlight` → a live pill), and the run stayed in flight because the prompt
 * step waited for the agent's whole turn — a turn waiting on a long background job.
 *
 * So: once the prompt is delivered the run ends, its in-flight record goes in the same write as the run (flow-store.ts
 * `recordRun`), and the pill clears. A run left in flight by a Genie from before the upgrade (a prompt step mid-wait when
 * it quit) is settled `stopped` when the store opens, so it is never drawn as running for ever. CONTROL: a step that asks
 * to wait for the reply on that same never-ending turn IS drawn running — the gauge can read running at all.
 *
 * The session is inert (no agent runs): an agent mid-turn on a job that does not end inside the test. It answers both the
 * port a flow used before this fix (`queue`, Tynn #704) and the one it uses now (`deliver`), as the host does.
 */

const AGENT = 'agent_lift';
const BY = 'flow "parity refresh"';
const resolve = (text: string): Resolution => (text === 'claude:lift' ? { kind: 'one', id: AGENT as never } : { kind: 'none' });
const n = (id: string, kind: string, config: Record<string, unknown> = {}, x = 0) => ({ id, kind, position: { x, y: 0 }, config });
const e = (source: string, target: string) => ({ id: `${source}-${target}`, source, target });
const doc = (nodes: unknown[], edges: unknown[]) => ({ $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes, edges } });
const homes: string[] = [];
afterEach(async () => { for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

/** An agent mid-turn on a long job (Claude: a message mid-turn is read at its next step). Its turn never ends here. */
function busyAgent() {
    const rows: Array<{ event: unknown }> = [{ event: { kind: 'turn', by: 'you' } }];
    const listeners = new Set<(id: string) => void>();
    const delivered: string[] = [];
    const queued: Array<{ id: string; text: string }> = [];
    let k = 0;
    const port = {
        session: () => ({ running: true, turnState: 'working', pendingApproval: null, background: 1 }),
        rows: () => rows,
        prompt: () => false,
        subscribe: (l: (id: string) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
        // The port a flow uses now (Tynn #826): handed into the running turn.
        deliver: (_id: string, text: string) => { delivered.push(text); rows.push({ event: { kind: 'message', speaker: 'peer', peerName: BY, text } }); return { id: null }; },
        // The port a flow used before (Tynn #704): held for the turn's end.
        queue: (_id: string, text: string) => { const id = `q${++k}`; queued.push({ id, text }); return { id }; },
        isQueued: (_id: string, promptId: string) => queued.some((q) => q.id === promptId),
    };
    return { port: port as unknown as AgentSessionsPort, delivered, queued };
}

async function scheduled(promptConfig: Record<string, unknown>) {
    const home = await mkdtemp(join(tmpdir(), 'genie2-pill-826-'));
    homes.push(home);
    const store = await FlowStore.open(home);
    const flow = await store.create({
        workspaceId: 'ws', name: 'parity refresh', by: { kind: 'user' },
        document: doc([n('t', 'manual_trigger'), n('c', 'genie/terminal_run', { workspace: 'ws', command: 'python refresh.py' }, 200), n('p', 'genie/agent_prompt', { agent: 'claude:lift', prompt: 'the refresh ran', ...promptConfig }, 400)], [e('t', 'c'), e('c', 'p')]),
    });
    const agent = busyAgent();
    const scheduler = new FlowScheduler({
        store, now: Date.now, schedule: () => () => {},
        run: createFlowRunner({
            asleep: () => false,
            ports: () => ({
                runCommand: async () => ({ exitCode: 0, output: 'parity: 45/345' }),
                promptAgent: agentPrompter({ sessions: agent.port, resolve, agent: () => ({ name: 'lift', workspaceId: 'ws' }), asleep: () => false, by: BY }),
                addKnowledge: async () => ({ id: 'k' }),
            }),
        }),
    });
    void scheduler.runNow(flow.id).catch(() => {});
    const pills = () => flowPillSignals(store.list(), Date.now());
    return { store, flowId: flow.id, agent, pills };
}

describe('the title bar\'s flow pill once the prompt is delivered (Tynn #826)', () => {
    it('the prompt is delivered to the busy agent, the run ENDS, and the pill clears (no live flow)', async () => {
        const s = await scheduled({});
        // Delivered to the agent, as in the owner's screenshot.
        await vi.waitFor(() => expect(s.agent.delivered.length + s.agent.queued.length).toBe(1), { timeout: 2_000, interval: 10 });
        await vi.waitFor(() => expect(s.store.get(s.flowId)!.runs.length).toBe(1), { timeout: 2_000, interval: 10 });
        expect(s.store.get(s.flowId)!.inFlight).toBeUndefined();
        expect(s.pills().flowsLive).toEqual([]);
        expect(s.store.get(s.flowId)!.runs.at(-1)).toMatchObject({ outcome: 'ran', nodes: { c: 'ran', p: 'delivered' } });
    });

    it('CONTROL: a step that asks to wait for the reply on that same unending turn IS drawn running', async () => {
        const s = await scheduled({ waitForReply: true });
        await vi.waitFor(() => expect(s.agent.delivered.length + s.agent.queued.length).toBe(1), { timeout: 2_000, interval: 10 });
        await vi.waitFor(() => expect(s.pills().flowsLive.map((f) => f.name)).toEqual(['parity refresh']), { timeout: 2_000, interval: 10 });
        expect(s.store.get(s.flowId)!.runs).toEqual([]);
    });
});

describe('a run left in flight by the Genie before the upgrade (Tynn #826)', () => {
    it('is settled STOPPED when the store opens: the pill never shows it running for ever', async () => {
        const home = await mkdtemp(join(tmpdir(), 'genie2-pill-826-old-'));
        homes.push(home);
        const store = await FlowStore.open(home);
        const flow = await store.create({ workspaceId: 'ws', name: 'parity refresh', by: { kind: 'user' }, document: doc([n('t', 'manual_trigger'), n('p', 'genie/agent_prompt', { agent: 'claude:lift', prompt: 'x' }, 200)], [e('t', 'p')]) });
        // The old build's prompt step, still waiting on the agent's turn (it read `queued`) when that Genie quit.
        await store.markInFlight(flow.id, { at: new Date(Date.now() - 3_600_000).toISOString(), trigger: 'schedule', nodes: { t: 'ran', p: 'queued' } });
        await store.flushed();
        const file = await readJson<{ flows: Array<{ id: string; inFlight?: unknown }> }>(join(runtimeDir(home), 'flows.json'), { flows: [] });
        expect(file.flows.find((f) => f.id === flow.id)?.inFlight).toBeDefined();

        const next = await FlowStore.open(home);
        expect(next.get(flow.id)!.inFlight).toBeUndefined();
        expect(flowPillSignals(next.list(), Date.now()).flowsLive).toEqual([]);
        expect(next.get(flow.id)!.runs.at(-1)).toMatchObject({ outcome: 'stopped', nodes: { t: 'ran', p: 'stopped' } });
    });
});
