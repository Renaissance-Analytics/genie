import { getNodeKind, registerNodeKind, type FlowGraph, type NodeKindDefinition } from '@particle-academy/fancy-flow/engine';
import { exportWorkflow, importWorkflow } from '@particle-academy/fancy-flow/schema';
import { parseCron, timeZoneProblem } from './cron.js';
import { canonicalFlowDocument, FLOW_SCHEMA_URL, type FlowDocument } from './flow-form.js';
import { flowReach, stepLabel } from './flow-reach.js';
import { SCHEDULE_PRESETS } from './flow-schedule.js';

/**
 * THE CANVAS'S VOCABULARY AND ITS RULES (genie#1204 item 1) — pure, and free of Node imports, so the flow editor window
 * (renderer), the store and the runner (main) all read ONE definition of what a flow may hold.
 *
 * Genie 1's editor (renderer/components/Flows/FlowEditorPanel.tsx at v0.7.0-beta.342) registered Genie's kinds in the
 * renderer before mounting `<FlowEditor>` (the registry is per process: a canvas that mounts first draws Genie's nodes as
 * bare boxes), turned the editor's built-in Run off (the main process is the only place a flow runs), and filtered the
 * palette with `kindFilter` asking the SAME function the executor's door asked (renderer/lib/flow-kinds.ts:75,
 * main/flows/refusals.ts `refusalFor`). Genie 1 still offered things that never ran (the webhook trigger: "recognised,
 * never armable"). Genie 2 turns that around: the palette is a list of kinds Genie's runner EXECUTES — each one has an
 * executor test (test/flow-canvas-kinds.test.ts) — and a kind outside the list is refused when a flow is SAVED, with the
 * reason on its node, never discovered at 03:00.
 */

/** Genie's own step kinds, registered with fancy-flow. What the executors (main/flow-executors.ts) need is what the schema REQUIRES. */
export const GENIE_NODE_KINDS: readonly NodeKindDefinition[] = [
    {
        name: 'genie/agent_prompt',
        category: 'ai',
        label: 'Prompt an agent',
        description: 'Send a prompt to a Genie agent and wait for its reply.',
        icon: '🧞',
        inputs: [{ id: 'in' }],
        outputs: [{ id: 'out', label: 'reply' }],
        configSchema: [
            { type: 'text', key: 'agent', label: 'Agent', placeholder: 'atlas@tynn-ai', required: true, description: 'An inbox address: name@workspace (a bare name when it is unique).' },
            { type: 'textarea', key: 'prompt', label: 'Prompt', required: true, description: 'Templates like {{in.text}} resolve into the node’s inputs.' },
        ],
    },
    {
        name: 'genie/terminal_run',
        category: 'io',
        label: 'Run a command',
        description: 'Run a command in a workspace and read its exit code and output.',
        icon: '⌨',
        inputs: [{ id: 'in' }],
        outputs: [{ id: 'out', label: 'result' }],
        configSchema: [
            { type: 'text', key: 'workspace', label: 'Workspace', required: true },
            { type: 'text', key: 'command', label: 'Command', required: true },
            { type: 'text', key: 'cwd', label: 'Working directory', description: 'Relative to the workspace; empty = the workspace root.' },
            { type: 'switch', key: 'allowFailure', label: 'Continue on a non-zero exit', default: false },
        ],
    },
    {
        name: 'genie/knowledge_add',
        category: 'data',
        label: 'Add knowledge',
        description: 'Write a node into Genie’s knowledge graph.',
        icon: '🧠',
        inputs: [{ id: 'in' }],
        outputs: [{ id: 'out', label: 'node' }],
        configSchema: [
            { type: 'text', key: 'workspace', label: 'Workspace', required: true },
            { type: 'text', key: 'title', label: 'Title', required: true },
            { type: 'textarea', key: 'body', label: 'Body' },
            { type: 'select', key: 'class', label: 'Class', options: [{ value: 'knowledge', label: 'knowledge' }, { value: 'episodic', label: 'episodic' }, { value: 'procedural', label: 'procedural' }, { value: 'profile', label: 'profile' }], default: 'knowledge' },
            { type: 'text', key: 'tags', label: 'Tags', description: 'Comma-separated.' },
        ],
    },
    // genie#1204 item 5 — Genie 1's "a file was added" trigger. Its output is the file (core/file-trigger.ts
    // FileAddedProps): {{in.path}}, {{in.relPath}}, {{in.name}}, {{in.extension}}, {{in.sizeBytes}}.
    {
        name: 'genie/file_added',
        category: 'trigger',
        label: 'A file is added',
        description: 'Starts the flow when a file lands in a workspace (not in .git, node_modules or vendor).',
        icon: '📄',
        inputs: [],
        outputs: [{ id: 'out', label: 'file' }],
        configSchema: [
            { type: 'text', key: 'workspace', label: 'Workspace', required: true },
            { type: 'text', key: 'folder', label: 'Folder', description: 'Relative to the workspace; empty = anywhere in it.' },
            { type: 'text', key: 'extensions', label: 'Extensions', description: 'Comma-separated, e.g. png, jpg; empty = any.' },
            { type: 'number', key: 'minSizeBytes', label: 'Minimum size (bytes)', min: 0, description: 'Inclusive; empty = any size.' },
        ],
    },
    {
        name: 'genie/file_move',
        category: 'io',
        label: 'Move a file',
        description: 'Move a file into a folder of the same workspace. No shell; never overwrites (name (2).ext).',
        icon: '📦',
        inputs: [{ id: 'in' }],
        outputs: [{ id: 'out', label: 'moved' }],
        configSchema: [
            { type: 'text', key: 'workspace', label: 'Workspace', required: true },
            { type: 'text', key: 'from', label: 'File', required: true, default: '{{in.path}}', description: 'Usually {{in.path}}: the file the trigger saw.' },
            { type: 'text', key: 'to', label: 'Into folder', required: true, placeholder: '.untracked', description: 'Relative to the workspace.' },
        ],
    },
];

