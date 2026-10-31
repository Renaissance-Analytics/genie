import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { AgentRecord } from '../src/core/identity.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import type { AgentSessionsPort } from '../src/main/flow-runner.js';
import type { PtyPort, PtySpawnOptions } from '../src/main/terminal-host.js';

/**
 * THE COMPOSITION ROOT RUNS FLOWS (hosting ship line P4). It used to hand the scheduler `run: async () => {}`;
 * now a fired flow goes through the runner with the real supervisor, the roster and the live sessions main.ts
 * wires. Proven here at the composition root, with a scripted pty and fake sessions — no Electron, no agent.
 */

function scriptedPty() {
    const opened: Array<PtySpawnOptions & { id: string }> = [];
    const data = new Set<(id: string, d: string) => void>();
    const exits = new Set<(id: string, code: number) => void>();
    let n = 0;
    const port: PtyPort = {
        open(o) {
            const id = `pty_${++n}`;
            opened.push({ ...o, id });
            setTimeout(() => {
                for (const l of data) l(id, `ran: ${o.command}\n`);
                for (const l of exits) l(id, 0);
            }, 0);
            return { id, pid: 8000 + n, shell: 'sh', scrollback: '' };
        },
        write: () => true,
        resize: () => true,
        kill: () => true,
        scrollback: () => '',
        onData: (l) => { data.add(l); return () => { data.delete(l); }; },
        onExit: (l) => { exits.add(l); return () => { exits.delete(l); }; },
    };
    return { port, opened };
}

const trigger = { id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 3 * * *' } };
const doc = (step: Record<string, unknown>) => ({ $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [trigger, { id: 's', position: { x: 240, y: 0 }, ...step }], edges: [{ id: 'e1', source: 't', target: 's' }] } });

let dir: string;
let pty: ReturnType<typeof scriptedPty>;
let services: ComposedServices;
let turnState = 'idle';
const prompted: string[] = [];
const sessions: AgentSessionsPort = {
    session: (id) => (id === 'agent_atlas' ? { running: true, turnState, pendingApproval: null } : null),
    rows: () => [],
    prompt: (_id, text) => { prompted.push(text); return true; },
    subscribe: () => () => {},
};
const roster = [{ id: 'agent_atlas', workspaceId: 'ws-example', provider: 'claude', name: 'atlas', instructions: null, threadId: null, createdAt: '2026-10-12T00:00:00.000Z', lastUsedAt: null }] as unknown as AgentRecord[];
let asleep = false;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-compose-flows-'));
    pty = scriptedPty();
    turnState = 'idle';
    prompted.length = 0;
    asleep = false;
    services = await composeServices({
        userData: dir,
        pty: pty.port,
        v1Settings: () => null,
        caddyBin: null,
        frontDoorPort: 0,
        roster: () => roster,
        workspaces: () => [{ id: 'ws-example', path: dir, asleep }],
        agentSessions: sessions,
    });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('a flow run through the composed services', () => {
    it('a command step runs ONCE as a supervised process in the workspace, the run is recorded ran, and its output is kept in the process log', async () => {
        const f = await services.flows.create({ workspaceId: 'ws-example', name: 'report', document: doc({ kind: 'genie/terminal_run', config: { workspace: 'ws-example', command: 'npm run report' } }), by: { kind: 'user' } });
        const run = await services.flowScheduler.runNow(f.id);
        expect(run).toMatchObject({ trigger: 'manual', outcome: 'ran' });
        expect(pty.opened.map((o) => [o.command, o.cwd])).toEqual([['npm run report', dir]]);
        expect(services.supervisor.status(`flow-run:${f.id}`)).toMatchObject({ state: 'exited', exitCode: 0, workspaceId: 'ws-example' });
        expect(services.supervisor.log(`flow-run:${f.id}`)).toContain('ran: npm run report');
    });

    it('a prompt to an agent mid-turn is HELD back (never delivered); idle, the agent is prompted', async () => {
        const f = await services.flows.create({ workspaceId: 'ws-example', name: 'standup', document: doc({ kind: 'genie/agent_prompt', config: { agent: 'claude:atlas', prompt: 'post the standup' } }), by: { kind: 'user' } });
        turnState = 'working';
        expect(await services.flowScheduler.runNow(f.id)).toMatchObject({ outcome: 'held', reason: 'atlas is busy (mid-turn); the prompt was not delivered, so it never lands inside another turn' });
        expect(prompted).toEqual([]);
        turnState = 'idle';
        // The fake session stays idle after the prompt, so the turn reads as already ended: the run completes.
        expect(await services.flowScheduler.runNow(f.id)).toMatchObject({ outcome: 'ran' });
        expect(prompted).toEqual(['post the standup']);
    });

    it('a TOOL step that runs before main has handed over Genie’s tools — a run resumed at launch — waits for them, rather than failing', async () => {
        // Found by the Flows acceptance suite: compose resumes the runs Genie quit under while it composes, and main hands the
        // flows Genie's tools only after (setFlowToolCaller). A resumed question, issues check or knowledge step — exactly
        // the tool kinds that are safe to resume — failed at once with "Genie's tools are not ready yet".
        const f = await services.flows.create({ workspaceId: 'ws-example', name: 'remember', document: doc({ kind: '@genie/knowledge', config: { action: 'add', title: 'T' } }), by: { kind: 'user' } });
        const calls: string[] = [];
        const going = services.flowScheduler.runNow(f.id);
        await new Promise((r) => setTimeout(r, 50));
        services.setFlowToolCaller(async (_flow, tool) => { calls.push(tool); return { ok: true, result: { ok: true } }; });
        expect(await going).toMatchObject({ outcome: 'ran' });
        expect(calls).toEqual(['knowledge']);
    });

    it('a hibernated workspace holds every run back and starts nothing', async () => {
        const f = await services.flows.create({ workspaceId: 'ws-example', name: 'report', document: doc({ kind: 'genie/terminal_run', config: { workspace: 'ws-example', command: 'npm run report' } }), by: { kind: 'user' } });
        asleep = true;
        expect(await services.flowScheduler.runNow(f.id)).toMatchObject({ outcome: 'held', reason: 'its workspace ws-example is hibernated; nothing runs there until it is woken' });
        expect(pty.opened).toEqual([]);
    });
});

describe('a quit leaves no flow timer behind (genie#1351)', () => {
    it('after shutdown the scheduler holds no timer, and arming a flow does not plan one: nothing fires or writes after the quit', async () => {
        const f = await services.flows.create({ workspaceId: 'ws-example', name: 'nightly', document: doc({ kind: 'genie/terminal_run', config: { workspace: 'ws-example', command: 'npm run report' } }), by: { kind: 'user' }, armed: true });
        services.flowScheduler.plan();
        expect(services.flowScheduler.nextDue()).toMatchObject({ flowId: f.id });
        await services.shutdown();
        expect(services.flowScheduler.nextDue()).toBeNull();
        services.flowScheduler.plan();
        expect(services.flowScheduler.nextDue()).toBeNull();
    });
});
