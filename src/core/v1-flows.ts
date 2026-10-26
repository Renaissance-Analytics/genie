import { getNodeKind } from '@particle-academy/fancy-flow/engine';
import { canonicalKind, ensureGenieKinds, toolKinds } from './flow-canvas.js';
import { FLOW_SCHEMA_URL } from './flow-form.js';

/**
 * GENIE 1's FLOWS → GENIE 2's FLOWS — the pure plan (genie#1204). No I/O; main/v1-flows.ts reads the rows.
 *
 * Genie 1 kept every workflow in its `flows` table (one table since migration v74; main/flows/store.ts and main/db.ts at
 * v0.7.0-beta.342): an xyflow graph (`graph_json`, nodes `{ id, type, position, data: { kind, label, config } }`), a scope
 * (`scope_json`: `system`, `workspace` with its id, or `gapp`), born disarmed. Earlier Genie 2 betas imported none of them.
 *
 * Each workspace flow becomes a canvas flow in that workspace, its graph converted step by step to what Genie 2 runs:
 * - fancy-flow's own kinds stay (config narrowed to the kind's fields; the schedule trigger's extra `schedule` copy goes);
 * - fancy's `terminal_run` (a terminal Genie 1 never wired for flows) → `genie/terminal_run` in the flow's workspace, its
 *   `failOnNonZero: false` → `allowFailure`;
 * - `@genie/agentinbox` `send` (a message to an agent) → `genie/agent_prompt` to that agent with that text;
 * - `@genie/event_trigger` on `files:added` (main/flows/event-trigger.ts) → `genie/file_added` in the workspace;
 * - a lane (`terminal_lane`, `lane`) is layout only and is left out;
 * - a template naming an upstream node (`{{ run1.output }}`, Genie 1's form) reads the node's input (`{{in.output}}`), which
 *   is what that upstream value is by the time it arrives; a branch's raw `{{ x.exitCode }} == 10` becomes its condition row.
 * Not imported, each NOTED with why: a machine-wide or app flow (Genie 2 keeps a flow in a workspace; GApps are not in
 * Genie 2), a workspace Genie 2 does not have, an unreadable graph, or a step with no Genie 2 counterpart (by node).
 * The store's door then reads each converted flow exactly as it reads any other (main/flow-kinds.ts).
 */

export interface V1FlowRow {
    readonly id: string;
    readonly appId: string | null;
    readonly title: string;
    readonly scopeJson: string;
    readonly graphJson: string;
}

export interface V1FlowPlanned {
    readonly id: string;
    readonly v1Id: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly document: Record<string, unknown>;
}

export interface V1FlowPlan {
    readonly flows: readonly V1FlowPlanned[];
    readonly notes: readonly string[];
}

export const V1_FLOW_IMPORT_PREFIX = 'flow_v1f_';

type V1Node = { id?: unknown; type?: unknown; position?: { x?: unknown; y?: unknown }; data?: { kind?: unknown; label?: unknown; config?: unknown } };
type V1Edge = { id?: unknown; source?: unknown; target?: unknown; sourceHandle?: unknown; targetHandle?: unknown };

const LAYOUT = new Set(['@particle-academy/terminal_lane', '@particle-academy/lane', 'terminal_lane', 'lane']);
const OPS: Record<string, string> = { '==': 'eq', '===': 'eq', '!=': 'neq', '!==': 'neq', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' };

function parse(json: string): unknown {
    try { return JSON.parse(json); } catch { return null; }
}

export function planV1FlowImport(rows: readonly V1FlowRow[] | null, ctx: { readonly workspaces: readonly { readonly id: string }[] }): V1FlowPlan | null {
    if (rows === null) return null;
    ensureGenieKinds();
    const flows: V1FlowPlanned[] = [];
    const notes: string[] = [];
    for (const row of rows) {
        const say = (why: string) => notes.push(`"${row.title}" (Genie 1 flow ${row.id}): ${why}; not imported`);
        const scope = parse(row.scopeJson) as { kind?: unknown; workspaceId?: unknown } | null;
        if (row.appId !== null || scope?.kind === 'gapp') { say('it belongs to a Genie App, and Genie Apps are not in Genie 2'); continue; }
        if (scope?.kind !== 'workspace' || typeof scope.workspaceId !== 'string') { say('it is a machine-wide flow, and Genie 2 keeps each flow in a workspace'); continue; }
        const ws = scope.workspaceId;
        if (!ctx.workspaces.some((w) => w.id === ws)) { say(`its workspace ${ws} is not in Genie 2`); continue; }
        const graph = parse(row.graphJson) as { nodes?: unknown; edges?: unknown } | null;
        if (!graph || !Array.isArray(graph.nodes)) { say('its graph could not be read'); continue; }
        const converted = convertGraph(graph.nodes as V1Node[], Array.isArray(graph.edges) ? (graph.edges as V1Edge[]) : [], ws);
        if (converted.problems.length > 0) { say(converted.problems.join('; ')); continue; }
        // Imported, with what of its settings had no Genie 2 counterpart said field by field (genie#1204).
        if (converted.dropped.length > 0) notes.push(`"${row.title}" (Genie 1 flow ${row.id}): imported; ${converted.dropped.join('; ')}`);
        flows.push({ id: `${V1_FLOW_IMPORT_PREFIX}${row.id}`, v1Id: row.id, workspaceId: ws, name: row.title, document: { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: converted.nodes, edges: converted.edges } } });
    }
    return { flows, notes };
}

