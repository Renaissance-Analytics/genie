import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { documentToGraph, graphToDocument, type NodeOutcome } from '../src/core/flow-canvas.js';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { AgentRecord } from '../src/core/identity.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction } from '../src/main/feature-ipc.js';
import { createFlowRunner, type AgentSessionsPort } from '../src/main/flow-runner.js';
import { FlowScheduler } from '../src/main/flow-scheduler.js';
import { FlowStore, type FlowRecord, type FlowRun } from '../src/main/flow-store.js';
import type { PtyPort, PtySpawnOptions } from '../src/main/terminal-host.js';
import { FlowRunOverlay } from '../src/renderer/components/FlowEditorWindow.js';

/**
 * END TO END, ONE PER TRIGGER (genie#1204, acceptance (b), (c), (e)): a flow built on the canvas is saved through the
 * editor's own action, armed by the person, and its trigger fires — the schedule's timer, a file landing, Run now. Its
 * nodes execute for real at the composition root (a scripted pty, a real file move, a fake live agent session), the run is
 * recorded with every node's outcome, and the canvas overlay draws them. Then: a run Genie quits in the middle of is NOT
 * lost — the next launch records it "stopped" at the step it was on.
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
            setTimeout(() => { for (const l of data) l(id, `ran: ${o.command}\n`); for (const l of exits) l(id, 0); }, 0);
            return { id, pid: 8000 + n, shell: 'sh', scrollback: '' };
        },
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
        onData: (l) => { data.add(l); return () => { data.delete(l); }; },
        onExit: (l) => { exits.add(l); return () => { exits.delete(l); }; },
    };
    return { port, opened };
}

const n = (id: string, kind: string, config: Record<string, unknown> = {}, x = 0) => ({ id, kind, position: { x, y: 0 }, config });
const e = (source: string, target: string) => ({ id: `${source}-${target}`, source, target });
const onCanvas = (nodes: unknown[], edges: unknown[]) => graphToDocument(documentToGraph({ $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes, edges } }));

let dir: string;
let pty: ReturnType<typeof scriptedPty>;
let services: ComposedServices;
const roster = [{ id: 'agent_atlas', workspaceId: 'ws-example', provider: 'claude', name: 'atlas', instructions: null, threadId: null, createdAt: '2026-10-12T00:00:00.000Z', lastUsedAt: null }] as unknown as AgentRecord[];
/** A live agent: a prompt starts a turn that ends with its reply in the ledger. */
const ledger: Array<{ event: unknown }> = [];
const prompted: string[] = [];
const sessions: AgentSessionsPort = {
    session: (id) => (id === 'agent_atlas' ? { running: true, turnState: 'idle', pendingApproval: null } : null),
    rows: () => ledger,
    prompt: (_id, text) => { prompted.push(text); ledger.push({ event: { kind: 'message', speaker: 'agent', text: `done: ${text}` } }); return true; },
    subscribe: () => () => {},
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-canvas-e2e-'));
    pty = scriptedPty();
    ledger.length = 0;
    prompted.length = 0;
    services = await composeServices({ userData: dir, pty: pty.port, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => roster, workspaces: () => [{ id: 'ws-example', path: dir }], agentSessions: sessions });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

async function saveAndArm(name: string, document: unknown): Promise<string> {
    const saved = await handleFeatureAction(services, { kind: 'flows.saveGraph', workspaceId: 'ws-example', name, document });
    const result = saved.flows!.saved as { ok: boolean; flowId: string; problems?: unknown };
    expect(result).toMatchObject({ ok: true });
    await handleFeatureAction(services, { kind: 'flows.arm', flowId: result.flowId });
    expect(services.flows.get(result.flowId)!.armed).toBe(true);
    return result.flowId;
}

function overlayOutcomes(flow: FlowRecord, run: FlowRun): { statuses: unknown; listed: string[] } {
    const seen: Array<Record<string, unknown>> = [];
    const html = renderToStaticMarkup(<FlowRunOverlay flow={flow} run={run} Viewer={(p: Record<string, unknown>) => { seen.push(p); return null; }} />);
    return { statuses: seen[0]!.statuses, listed: [...html.matchAll(/data-flow-node="([^"]+)" data-flow-node-outcome="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`) };
}

describe('each trigger, end to end', () => {
    it('SCHEDULE: the timer fires, the command runs, and the overlay shows each node ran', async () => {
        const id = await saveAndArm('nightly', onCanvas([n('t', 'schedule_trigger', { cron: '0 3 * * *' }), n('s', 'genie/terminal_run', { workspace: 'ws-example', command: 'npm run report' }, 240)], [e('t', 's')]));
        // The scheduler's own timer, captured: what the clock calls at 03:00.
        const timers: Array<() => void> = [];
        const commands: string[] = [];
        const clock = new FlowScheduler({
            store: services.flows,
            now: () => Date.UTC(2026, 9, 26, 2, 59, 0),
            schedule: (fn) => { timers.push(fn); return () => {}; },
            run: createFlowRunner({ asleep: () => false, ports: () => ({ runCommand: async (_w, c) => { commands.push(c); return { exitCode: 0, output: '' }; }, promptAgent: async () => '', addKnowledge: async () => ({ id: 'k' }) }) }),
        });
        clock.plan();
        timers.at(-1)!();
        await clock.settled();
        expect(commands).toEqual(['npm run report']);
        const flow = services.flows.get(id)!;
        const run = flow.runs.at(-1)!;
        expect(run).toMatchObject({ trigger: 'schedule', outcome: 'ran', nodes: { t: 'ran', s: 'ran' } });
        expect(overlayOutcomes(flow, run)).toEqual({ statuses: { t: 'ok', s: 'ok' }, listed: ['t:ran', 's:ran'] });
    });

    it('FILE ADDED: a file lands, it is moved for real, and the overlay shows each node ran', async () => {
        const id = await saveAndArm('tidy uploads', onCanvas([n('t', 'genie/file_added', { workspace: 'ws-example', folder: 'uploads', extensions: 'png' }), n('m', 'genie/file_move', { workspace: 'ws-example', from: '{{in.path}}', to: '.untracked' }, 240)], [e('t', 'm')]));
        await mkdir(join(dir, 'uploads'), { recursive: true });
        const path = join(dir, 'uploads', 'a.png');
        await writeFile(path, 'png');
        services.flowScheduler.fileAdded({ workspaceId: 'ws-example', path, relPath: 'uploads/a.png', name: 'a.png', extension: 'png', sizeBytes: 3 });
        await services.flowScheduler.settled();
        expect(existsSync(join(dir, '.untracked', 'a.png'))).toBe(true);
        const flow = services.flows.get(id)!;
        const run = flow.runs.at(-1)!;
        expect(run).toMatchObject({ trigger: 'file', outcome: 'ran', nodes: { t: 'ran', m: 'ran' } });
        expect(overlayOutcomes(flow, run).listed).toEqual(['t:ran', 'm:ran']);
    });

    it('RUN NOW (manual): the agent is REACHED, its reply comes back into the run, and the next step uses it', async () => {
        const id = await saveAndArm('standup', onCanvas([
            n('t', 'manual_trigger'),
            n('a', 'genie/agent_prompt', { agent: 'atlas@ws-example', prompt: 'post the standup' }, 240),
            n('k', 'genie/knowledge_add', { workspace: 'ws-example', title: 'Standup', body: '{{in.reply}}' }, 480),
        ], [e('t', 'a'), e('a', 'k')]));
        expect(await services.flowScheduler.runNow(id)).toMatchObject({ trigger: 'manual', outcome: 'ran', nodes: { t: 'ran', a: 'ran', k: 'ran' } });
        expect(prompted).toEqual(['post the standup']);
        const written = services.knowledge.list({ scopes: 'all', limit: 10 }).nodes.find((k) => k.title === 'Standup');
        expect(written?.body).toBe('done: post the standup');
    });

    it('a step that fails is drawn failed, and what came after it not reached', async () => {
        const id = await saveAndArm('report', onCanvas([n('t', 'manual_trigger'), n('a', 'genie/agent_prompt', { agent: 'atlas@ws-example', prompt: 'x' }, 240), n('k', 'genie/knowledge_add', { workspace: 'ws-example', title: 'T' }, 480)], [e('t', 'a'), e('a', 'k')]));
        sessions.session = () => ({ running: false, turnState: 'idle', pendingApproval: null });
        try {
            const run = await services.flowScheduler.runNow(id);
            expect(run).toMatchObject({ outcome: 'failed', nodes: { t: 'ran', a: 'failed', k: 'not reached' } });
            expect(overlayOutcomes(services.flows.get(id)!, run).statuses).toEqual({ t: 'ok', a: 'failed', k: 'pending' });
        } finally {
            sessions.session = (sid) => (sid === 'agent_atlas' ? { running: true, turnState: 'idle', pendingApproval: null } : null);
        }
    });
});

describe('a run Genie quits in the middle of is never lost (acceptance (e))', () => {
    it('the run in flight is kept as it goes; the next launch records it STOPPED BY QUIT at the step it was on', async () => {
        const home = await mkdtemp(join(tmpdir(), 'genie2-canvas-quit-'));
        try {
            const store = await FlowStore.open(home);
            const made = await store.create({ workspaceId: 'ws-example', name: 'long job', by: { kind: 'user' }, document: onCanvas([n('t', 'manual_trigger'), n('s', 'genie/terminal_run', { workspace: 'ws-example', command: 'npm run long' }, 240), n('k', 'genie/knowledge_add', { workspace: 'ws-example', title: 'T' }, 480)], [e('t', 's'), e('s', 'k')]) });
            let reached!: () => void;
            const atCommand = new Promise<void>((r) => { reached = r; });
            const scheduler = new FlowScheduler({
                store, now: Date.now, schedule: () => () => {},
                // The command never finishes: Genie quits under it.
                run: createFlowRunner({ asleep: () => false, ports: () => ({ runCommand: () => { reached(); return new Promise(() => {}); }, promptAgent: async () => '', addKnowledge: async () => ({ id: 'k' }) }) }),
            });
            void scheduler.runNow(made.id);
            await atCommand;
            await new Promise((r) => setTimeout(r, 50));
            expect(store.get(made.id)!.inFlight).toMatchObject({ trigger: 'manual', nodes: { t: 'ran', s: 'running', k: 'not reached' } });

            // The next launch: the same file, opened again.
            const after = await FlowStore.open(home);
            const flow = after.get(made.id)!;
            expect(flow.inFlight).toBeUndefined();
            const run = flow.runs.at(-1)!;
            expect(run).toMatchObject({ trigger: 'manual', outcome: 'stopped', nodes: { t: 'ran', s: 'stopped', k: 'not reached' } });
            expect(run.reason).toMatch(/Genie quit while this run was going; it stopped at runs the command `npm run long`/);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });
});

// Typed so a NodeOutcome rename is caught here too.
const _outcomes: NodeOutcome[] = ['ran', 'failed', 'held', 'skipped', 'not reached', 'stopped', 'running'];
void _outcomes;