/**
 * Put Genie's kinds in fancy-flow's registry. Idempotent: a kind already registered under its name is left alone, so every
 * caller (the store, the runner, the editor window before its canvas mounts) may call it.
 */
export function ensureGenieKinds(): void {
    for (const kind of GENIE_NODE_KINDS) {
        if (getNodeKind(kind.name)?.name !== kind.name) registerNodeKind(kind);
    }
}

/**
 * EVERY KIND GENIE'S RUNNER EXECUTES — the palette, and the save-time door. Canonical ids. Each has an executor:
 * fancy-flow's own for the pure-logic kinds (branch, switch, merge, transform, variable, log, output; manual trigger),
 * Genie's for the rest (main/flow-executors.ts; the schedule and file triggers in main/flow-runner.ts). A `note` is an
 * annotation the engine walks past.
 *
 * NOT offered, each because Genie cannot run it (Genie 1 refused the same set, main/flows/refusals.ts at
 * v0.7.0-beta.342): webhook_trigger (nowhere for a request to land), human_approval / user_input / rich_user_input (they
 * park a run Genie cannot resume), api_request / webhook_out (any URL), llm_call / llm_router / tool_use / embed_search
 * (Genie does not call models from a flow — prompt an agent instead), notify (somebody else's channels), memory_store /
 * data_store (no store decided), subflow / for_each (nested runs), fancy's terminal_* (no terminal host for flows — Run a
 * command runs in the workspace), lane (layout only).
 */
export const SUPPORTED_KINDS: readonly string[] = [
    '@particle-academy/manual_trigger',
    '@particle-academy/schedule_trigger',
    'genie/file_added',
    'genie/agent_prompt',
    'genie/terminal_run',
    'genie/knowledge_add',
    'genie/file_move',
    '@particle-academy/branch',
    '@particle-academy/switch_case',
    '@particle-academy/merge',
    '@particle-academy/transform',
    '@particle-academy/variable',
    '@particle-academy/wait',
    '@particle-academy/log',
    '@particle-academy/output',
    '@particle-academy/note',
];
const SUPPORTED = new Set(SUPPORTED_KINDS);

