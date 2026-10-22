import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { PlanKeepalive } from '../src/core/plan-keepalive.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { LiveSession } from '../src/core/roster.js';
import type { DriverEvents, SessionDriver, SessionDriverFactory } from '../src/core/session.js';
import { attentionTools } from '../src/main/mcp-tools-attention.js';
import type { Caller } from '../src/main/mcp-tools.js';
import { Registry } from '../src/main/registry.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { Store } from '../src/main/store.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * AN AGENT'S PLAN SURVIVES A RESTART (the owner, 2026-10-21: "what happened to your active plan. The plan loaded in genie
 * should survive a restart, how else will agents know what to pick up on."). The Active Plan column read the plan from
 * the CURRENT run's rows only, and every run starts with none — so a Genie relaunch, an agent restart, or a setting that
 * restarts the session (Tools) emptied the column and left a restarted agent with nothing to pick up from. The plan is
 * kept on the agent's record now, seeded into each run, and the `plan` tool reads it back.
 */

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'genie2-plan-kept-')); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };

function fakeDriver() {
    let events: DriverEvents = {};
    const prompts: string[] = [];
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        const driver: SessionDriver = { start: () => {}, prompt: (text: unknown) => { prompts.push(String(text)); }, kill: () => {}, cliSessionId: null };
        return driver;
    };
    return {
        factory,
        prompts,
        update: (u: Record<string, unknown>) => events.onUpdate?.(u),
        endTurn: () => events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null }),
    };
}

const steps = [
    { content: 'Review hosting', status: 'completed' },
    { content: 'Build the fixes', status: 'in_progress' },
    { content: 'Release beta.33', status: 'pending' },
];
const record = (over: Partial<AgentRecord> = {}): AgentRecord => ({ ...agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'tynn' }), ...over });

describe('every plan the run takes is handed out to be kept', () => {
    it('the `plan` tool’s, and a PROVIDER’s (Codex reports its own): each reaches onPlan with its steps', () => {
        const dir = tempDir();
        const d = fakeDriver();
        const kept: Array<{ agentId: string; steps: unknown }> = [];
        const host = new SessionHost({ userData: dir, driverFor: () => d.factory, processTree: noTree, onPlan: (agentId, s) => { kept.push({ agentId, steps: s }); } });
        const a = record();
        host.start(a, dir);
        host.reportPlan(a.id, steps);
        d.update({ sessionUpdate: 'plan_update', entries: [{ content: 'Codex step', status: 'in_progress', priority: 'high' }] });
        expect(kept).toEqual([
            { agentId: a.id, steps },
            { agentId: a.id, steps: [{ content: 'Codex step', status: 'in_progress' }] },
        ]);
        host.stopAll();
    });
});

describe('a run started for an agent whose record carries a plan', () => {
    it('shows it AT ONCE — the column’s step/of and the steps — before the agent says anything', () => {
        const dir = tempDir();
        const host = new SessionHost({ userData: dir, driverFor: () => fakeDriver().factory, processTree: noTree });
        const a = record({ plan: steps });
        host.start(a, dir);
        const live = host.probe(a.id);
        expect(live?.plan).toEqual({ step: 1, of: 3, doing: 'Build the fixes' });
        expect(live?.planSteps).toEqual(steps);
        host.stopAll();
    });

    it('CONTROL: a record with no plan starts with none — never a fabricated 0/0', () => {
        const dir = tempDir();
        const host = new SessionHost({ userData: dir, driverFor: () => fakeDriver().factory, processTree: noTree });
        const a = record();
        host.start(a, dir);
        expect(host.probe(a.id)?.plan).toBeNull();
        expect(host.probe(a.id)?.planSteps ?? null).toBeNull();
        host.stopAll();
    });

    it('a plan reported in the new run replaces the kept one', () => {
        const dir = tempDir();
        const host = new SessionHost({ userData: dir, driverFor: () => fakeDriver().factory, processTree: noTree });
        const a = record({ plan: steps });
        host.start(a, dir);
        const done = steps.map((s) => ({ ...s, status: 'completed' }));
        host.reportPlan(a.id, done);
        expect(host.probe(a.id)?.plan).toEqual({ step: 3, of: 3, doing: '' });
        expect(host.probe(a.id)?.planSteps).toEqual(done);
        host.stopAll();
    });
});