function convertGraph(v1Nodes: readonly V1Node[], v1Edges: readonly V1Edge[], ws: string): { nodes: unknown[]; edges: unknown[]; problems: string[]; dropped: string[] } {
    const kindOf = (n: V1Node) => String(n.data?.kind ?? n.type ?? '');
    const kept = v1Nodes.filter((n) => !LAYOUT.has(kindOf(n)));
    const keptIds = new Set(kept.map((n) => String(n.id)));
    const edges = v1Edges.filter((e) => keptIds.has(String(e.source)) && keptIds.has(String(e.target)));
    const parents = new Map<string, string[]>();
    for (const e of edges) parents.set(String(e.target), [...(parents.get(String(e.target)) ?? []), String(e.source)]);
    const ancestorsOf = (id: string): Set<string> => {
        const seen = new Set<string>();
        const stack = [...(parents.get(id) ?? [])];
        while (stack.length > 0) { const p = stack.pop()!; if (!seen.has(p)) { seen.add(p); stack.push(...(parents.get(p) ?? [])); } }
        return seen;
    };
    const problems: string[] = [];
    const dropped: string[] = [];
    const nodes = kept.flatMap((n) => {
        const id = String(n.id);
        const up = ancestorsOf(id);
        const config = rewriteTemplates((n.data?.config ?? {}) as Record<string, unknown>, up) as Record<string, unknown>;
        const step = convertStep(kindOf(n), config, ws, up);
        if ('problem' in step) { problems.push(`node ${id}: ${step.problem}`); return []; }
        for (const d of step.dropped ?? []) dropped.push(`node ${id}: ${d}`);
        const label = typeof n.data?.label === 'string' && n.data.label.trim() !== '' ? { label: n.data.label } : {};
        const x = typeof n.position?.x === 'number' ? n.position.x : 0;
        const y = typeof n.position?.y === 'number' ? n.position.y : 0;
        return [{ id, kind: step.kind, position: { x, y }, ...label, config: step.config }];
    });
    return {
        nodes,
        edges: edges.map((e) => ({ id: String(e.id), source: String(e.source), target: String(e.target), ...(typeof e.sourceHandle === 'string' ? { sourceHandle: e.sourceHandle } : {}), ...(typeof e.targetHandle === 'string' ? { targetHandle: e.targetHandle } : {}) })),
        problems,
        dropped,
    };
}

/** `{{ run1.output }}` → `{{in.output}}` when `run1` is upstream of the node: by the time it arrives, that IS the input. */
function rewriteTemplates(value: unknown, upstream: ReadonlySet<string>): unknown {
    if (typeof value === 'string') {
        return value.replace(/\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_.$-]+)\s*\}\}/g, (whole, node: string, path: string) => (upstream.has(node) ? `{{in.${path}}}` : whole));
    }
    if (Array.isArray(value)) return value.map((v) => rewriteTemplates(v, upstream));
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteTemplates(v, upstream)]));
    return value;
}

type Step = { kind: string; config: Record<string, unknown>; dropped?: string[] } | { problem: string };