/**
 * GENIE'S TOOLS AS STEPS (genie#1204): `@genie/<tool>` kinds, derived in main from the tools' own schemas
 * (main/flow-tools.ts) and handed to the editor window in the flows snapshot. Each runs through Genie's runner as the flow,
 * so it is as supported as the static kinds — once registered here.
 */
const TOOL_KINDS = new Set<string>();

/** Register Genie's tool kinds (idempotent) and mark them supported: the palette offers them, the door accepts them. */
export function registerToolKinds(defs: readonly NodeKindDefinition[]): void {
    for (const def of defs) {
        if (getNodeKind(def.name)?.name !== def.name) registerNodeKind(def.name === QUESTION_KIND ? { ...def, outputs: questionPorts } : def);
        TOOL_KINDS.add(def.name);
    }
}

/** A flow's question (genie#1204). Its ports are a FUNCTION of its settings, so they are set here, on both sides of IPC. */
export const QUESTION_KIND = '@genie/ForceTheQuestion';
export const QUESTION_NONE_CHOSEN = 'none chosen';
export const QUESTION_DISMISSED = 'dismissed';

/** The first question's options, one port each (Genie 1's design, kinds.ts PAUSES); then "none chosen" and "dismissed". */
export function questionPorts(config: unknown): { id: string }[] {
    const questions = (config as { questions?: unknown } | null)?.questions;
    const first = Array.isArray(questions) ? (questions[0] as { options?: unknown } | undefined) : undefined;
    const labels = Array.isArray(first?.options) ? (first!.options as Array<{ label?: unknown }>).map((o) => (typeof o?.label === 'string' ? o.label : '')).filter((l) => l !== '') : [];
    return [...new Set([...labels, QUESTION_NONE_CHOSEN, QUESTION_DISMISSED])].map((id) => ({ id }));
}

/** The registered tool kinds, `@genie/<tool>`. */
export function toolKinds(): readonly string[] {
    return [...TOOL_KINDS];
}

/** A kind's canonical id (an alias like `schedule_trigger` resolves); a kind nobody registered stays as written. */
export function canonicalKind(kind: string): string {
    ensureGenieKinds();
    return getNodeKind(kind)?.name ?? kind;
}

export function isSupportedKind(kind: string): boolean {
    const k = canonicalKind(kind);
    return SUPPORTED.has(k) || TOOL_KINDS.has(k);
}

/** `<FlowEditor kindFilter>`: the palette offers exactly what the runner executes. Module scope so its identity is stable. */
export function paletteKindFilter({ kind }: { kind: { name: string } }): boolean {
    return SUPPORTED.has(kind.name) || TOOL_KINDS.has(kind.name);
}

const TRIGGERS = new Set(['@particle-academy/manual_trigger', '@particle-academy/schedule_trigger', 'genie/file_added']);
export function isTriggerKind(kind: string): boolean {
    return TRIGGERS.has(canonicalKind(kind));
}

/** A problem with a flow, on its node when it has one — what the canvas draws on that node. */
export interface FlowProblem {
    readonly nodeId?: string;
    readonly message: string;
}

/** "node s: x" (the engine's and the store's wording) → `{ nodeId: 's', message: 'x' }`. */
export function problemFromText(text: string): FlowProblem {
    const m = /^node ([^:]+): (.*)$/s.exec(text);
    return m ? { nodeId: m[1]!, message: m[2]! } : { message: text };
}

type DocNode = { id?: unknown; kind?: unknown; config?: Record<string, unknown> };
type DocEdge = { source?: unknown; target?: unknown };

function graphOf(document: unknown): { nodes: DocNode[]; edges: DocEdge[] } {
    const doc = canonicalFlowDocument(document) as { graph?: { nodes?: unknown; edges?: unknown } } | null;
    const g = doc !== null && typeof doc === 'object' ? doc.graph : undefined;
    return { nodes: Array.isArray(g?.nodes) ? (g!.nodes as DocNode[]) : [], edges: Array.isArray(g?.edges) ? (g!.edges as DocEdge[]) : [] };
}