describe('the whole road: reported → kept on the record → a relaunched Genie shows it', () => {
    it('across a new Registry over the same store, and after a FRESH restart (a new conversation)', async () => {
        const dir = tempDir();
        const registry = new Registry(new Store(dir));
        await registry.load({ name: 'example-host', healthy: true });
        await registry.addWorkspace({ id: 'example', path: dir });
        const a = await registry.register({ workspaceId: 'example', provider: 'claude', name: 'atlas' });
        const writes: Promise<unknown>[] = [];
        const first = new SessionHost({ userData: dir, driverFor: () => fakeDriver().factory, processTree: noTree, onPlan: (id, s) => { writes.push(registry.setPlan(id, s)); } });
        first.start(registry.find(a.id)!, dir);
        first.reportPlan(a.id, steps);
        await Promise.all(writes);
        first.stopAll();

        const reopened = new Registry(new Store(dir));
        await reopened.load({ name: 'example-host', healthy: true });
        expect(reopened.find(a.id)?.plan).toEqual(steps);
        // A fresh restart drops the conversation on purpose — not the plan.
        await reopened.clearThread(a.id);
        expect(reopened.find(a.id)?.plan).toEqual(steps);

        const second = new SessionHost({ userData: dir, driverFor: () => fakeDriver().factory, processTree: noTree });
        second.start(reopened.find(a.id)!, dir);
        expect(second.probe(a.id)?.plan).toEqual({ step: 1, of: 3, doing: 'Build the fixes' });
        second.stopAll();
    });
});

describe('the plan keepalive works from the kept plan after a restart', () => {
    it('no nudge at start (no turn has ended); one after the first replied turn, naming the kept step in progress', () => {
        const dir = tempDir();
        const d = fakeDriver();
        const host = new SessionHost({ userData: dir, driverFor: () => d.factory, processTree: noTree });
        const a = record({ plan: steps, mode: 'automated' });
        host.start(a, dir);
        const timers: Array<() => void> = [];
        const nudges: string[] = [];
        const keepalive = new PlanKeepalive({
            graceMs: 1,
            schedule: (_ms, fn) => { timers.push(fn); return () => {}; },
            read: (id) => {
                const live = host.probe(id as never);
                return live ? { mode: a.mode, lastTurnEnd: host.lastTurnEnd(id as never), plan: live.plan ?? null, promptable: host.promptable(id as never) != null, waitingOnPerson: false, background: live.background ?? null } : null;
            },
            prompt: (_id, text) => { nudges.push(text); },
            stalled: () => {},
        });
        keepalive.turnEnded(a.id);
        expect(timers).toEqual([]);
        host.prompt(a.id, 'hello again');
        d.endTurn();
        keepalive.turnEnded(a.id);
        expect(timers.length).toBe(1);
        timers[0]!();
        expect(nudges).toHaveLength(1);
        expect(nudges[0]).toContain('"Build the fixes"');
        host.stopAll();
    });
});

describe('the `plan` tool reads the plan back', () => {
    const caller: Caller = { agentId: 'agent_t' as never, agentName: 'tynn', workspaceId: 'ws', workspacePath: '/w/tynn' };
    const tool = (stored: readonly { content: string; status: string }[] | null, reported: unknown[]) => {
        const regs = attentionTools({
            resolveCaller: (id) => (id === 'term_t' ? caller : null),
            openFile: async () => ({ ok: true }),
            reportPlan: (_agentId, s) => { reported.push(s); return true; },
            readPlan: (agentId) => (agentId === 'agent_t' ? stored : null),
        });
        const r = regs.find((x) => x.definition.name === 'plan')!;
        return {
            definition: r.definition,
            call: async (args: Record<string, unknown>) => {
                const out = await r.handler(args as never, { headers: {} } as never);
                return { ...JSON.parse(out.text), isError: out.isError } as Record<string, unknown>;
            },
        };
    };

    it('called with no `steps`, it answers the kept steps — and reports nothing', async () => {
        const reported: unknown[] = [];
        expect(await tool(steps, reported).call({ terminalId: 'term_t' })).toEqual({ ok: true, steps, step: 1, of: 3, isError: false });
        expect(reported).toEqual([]);
    });

    it('nothing kept: says so, not an error and never 0/0', async () => {
        expect(await tool(null, []).call({ terminalId: 'term_t' })).toMatchObject({ ok: true, steps: null, isError: false });
    });

    it('CONTROL: an empty `steps` is still a refused write, not a read', async () => {
        expect(await tool(steps, []).call({ terminalId: 'term_t', steps: [] })).toMatchObject({ isError: true });
    });

    it('`steps` is no longer required, and the description says how to read it back', () => {
        const { definition } = tool(null, []);
        const schema = JSON.parse(JSON.stringify(definition)) as Record<string, unknown>;
        expect(JSON.stringify(schema)).not.toMatch(/"required":\["steps"\]/);
        expect(JSON.stringify(schema)).toMatch(/without `steps`/);
    });
});

describe('the Active Plan column after a restart', () => {
    it('draws the kept steps from the session when no plan row is in the rows yet', () => {
        const agent = { id: 'a1', name: 'sable', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
        const session = { running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: { step: 1, of: 3, doing: 'Build the fixes' }, planSteps: steps } as unknown as LiveSession;
        const html = renderToStaticMarkup(<AgentView agent={agent} session={session} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 2_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} />);
        const column = html.slice(html.indexOf('data-plan-column='));
        expect((column.match(/data-plan-step=/g) ?? []).length).toBe(3);
        expect(column).toMatch(/data-plan-step="in_progress"[^>]*data-current="true"/);
    });
});
