import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalKind, documentToGraph, graphToDocument, type FlowProblem } from '../../src/core/flow-canvas.js';
import { FLOW_SCHEMA_URL, flowNodes } from '../../src/core/flow-form.js';
import type { IssueWatchSummary } from '../../src/core/issue-watch.js';
import type { AgentRecord } from '../../src/core/identity.js';
import { composeServices, type ComposedServices } from '../../src/main/compose.js';
import { handleFeatureAction } from '../../src/main/feature-ipc.js';
import type { AgentSessionsPort } from '../../src/main/flow-runner.js';
import type { FlowRun } from '../../src/main/flow-store.js';
import { FlowCallers, createFlowToolCaller } from '../../src/main/flow-tools.js';
import { genieToolDeps } from '../../src/main/genie-tool-deps.js';
import { allGenieTools } from '../../src/main/mcp-registrations.js';
import { ProcessBook } from '../../src/main/process-book.js';
import type { DockerRunner } from '../../src/main/service-driver.js';
import type { PtyPort } from '../../src/main/terminal-host.js';

/**
 * THE FLOWS ACCEPTANCE HARNESS (the owner, 2026-10-27: "make sure you are testing the triggers and each node in the tests").
 *
 * One Genie, composed the way main composes it: `composeServices` — the real FlowStore, FlowScheduler, flow runner,
 * supervisor, file source and file watches, knowledge, inbox, attention and approvals — with Genie's own tools registered
 * exactly as main.ts registers them (`allGenieTools(genieToolDeps(...))`) and handed to the flows through
 * `setFlowToolCaller(createFlowToolCaller(...))`. A flow is SAVED the way the canvas saves it (`flows.saveGraph`, the
 * person's save, with the canvas's own document conversion), ARMED and RUN the way the person does (`flows.arm`,
 * `flows.runNow`), and its EFFECT is read from the real stores.
 *
 * What stands in for the machine, and only that:
 * - the pty engine is `childPty`: each supervised command runs as a REAL child process through the platform's shell, so
 *   a command's output and exit code are real (the production engine is fancy-term-host's pty, out of process);
 * - an agent's live session is `FakeSessions`: a prompt is delivered there and answered with a turn (an agent is a model);
 * - the terminals, the file panel and IssueWatch are the recording ports main fills with windows and network.
 */

export const WS = 'acme';
export const AGENT = 'claude:atlas';
const isWindows = process.platform === 'win32';