/** `5s`, `10m`, `1h`, `250ms` → milliseconds; anything else null. At most a day: a longer wait is a schedule. */
export const WAIT_MAX_MS = 24 * 60 * 60 * 1000;
export function waitMs(text: unknown): number | null {
    if (typeof text !== 'string') return null;
    const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)\s*$/.exec(text);
    if (!m) return null;
    const ms = Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 'ms' | 's' | 'm' | 'h'];
    return Number.isFinite(ms) && ms >= 0 && ms <= WAIT_MAX_MS ? Math.round(ms) : null;
}

/**
 * What the ENGINE cannot see and Genie refuses at save (the store's door and the runner's, main/flow-kinds.ts): a kind
 * Genie's runner does not execute, a Wait it cannot honour, and a cycle (the engine aborts a cyclic run — after running
 * every node above the loop). A kind nobody registered is left to the engine, which names it in its own words.
 */
export function structuralProblems(document: unknown): FlowProblem[] {
    const { nodes, edges } = graphOf(document);
    const problems: FlowProblem[] = [];
    for (const n of nodes) {
        const id = String(n.id ?? '');
        const kind = typeof n.kind === 'string' ? n.kind : '';
        if (!kind || getNodeKindQuiet(kind) === null) continue;
        if (!isSupportedKind(kind)) {
            problems.push({ nodeId: id, message: `${getNodeKindQuiet(kind)!.label} is not a step Genie can run, so it cannot be saved in a flow. Remove it; the palette lists what Genie runs` });
            continue;
        }
        if (canonicalKind(kind) === '@particle-academy/wait') {
            const config = n.config ?? {};
            if ((config.mode ?? 'duration') !== 'duration') problems.push({ nodeId: id, message: 'Genie waits for a duration only (5s, 10m, 1h); "until" and "external event" are not supported' });
            else if (waitMs(config.duration) === null) problems.push({ nodeId: id, message: `the duration "${String(config.duration ?? '')}" is not one Genie can wait: a number and ms, s, m or h, up to 24h` });
        }
    }
    const cycle = findCycle(nodes, edges);
    if (cycle.length > 0) problems.push({ nodeId: cycle[0]!, message: `the steps ${cycle.join(' → ')} form a loop; a flow runs once through, so a loop never ends. Remove one connection` });
    return problems;
}

function getNodeKindQuiet(kind: string): NodeKindDefinition | null {
    ensureGenieKinds();
    return getNodeKind(kind);
}

/** The first cycle in the edges, as node ids ending where it started; [] when there is none. */
export function findCycle(nodes: readonly DocNode[], edges: readonly DocEdge[]): string[] {
    const out = new Map<string, string[]>();
    for (const n of nodes) out.set(String(n.id), []);
    for (const e of edges) if (typeof e.source === 'string' && typeof e.target === 'string' && out.has(e.source)) out.get(e.source)!.push(e.target);
    const state = new Map<string, 'open' | 'done'>();
    const stack: string[] = [];
    const visit = (id: string): string[] | null => {
        state.set(id, 'open');
        stack.push(id);
        for (const next of out.get(id) ?? []) {
            if (state.get(next) === 'open') return [...stack.slice(stack.indexOf(next)), next];
            if (!state.has(next) && out.has(next)) {
                const found = visit(next);
                if (found) return found;
            }
        }
        stack.pop();
        state.set(id, 'done');
        return null;
    };
    for (const id of out.keys()) {
        if (state.has(id)) continue;
        const found = visit(id);
        if (found) return found;
    }
    return [];
}

/** What a SAVE also needs, beyond the document: the workspaces and agents as they are NOW. */
export interface SaveContext {
    /** Registered workspace ids. */
    readonly workspaces: readonly string[];
    /** null = the address reaches one agent; else why not, in words. */
    readonly agentProblem: (address: string) => string | null;
}

const WORKSPACE_KINDS = new Set(['genie/terminal_run', 'genie/knowledge_add', 'genie/file_added', 'genie/file_move']);

/**
 * Everything a person's save refuses (the canvas, genie#1204 (d)): the structural problems, plus a flow with nothing to
 * start it or nothing to do, a schedule Genie cannot evaluate, a workspace that is not registered, an agent nobody answers
 * to. Each on its node. The engine's own issues come from the store's door (main/flow-kinds.ts) on the same save.
 */