function convertStep(kind: string, config: Record<string, unknown>, ws: string, _upstream: ReadonlySet<string>): Step {
    const text = (k: string) => (typeof config[k] === 'string' ? (config[k] as string) : '');
    if (kind === '@genie/agentinbox' || kind === 'genie.agentinbox') {
        if ((config.action ?? 'send') !== 'send') return { problem: `Genie 1's agentinbox "${String(config.action)}" step has no counterpart in Genie 2's flows (only send: prompt an agent)` };
        return { kind: 'genie/agent_prompt', config: { agent: text('to'), prompt: text('text') } };
    }
    if (kind === '@genie/event_trigger' || kind === 'genie.event_trigger') {
        if (config.event !== 'files:added') return { problem: `Genie 1's "${String(config.event ?? '')}" event has no trigger in Genie 2's flows (a file being added does)` };
        return { kind: 'genie/file_added', config: { workspace: ws } };
    }
    if (kind.startsWith('@genie/') || kind.startsWith('genie.')) {
        const tool = kind.replace(/^@genie\/|^genie\./, '');
        // The same tool, under the same name, as a step (main/flow-tools.ts): its settings are that tool's arguments in both,
        // less the terminalId a flow never has and the workspaceId the flow's own workspace now gives.
        const same = `@genie/${tool}`;
        if (toolKinds().includes(same)) {
            const { terminalId: _t, workspaceId: _w, ...args } = config;
            return { kind: same, config: args };
        }
        if (tool === 'manageProcess') return fromManageProcess(config);
        if (tool === 'manageSite') return fromManageSite(config);
        if (tool === 'manageService') return fromManageService(config);
        return { problem: `Genie 1's ${tool} step has no counterpart in Genie 2's flows` };
    }
    const canonical = canonicalKind(kind);
    if (canonical === '@particle-academy/terminal_run') {
        const cwd = text('cwd').trim();
        return { kind: 'genie/terminal_run', config: { workspace: ws, command: text('command'), ...(config.failOnNonZero === false ? { allowFailure: true } : {}), ...(cwd && !/^([a-zA-Z]:|[\\/])/.test(cwd) ? { cwd } : {}) } };
    }
    if (canonical === '@particle-academy/branch' && typeof config.condition === 'string') {
        const m = /^\s*(\{\{[^}]+\}\})\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+?)\s*$/.exec(config.condition);
        if (m) {
            const { condition: _raw, ...rest } = config;
            return { kind, config: { ...narrow(canonical, rest), match: 'all', conditions: [{ left: m[1]!.replace(/\s+/g, ''), operator: OPS[m[2]!]!, right: m[3]!.replace(/^(['"])(.*)\1$/, '$2') }] } };
        }
    }
    return { kind, config: narrow(canonical, config) };
}

/** A fancy kind's config, narrowed to the fields its kind declares (Genie 1 graphs carry extras, like the schedule's `schedule`). */
function narrow(kind: string, config: Record<string, unknown>): Record<string, unknown> {
    const def = getNodeKind(kind);
    const keys = def?.configSchema?.map((f) => f.key);
    if (!keys || keys.length === 0) return config;
    return Object.fromEntries(Object.entries(config).filter(([k]) => keys.includes(k)));
}

/*
 * GENIE 1's RENAMED TOOLS, FIELD BY FIELD (genie#1204). manageProcess, manageSite and manageService are Genie 2's
 * `processes`, `sites` and `services`, with other argument names. Each Genie 1 argument (main/mcp/protocol.ts at
 * v0.7.0-beta.342: manageProcess :2272-2375, manageSite :2376-2576, manageService :2577-2690) is carried to the Genie 2
 * argument that does the same thing; only what genuinely has none is left out — and said, field by field, in the import's
 * notes. A step whose ACTION has no counterpart cannot be carried, and the flow is not imported. `terminalId` and
 * `workspaceId` go (a flow has no terminal; it acts in its own workspace). The ids of Genie 1 processes are their imported
 * ids (`proc_v1_<id>`, core/v1-processes.ts).
 */

const words = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

function fromManageProcess(c: Record<string, unknown>): Step {
    const actions: Record<string, string> = { list: 'list', create: 'add', start: 'start', stop: 'stop', restart: 'restart', enable: 'enable', disable: 'disable', delete: 'remove', 'run-now': 'run-now', logs: 'logs' };
    const action = actions[String(c.action ?? '')];
    if (!action) return { problem: `Genie 1's manageProcess "${words(c.action)}" has no counterpart in Genie 2's processes` };
    const out: Record<string, unknown> = { action };
    const dropped: string[] = [];
    if (typeof c.label === 'string') out.name = c.label;
    if (typeof c.command === 'string') out.command = c.command;
    if (typeof c.repo === 'string' && c.repo !== '') out.folder = `repos/${c.repo}`;
    for (const k of ['schedule', 'scheduleKind', 'prompt']) if (c[k] !== undefined) out[k] = c[k];
    const id = c.id ?? c.processId;
    if (typeof id === 'string') out.process = `proc_v1_${id}`;
    if (action === 'add' && c.schedule === undefined && c.autostart !== true) dropped.push('autostart (off): Genie 2 starts a process when it is added, and on every launch — there is no "keep it, but do not start it"');
    for (const k of ['nudgeAgentId', 'nudgeTerminalId']) if (typeof c[k] === 'string') dropped.push(`${k}: a Genie 1 agent id, which Genie 2 does not know; set the step's agent to the agent's Genie 2 address`);
    return { kind: '@genie/processes', config: out, dropped };
}

function fromManageSite(c: Record<string, unknown>): Step {
    const actions: Record<string, string> = { list: 'list', detect: 'detect', create: 'add', update: 'update', start: 'start', stop: 'stop', restart: 'restart', status: 'status', logs: 'logs', open: 'open', remove: 'remove' };
    const action = actions[String(c.action ?? '')];
    if (!action) return { problem: `Genie 1's manageSite "${words(c.action)}" has no counterpart in Genie 2's sites` };
    const out: Record<string, unknown> = { action };
    const dropped: string[] = [];
    if (typeof c.name === 'string') out.name = c.name;
    if (typeof c.repo === 'string' && c.repo !== '') out.repoPath = `repos/${c.repo}`;
    if (typeof c.id === 'string') out.site = c.id;
    if (typeof c.tail === 'number') out.lines = c.tail;
    const argv = Array.isArray(c.command) ? c.command : Array.isArray(c.serve) ? c.serve : null;
    const serve = c.hostServe !== null && typeof c.hostServe === 'object' ? (c.hostServe as Record<string, unknown>) : null;
    if (typeof c.hostPort === 'number') { out.mode = 'proxy'; out.hostPort = c.hostPort; }
    else if (serve && (serve.mode === 'static' || serve.mode === 'php')) {
        out.mode = serve.mode;
        if (typeof serve.root === 'string') out.root = serve.root;
        if (serve.mode === 'static' && typeof serve.spa === 'boolean') out.spa = serve.spa;
        if (serve.mode === 'php' && typeof serve.version === 'string') out.phpVersion = serve.version;
    } else if (serve) dropped.push(`hostServe.mode (${words(serve.mode)}): Genie 2 serves a site as proxy, static or php — not ${words(serve.mode)}`);
    else if (argv) {
        out.mode = 'proxy';
        out.devCommand = (argv as unknown[]).map(String).join(' ');
        if (typeof c.port === 'number') dropped.push(`port (${c.port}): Genie 2 chooses the port — put {port} in the command where it goes`);
    }
    // runMode, image and build are left out without a note: Genie 1 recorded them and never used them (manageSite's own
    // descriptions: "RECORDED BUT NOT USED", "RECORDED BUT NOT RUN", genie#125/#191) — dropping them changes nothing.
    if (Array.isArray(c.exposed) && c.exposed.length > 0) dropped.push('exposed: extra browser-facing surfaces have no counterpart in Genie 2\'s sites');
    if (c.env !== undefined) dropped.push('env: a site\'s own environment has no counterpart (the workspace\'s services env reaches it)');
    if (c.kind === 'tcp') dropped.push('kind (tcp): Genie 2 serves http sites');
    if (typeof c.genName === 'string') dropped.push('genName: Genie 2 names a site <name>.gen');
    if (typeof c.upstreamHost === 'string') dropped.push('upstreamHost: no counterpart in Genie 2\'s sites');
    if (c.enabled === false) dropped.push('enabled (false): Genie 2 serves a site when it is added');
    if (c.browserExposed === true) dropped.push('browserExposed: Genie 2\'s front door decides which sites external browsers reach');
    return { kind: '@genie/sites', config: out, dropped };
}

function fromManageService(c: Record<string, unknown>): Step {
    const actions: Record<string, string> = { catalog: 'catalog', list: 'list', status: 'list', add: 'add', start: 'start', stop: 'stop', logs: 'logs', remove: 'remove', connection: 'env' };
    const action = actions[String(c.action ?? '')];
    if (!action) return { problem: `Genie 1's manageService "${words(c.action)}" has no counterpart in Genie 2's services` };
    if (c.engine === 'minio') return { problem: 'Genie 1\'s MinIO engine has no counterpart in Genie 2\'s services (SeaweedFS is its S3 engine)' };
    const out: Record<string, unknown> = { action };
    const dropped: string[] = [];
    for (const k of ['engine', 'version', 'image', 'port', 'env', 'id', 'tail']) if (c[k] !== undefined) out[k] = c[k];
    if (typeof c.dedicated === 'boolean') out.scope = c.dedicated ? 'dedicated' : 'shared';
    if (Array.isArray(c.extensions)) {
        const rest = (c.extensions as unknown[]).map(String).filter((x) => x !== 'vector');
        if ((c.extensions as unknown[]).includes('vector')) out.variant = 'pgvector';
        if (rest.length > 0) dropped.push(`extensions (${rest.join(', ')}): Genie 2 offers pgvector as a Postgres variant, and no other extension`);
    }
    if (c.enabled === false) dropped.push('enabled (false): Genie 2 starts a service when it is added');
    if (c.purge === true) dropped.push('purge: deleting a service’s data is the person’s alone (Hosting → Services), never a flow’s');
    return { kind: '@genie/services', config: out, dropped };
}
