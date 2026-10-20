import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { SessionDriverFactory } from '../src/core/session.js';
import { GENIE_SKILLS } from '../src/main/agent-skills.js';
import { attentionTools } from '../src/main/mcp-tools-attention.js';
import type { Caller } from '../src/main/mcp-tools.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * EVERY AGENT CAN REPORT ITS PLAN (the owner, 2026-10-20: "why would you build an ActivePlan column and feature but then
 * not include any way for you to use it?"). The Active Plan column drew only a plan the PROVIDER reported, and the Claude
 * Code Genie runs reports none — so every Claude agent read "has not reported a plan yet", whatever it was doing, and the
 * column's tests (fed fake plan events) never noticed. Genie's own `plan` tool writes the caller's steps into ITS session
 * as the same plan event a provider sends, so the column and the Stream show it for any provider.
 */

const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };
const driverFor: DriverFor = () => {
    const factory: SessionDriverFactory = () => ({ start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } });
    return factory;
};
const steps = [
    { content: 'Review hosting', status: 'completed' },
    { content: 'Build the fixes', status: 'in_progress' },
    { content: 'Release beta.33', status: 'pending' },
];

let dir: string;
let host: SessionHost;
const record = (name: string): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name });

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-plan-tool-'));
    host = new SessionHost({ userData: dir, driverFor, clock: () => Date.UTC(2026, 9, 20, 12), processTree: noTree });
});
afterEach(async () => {
    host.stopAll();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe('the host takes a reported plan into the agent’s own session', () => {
    it('what the Active Plan column reads: 1 of 3 done, doing "Build the fixes"', () => {
        const a = record('tynn');
        host.start(a, dir);
        expect(host.probe(a.id)?.plan ?? null).toBeNull();
        expect(host.reportPlan(a.id, steps)).toBe(true);
        expect(host.probe(a.id)?.plan).toEqual({ step: 1, of: 3, doing: 'Build the fixes' });
    });

    it('a newer plan replaces the older one (CONTROL: the column follows the latest)', () => {
        const a = record('tynn');
        host.start(a, dir);
        host.reportPlan(a.id, steps);
        host.reportPlan(a.id, steps.map((s) => ({ ...s, status: 'completed' })));
        expect(host.probe(a.id)?.plan).toEqual({ step: 3, of: 3, doing: '' });
    });

    it('an agent that is not running has no session to hold it: refused', () => {
        expect(host.reportPlan(record('idle').id, steps)).toBe(false);
    });
});

describe('the `plan` tool', () => {
    const caller: Caller = { agentId: 'agent_t' as never, agentName: 'tynn', workspaceId: 'ws', workspacePath: '/w/tynn' };
    let reported: Array<{ agentId: string; steps: unknown }>;
    let running: boolean;
    const tool = () => {
        const regs = attentionTools({
            resolveCaller: (id) => (id === 'term_t' ? caller : null),
            openFile: async () => ({ ok: true }),
            reportPlan: (agentId, s) => { if (!running) return false; reported.push({ agentId, steps: s }); return true; },
        });
        const r = regs.find((x) => x.definition.name === 'plan');
        return async (args: Record<string, unknown>) => {
            const out = await r!.handler(args as never, { headers: {} } as never);
            return { ...JSON.parse(out.text), isError: out.isError } as Record<string, unknown>;
        };
    };
    beforeEach(() => { reported = []; running = true; });

    it('reports the caller’s steps, as the plan event’s entries', async () => {
        expect(await (tool())({ terminalId: 'term_t', steps })).toMatchObject({ ok: true, step: 1, of: 3, isError: false });
        expect(reported).toEqual([{ agentId: 'agent_t', steps }]);
    });

    it('refuses, in words, a step with an unknown status, no steps, or a caller Genie does not know — and reports nothing', async () => {
        const call = tool();
        expect(await call({ terminalId: 'term_t', steps: [{ content: 'x', status: 'done' }] })).toMatchObject({ isError: true });
        expect(await call({ terminalId: 'term_t', steps: [] })).toMatchObject({ isError: true });
        expect(await call({ terminalId: 'term_t', steps: [{ content: '', status: 'pending' }] })).toMatchObject({ isError: true });
        expect(await call({ terminalId: 'nobody', steps })).toMatchObject({ isError: true });
        expect(reported).toEqual([]);
    });

    it('an agent not running is told so, not answered ok', async () => {
        running = false;
        expect(await (tool())({ terminalId: 'term_t', steps })).toMatchObject({ isError: true });
    });
});

describe('agents are told to use it', () => {
    it('the genie skill names `plan` and when to use it', () => {
        const body = GENIE_SKILLS.find((s) => s.name === 'genie')!.body;
        expect(body).toMatch(/`plan`/);
        expect(body).toMatch(/Active Plan/);
    });
});