export function saveProblems(document: unknown, ctx: SaveContext): FlowProblem[] {
    const { nodes } = graphOf(document);
    const problems = structuralProblems(document);
    const steps = nodes.filter((n) => typeof n.kind === 'string' && !isTriggerKind(n.kind) && canonicalKind(n.kind) !== '@particle-academy/note');
    if (!nodes.some((n) => typeof n.kind === 'string' && isTriggerKind(n.kind))) problems.push({ message: 'a flow needs something to start it: add a Manual, Schedule or "A file is added" trigger' });
    if (steps.length === 0) problems.push({ message: 'a flow needs at least one step after its trigger' });
    for (const n of nodes) {
        const id = String(n.id ?? '');
        const kind = typeof n.kind === 'string' ? canonicalKind(n.kind) : '';
        const config = n.config ?? {};
        if (kind === '@particle-academy/schedule_trigger') {
            const cron = typeof config.cron === 'string' ? config.cron.trim() : '';
            if (cron !== '' && parseCron(cron) === null) problems.push({ nodeId: id, message: `"${cron}" is not a schedule Genie can evaluate (five fields: minute hour day month weekday)` });
            const zone = timeZoneProblem(typeof config.timezone === 'string' && config.timezone.trim() !== '' ? config.timezone : undefined);
            if (zone !== null) problems.push({ nodeId: id, message: zone });
        }
        if (WORKSPACE_KINDS.has(kind) && typeof config.workspace === 'string' && config.workspace.trim() !== '' && !ctx.workspaces.includes(config.workspace.trim())) {
            problems.push({ nodeId: id, message: `there is no workspace "${config.workspace}" in Genie` });
        }
        if (kind === 'genie/agent_prompt' && typeof config.agent === 'string' && config.agent.trim() !== '' && !config.agent.includes('{{')) {
            const why = ctx.agentProblem(config.agent.trim());
            if (why !== null) problems.push({ nodeId: id, message: why });
        }
    }
    return problems;
}

/** A stored document as the canvas holds it: the engine's own hydration (lenient, so an unknown kind still draws and says why). */
export function documentToGraph(document: unknown): FlowGraph {
    ensureGenieKinds();
    const result = importWorkflow(canonicalFlowDocument(document), { lenient: true });
    return result.graph;
}

/** The canvas's graph as the document Genie stores — without the problems and statuses the canvas drew on its nodes. */
export function graphToDocument(graph: FlowGraph): FlowDocument {
    ensureGenieKinds();
    const clean: FlowGraph = { ...graph, nodes: graph.nodes.map((n) => ({ ...n, data: stripDrawn(n.data) })) as FlowGraph['nodes'] };
    const doc = exportWorkflow(clean);
    return { ...doc, $schema: FLOW_SCHEMA_URL };
}

function stripDrawn(data: unknown): never {
    const { status: _s, statusText: _t, ...rest } = (data ?? {}) as Record<string, unknown>;
    return rest as never;
}

/** The problems drawn ON their nodes: fancy-flow's own error ring and the reason under the node's title. */
export function withProblems(graph: FlowGraph, problems: readonly FlowProblem[]): FlowGraph {
    const byNode = new Map<string, string[]>();
    for (const p of problems) if (p.nodeId !== undefined) byNode.set(p.nodeId, [...(byNode.get(p.nodeId) ?? []), p.message]);
    return {
        ...graph,
        nodes: graph.nodes.map((n) => {
            const reasons = byNode.get(n.id);
            const data = stripDrawn(n.data) as Record<string, unknown>;
            return (reasons ? { ...n, data: { ...data, status: 'error', statusText: reasons.join('; ') } } : { ...n, data }) as FlowGraph['nodes'][number];
        }),
    };
}

/** One node's outcome in a recorded run (main/flow-store.ts FlowRun.nodes). */
export type NodeOutcome = 'ran' | 'failed' | 'held' | 'skipped' | 'not reached' | 'stopped' | 'running';