/** A real child process per pty, through the platform's shell: real output, real exit codes, a real kill. */
export function childPty(): PtyPort & { readonly opened: Array<{ command: string | undefined; cwd: string }> } {
    const data = new Set<(id: string, d: string) => void>();
    const exits = new Set<(id: string, code: number) => void>();
    const kids = new Map<string, ChildProcess>();
    const opened: Array<{ command: string | undefined; cwd: string }> = [];
    let n = 0;
    return {
        opened,
        open(o) {
            const id = `cp_${++n}`;
            opened.push({ command: o.command, cwd: o.cwd });
            const child = spawn(o.command ?? (isWindows ? 'cmd.exe' : 'sh'), {
                shell: o.command !== undefined,
                cwd: o.cwd,
                env: { ...process.env, ...(o.env ?? {}) },
                detached: !isWindows,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            kids.set(id, child);
            const out = (chunk: Buffer) => { for (const l of data) l(id, chunk.toString('utf8')); };
            child.stdout?.on('data', out);
            child.stderr?.on('data', out);
            child.on('error', (error) => { for (const l of data) l(id, `spawn failed: ${error.message}\n`); });
            // `close`, not `exit`: every byte of output has arrived by then.
            child.on('close', (code) => {
                kids.delete(id);
                for (const l of exits) l(id, code ?? 1);
            });
            return { id, pid: child.pid ?? 0, shell: isWindows ? 'cmd.exe' : 'sh', scrollback: '' };
        },
        write: () => true,
        resize: () => true,
        kill(id) {
            const child = kids.get(id);
            if (!child || child.pid === undefined) return false;
            if (isWindows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
            else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
            return true;
        },
        scrollback: () => '',
        onData: (l) => { data.add(l); return () => { data.delete(l); }; },
        onExit: (l) => { exits.add(l); return () => { exits.delete(l); }; },
        isLive: (id) => kids.has(id),
    };
}

/** A command that runs the same on sh and cmd.exe: node, with a script in double quotes and no double quotes inside. */
export function nodeCommand(script: string): string {
    if (script.includes('"')) throw new Error('nodeCommand: use single quotes inside the script');
    return `node -e "${script}"`;
}

/**
 * The live agent sessions a `genie/agent_prompt` reaches (main wires the session host). `reply` answers each prompt with a
 * turn that ends; `never-ends` leaves the turn working (a quit mid-turn); `busy` is mid-turn before the prompt.
 */
export class FakeSessions implements AgentSessionsPort {
    mode: 'reply' | 'never-ends' | 'busy' = 'reply';
    readonly prompts: Array<{ agentId: string; text: string; by: string }> = [];
    readonly #turn = new Map<string, string>();
    readonly #rows = new Map<string, Array<{ event: unknown }>>();
    readonly #listeners = new Set<(agentId: string) => void>();
    constructor(private readonly agents: readonly string[]) {}

    session(id: string) {
        if (!this.agents.includes(id)) return null;
        return { running: true, turnState: this.mode === 'busy' ? 'working' : (this.#turn.get(id) ?? 'idle'), pendingApproval: null };
    }
    rows(id: string) { return this.#rows.get(id) ?? []; }
    prompt(id: string, text: string, by: string): boolean {
        this.prompts.push({ agentId: id, text, by });
        this.#turn.set(id, 'working');
        this.#push(id, { kind: 'message', speaker: 'user', text });
        if (this.mode === 'reply') {
            setTimeout(() => {
                this.#push(id, { kind: 'message', speaker: 'agent', text: `atlas did: ${text}` });
                this.#turn.set(id, 'idle');
                for (const l of this.#listeners) l(id);
            }, 20);
        }
        return true;
    }
    subscribe(listener: (agentId: string) => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
    #push(id: string, event: unknown) { this.#rows.set(id, [...this.rows(id), { event }]); }
}

/** A clock that runs in real time from an instant the test sets: the scheduler's timer is real, its "now" is chosen. */
export class TestClock {
    #base = Date.now();
    #realStart = Date.now();
    readonly now = (): number => this.#base + (Date.now() - this.#realStart);
    set(ms: number): void { this.#base = ms; this.#realStart = Date.now(); }
}

export interface GenieOptions {
    readonly userData?: string;
    readonly clock?: TestClock;
    readonly v1Database?: string;
    readonly sessions?: FakeSessions;
}

export interface Genie {
    readonly services: ComposedServices;
    readonly dir: string;
    readonly ws: string;
    readonly userData: string;
    readonly sessions: FakeSessions;
    readonly pty: ReturnType<typeof childPty>;
    readonly book: ProcessBook;
    readonly runs: Array<{ flowId: string; run: FlowRun }>;
    readonly terminals: Array<{ workspaceId: string; command: string | undefined }>;
    readonly opened: Array<{ workspaceId: string; path: string }>;
    issues: IssueWatchSummary;
    shutdown(): Promise<void>;
}

const roster = [{ id: 'agent_atlas', workspaceId: WS, provider: 'claude', name: 'atlas', instructions: null, threadId: null, createdAt: '2026-10-12T00:00:00.000Z', lastUsedAt: null }] as unknown as AgentRecord[];
const docker: DockerRunner = async () => ({ stdout: '', exitCode: 1 });

/** Start one Genie on a fresh folder (or `userData`, to relaunch on the same one), composed as main composes it. */
export async function startGenie(options: GenieOptions = {}, dir?: string): Promise<Genie> {
    const root = dir ?? (await mkdtemp(join(tmpdir(), 'genie-flows-accept-')));
    const ws = join(root, WS);
    await mkdir(ws, { recursive: true });
    const userData = options.userData ?? join(root, 'genie');
    await mkdir(userData, { recursive: true });
    const sessions = options.sessions ?? new FakeSessions(['agent_atlas']);
    const pty = childPty();
    const services = await composeServices({
        userData,
        pty,
        v1Settings: () => null,
        caddyBin: null,
        frontDoorPort: 0,
        docker,
        portFree: async () => true,
        roster: () => roster,
        workspaces: () => [{ id: WS, path: ws }],
        agentSessions: sessions,
        ...(options.clock ? { now: options.clock.now } : {}),
        ...(options.v1Database ? { v1Flows: { database: options.v1Database } } : {}),
    });
    const book = await ProcessBook.open(userData, { supervisor: services.supervisor, envFor: () => ({}), asleep: () => false });
    const terminals: Genie['terminals'] = [];
    const opened: Genie['opened'] = [];
    const runs: Genie['runs'] = [];
    services.flows.onRun((flowId, run) => { runs.push({ flowId, run }); });
    const never = (() => { throw new Error('not reachable from a flow'); }) as never;
    const genie: Genie = {
        services, dir: root, ws, userData, sessions, pty, book, runs, terminals, opened,
        issues: { state: 'live', linked: true, entry: { projectId: 'p', items: [], feedback: [] } },
        shutdown: async () => { await services.shutdown(); },
    };
    // Genie's tools, registered as main.ts registers them, and handed to the flows the same way (genie#1204).
    const callers = new FlowCallers((id) => (id === WS ? ws : null));
    const registrations = allGenieTools(genieToolDeps({
        inbox: services.inbox, attention: services.attention, knowledge: services.knowledge, settings: services.settings,
        approve: (caller, action, detail) => services.approvals.gate(caller, action, detail),
        roster: () => roster, resolveCaller: (id) => callers.callerFor(id),
        userActive: () => true, glow: () => false, thumbsUp: () => {},
        openFile: async (t) => { opened.push({ workspaceId: t.workspaceId, path: t.path }); return { ok: true }; },
        terminals: { list: () => [], open: (o) => { terminals.push({ workspaceId: o.workspaceId, command: o.command }); return { id: `term_${terminals.length}`, pid: 2, shell: 'sh', scrollback: '' }; }, write: () => true, scrollback: () => '', scrollbackCap: 1000 },
        hosting: services,
        processes: { book, logs: (id: string, lines?: number) => services.supervisor.readLog(id, lines) },
        flows: { store: services.flows, runNow: (id: string) => services.flowScheduler.runNow(id) },
        issueWatch: { forWorkspace: () => genie.issues },
        plugins: { tools: () => [], guard: () => null, run: never },
    }));
    services.setFlowToolCaller(createFlowToolCaller({ registrations, callers }));
    return genie;
}

let current: Genie | null = null;

/** One Genie per test, shut down and removed after it. */
export function useGenie(options: () => GenieOptions = () => ({})): () => Genie {
    beforeEach(async () => { current = await startGenie(options()); });
    afterEach(async () => {
        const g = current;
        current = null;
        if (!g) return;
        await g.shutdown();
        await rm(g.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
    return () => {
        if (!current) throw new Error('no Genie: useGenie() runs per test');
        return current;
    };
}

// ── Building a flow the way the canvas does ────────────────────────────────────────────────────────────────────────

export type DocNode = { id: string; kind: string; position: { x: number; y: number }; config: Record<string, unknown> };
export type DocEdge = { id: string; source: string; target: string; sourceHandle?: string; targetHandle?: string };
export const node = (id: string, kind: string, config: Record<string, unknown> = {}, x = 0, y = 0): DocNode => ({ id, kind, position: { x, y }, config });
export const edge = (source: string, target: string, sourceHandle?: string, targetHandle?: string): DocEdge => ({
    id: `${source}-${target}${sourceHandle ? `-${sourceHandle}` : ''}${targetHandle ? `-${targetHandle}` : ''}`,
    source,
    target,
    ...(sourceHandle ? { sourceHandle } : {}),
    ...(targetHandle ? { targetHandle } : {}),
});

/** The document the canvas sends: its graph through the engine's hydration and back (core/flow-canvas.ts). */
export function canvasDocument(nodes: readonly DocNode[], edges: readonly DocEdge[]): unknown {
    return graphToDocument(documentToGraph({ $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes, edges } }));
}

export type Saved = { ok: true; flowId: string; disarmed: boolean } | { ok: false; problems: FlowProblem[] };

/** The canvas's Save, as the person (`flows.saveGraph`). */
export async function trySave(g: Genie, name: string, nodes: readonly DocNode[], edges: readonly DocEdge[], flowId?: string): Promise<Saved> {
    const data = await handleFeatureAction(g.services, { kind: 'flows.saveGraph', workspaceId: WS, name, document: canvasDocument(nodes, edges), ...(flowId ? { flowId } : {}) });
    return data.flows!.saved as unknown as Saved;
}

export async function save(g: Genie, name: string, nodes: readonly DocNode[], edges: readonly DocEdge[]): Promise<string> {
    const saved = await trySave(g, name, nodes, edges);
    if (!saved.ok) throw new Error(`the canvas refused "${name}": ${JSON.stringify(saved.problems)}`);
    return saved.flowId;
}

export async function arm(g: Genie, flowId: string): Promise<void> {
    await handleFeatureAction(g.services, { kind: 'flows.arm', flowId });
    expect(g.services.flows.get(flowId)!.armed).toBe(true);
}

export async function disarm(g: Genie, flowId: string): Promise<void> {
    await handleFeatureAction(g.services, { kind: 'flows.disarm', flowId });
}

/** The next run recorded for a flow. */
export function nextRun(g: Genie, flowId: string, timeoutMs = 20_000): Promise<FlowRun> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error(`no run of ${flowId} was recorded within ${timeoutMs} ms`)); }, timeoutMs);
        const off = g.services.flows.onRun((id, run) => { if (id === flowId) { clearTimeout(timer); off(); resolve(run); } });
    });
}

/** The person's Run now (`flows.runNow`, started and not awaited, as the Flows tab does), and the run it recorded. */
export async function runNow(g: Genie, flowId: string): Promise<FlowRun> {
    const recorded = nextRun(g, flowId);
    await handleFeatureAction(g.services, { kind: 'flows.runNow', flowId });
    return recorded;
}

/** Waits until `n` runs of a flow are recorded. */
export async function runsOf(g: Genie, flowId: string, n: number, timeoutMs = 15_000): Promise<readonly FlowRun[]> {
    await vi.waitFor(() => expect(g.services.flows.get(flowId)!.runs.length).toBeGreaterThanOrEqual(n), { timeout: timeoutMs, interval: 25 });
    return g.services.flows.get(flowId)!.runs;
}

/** The approval a held run is waiting on. */
export async function approval(g: Genie): Promise<{ id: string; title: string }> {
    await vi.waitFor(() => expect(g.services.approvals.deckItems().length).toBeGreaterThan(0), { timeout: 10_000, interval: 10 });
    const [item] = g.services.approvals.deckItems();
    return { id: item!.id, title: item!.title };
}

/** The question a held run is waiting on. */
export async function question(g: Genie): Promise<string> {
    await vi.waitFor(() => expect(g.services.attention.pending().length).toBeGreaterThan(0), { timeout: 10_000, interval: 10 });
    return g.services.attention.pending()[0]!.id;
}

// ── One acceptance case per node kind the palette offers ───────────────────────────────────────────────────────────

/**
 * An acceptance case FOR A NODE KIND. The palette guard (palette-guard.accept.ts) reads these declarations from the
 * suite's sources: a kind the palette offers with no `kindCase` turns the suite red. And a declaration must be earned —
 * after the body, a run recorded DURING THIS TEST must hold a node of that kind that RAN (an annotation, which never runs,
 * must be in a flow whose run ran). A case that never puts its kind through Genie's runner fails here.
 */
export function kindCase(kind: string, title: string, genie: () => Genie, body: () => Promise<void>, timeout?: number): void {
    it(`[${kind}] ${title}`, async () => {
        const g = genie();
        const mark = g.runs.length;
        await body();
        const canonical = canonicalKind(kind);
        const proof = g.runs.slice(mark).some(({ flowId, run }) => {
            const flow = g.services.flows.get(flowId);
            if (!flow) return false;
            const ofKind = flowNodes(flow.document).filter((n) => canonicalKind(String(n.kind)) === canonical);
            if (ofKind.length === 0) return false;
            if (canonical === '@particle-academy/note') return run.outcome === 'ran';
            return ofKind.some((n) => run.nodes?.[String(n.id)] === 'ran');
        });
        expect(proof, `no run in this test put a ${kind} node through Genie's runner and saw it run`).toBe(true);
    }, timeout);
}