/** A run's node outcomes as fancy-flow's viewer statuses: what the run overlay draws on the canvas (genie#1204 item 6). */
export function viewerStatuses(nodes: Readonly<Record<string, NodeOutcome>>): Record<string, 'ok' | 'running' | 'failed' | 'skipped' | 'pending'> {
    const map = { ran: 'ok', failed: 'failed', held: 'running', skipped: 'skipped', 'not reached': 'pending', stopped: 'failed', running: 'running' } as const;
    return Object.fromEntries(Object.entries(nodes).map(([id, o]) => [id, map[o]]));
}

/**
 * A flow in a line (genie#1204: the Flows page lists WORKFLOWS): what starts it, then each step in graph order — Genie's
 * own steps in words ("runs the command `npm run report`", "prompts atlas@tynn"), any other by its kind's name ("Branch").
 */
export function flowSummary(document: unknown, nowMs: number): { trigger: string; steps: string[] } {
    const { nodes } = graphOf(document);
    const reach = flowReach(canonicalFlowDocument(document), nowMs);
    const triggers = nodes.filter((n) => typeof n.kind === 'string' && isTriggerKind(n.kind));
    const words = triggers.map((t) => {
        const kind = canonicalKind(String(t.kind));
        if (kind === 'genie/file_added') return `When ${reach.file ?? 'a file is added'}`;
        if (kind === '@particle-academy/schedule_trigger') {
            const cron = typeof t.config?.cron === 'string' ? t.config.cron.trim() : '';
            const preset = SCHEDULE_PRESETS.find((p) => p.cron === cron);
            return preset ? preset.label : cron ? `On a schedule (${cron})` : 'On a schedule (none set)';
        }
        return 'When you run it';
    });
    const steps = nodes
        .filter((n) => typeof n.kind === 'string' && !isTriggerKind(n.kind) && canonicalKind(n.kind) !== '@particle-academy/note')
        .map((n) => {
            const kind = canonicalKind(String(n.kind));
            return kind.startsWith('genie/') ? stepLabel({ kind, config: n.config }) : getNodeKindQuiet(kind)?.label ?? kind;
        });
    return { trigger: words.length > 0 ? words.join(' · ') : 'No trigger', steps };
}

/** A new flow's starting canvas: a Manual trigger, so a person can try it before giving it a schedule. */
export function starterDocument(): FlowDocument {
    return { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [{ id: 'trigger', kind: '@particle-academy/manual_trigger', position: { x: 0, y: 0 } }], edges: [] } } as unknown as FlowDocument;
}

/**
 * STEPS SAFE TO RUN AGAIN (genie#1204): what a run Genie quit under may resume FROM. Running one of these twice does
 * nothing a person would not want done twice:
 * - the pure logic and data steps, Log and Output, Wait, the annotation — they act on nothing outside the run;
 * - the triggers — a resumed run replays what fired it;
 * - the Genie tools Genie 1 itself classed as read-only or idempotent (main/flows/kinds.ts:178-200 at v0.7.0-beta.342,
 *   `READ_ONLY_TOOLS` / `IDEMPOTENT_TOOLS`): checkIssues, knowledge;
 * - ForceTheQuestion: asking again rejoins the SAME pending question (main/attention-store.ts `ask`: "a repeat of the same
 *   question is rejoined, not duplicated"), so the person is not asked twice.
 * NOT safe: a command, a prompt to an agent, a file move, Add knowledge (`genie/knowledge_add` writes a new memory each
 * time), and every Genie tool that writes or acts (processes, sites, services, terminals, agentinbox, imDone,
 * openFileForUser) — any of them may already have done its work, and doing it twice is not Genie's call.
 */
export const RESUMABLE_KINDS: readonly string[] = [
    '@particle-academy/manual_trigger', '@particle-academy/schedule_trigger', 'genie/file_added',
    '@particle-academy/branch', '@particle-academy/switch_case', '@particle-academy/merge', '@particle-academy/transform', '@particle-academy/variable',
    '@particle-academy/wait', '@particle-academy/log', '@particle-academy/output', '@particle-academy/note',
    '@genie/checkIssues', '@genie/knowledge', '@genie/ForceTheQuestion',
];
const RESUMABLE = new Set(RESUMABLE_KINDS);

export function safeToRerun(kind: string): boolean {
    ensureGenieKinds();
    return RESUMABLE.has(getNodeKind(kind)?.name ?? kind);
}
