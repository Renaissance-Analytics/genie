import { randomBytes } from 'node:crypto';
import type { ConfigField, NodeKindDefinition } from '@particle-academy/fancy-flow/engine';
import { registerToolKinds } from '../core/flow-canvas.js';
import type { AgentId } from '../core/identity.js';
import type { AttentionStore, QuestionLeft } from './attention-store.js';
import type { FlowRecord } from './flow-store.js';
import { genieToolDeps } from './genie-tool-deps.js';
import { allGenieTools } from './mcp-registrations.js';
import type { Caller, Registration } from './mcp-tools.js';

/**
 * GENIE'S TOOLS AS FLOW STEPS (genie#1204) — Genie 1's design, on Genie 2's tools.
 *
 * Genie 1 put every Genie tool a Genie App could be granted on the canvas as `@genie/<tool>` (main/flows/nodes.ts:1-80 at
 * v0.7.0-beta.342, one node per tool of each capability in main/apps/capabilities.ts:40-135). Each node's config panel was
 * the tool's OWN MCP input schema — an enum a select, a boolean a switch, a scalar a field, anything else JSON — with
 * `terminalId` never authorable, because a flow is not an agent and has no terminal (main/flows/kinds.ts:120-170). A step
 * ran through the same tool call an agent makes, as the FLOW (main/flows/executors.ts "THE DOOR", main/flows/
 * dispatch-call.ts: `handleMcpMessage` with a flow caller identity).
 *
 * Here: each step calls the tool's real handler with a session key that resolves to the flow as the caller — in its own
 * workspace, by its own name (`flow "nightly"`). So every rule the tool applies to an agent applies to the flow: its own
 * workspace only, the same refusals, and the same approval gate — a step that needs the person's approval holds the run on
 * the Deck question until they answer, and a denial fails the step in the tool's words.
 *
 * Offered: the tools of Genie 1's catalogue that Genie 2 has (Genie 1 name → Genie 2 tool): manageTerminals, manageProcess →
 * processes, manageSite → sites, manageService → services, knowledge, checkIssues, openFileForUser, imDone, agentinbox,
 * ForceTheQuestion. Not offered: Genie 1's runAgent, setEnv/checkEnv, manageWorkspaces/provisionWorkspaces (Genie 2 has no
 * such tool); Genie 2's thumbsUp and plan (an agent's own session), createAgent, workspaceTabs and pages (the workspace's
 * default agent only), flows and lists (an agent's own records) — a flow cannot act as any of those callers.
 * Ports, as Genie 1's (kinds.ts ROUTING_PORTS, outputsFor): checkIssues routes `found` / `none`; imDone ends a chain.
 */

export const FLOW_TOOLS: readonly string[] = ['knowledge', 'manageTerminals', 'processes', 'sites', 'services', 'checkIssues', 'openFileForUser', 'imDone', 'agentinbox', 'ForceTheQuestion'];

export const TOOL_KIND_PREFIX = '@genie/';

const ROUTING_PORTS: Readonly<Record<string, string[]>> = { checkIssues: ['found', 'none'] };

/** In a flow, how long a question waits for the person before the run goes on as timed out (genie#1204). */
export const DEFAULT_QUESTION_WAIT_MINUTES = 24 * 60;
const WAIT_MINUTES = { type: 'number', key: 'waitMinutes', label: 'Wait for an answer (minutes)', min: 0, default: DEFAULT_QUESTION_WAIT_MINUTES, description: 'How long the run waits; then the question is taken back and the run goes on down "dismissed", as timed out.' } as unknown as ConfigField;
const NEVER_AUTHORABLE = new Set(['terminalId']);

interface JsonSchemaProp { type?: string; enum?: unknown[]; description?: string; default?: unknown }

/** A field's help: the FIRST SENTENCE of the tool's own description (Genie 1's `firstSentence`). */
function firstSentence(text: string | undefined): string | undefined {
    if (!text) return undefined;
    const trimmed = text.trim();
    if (trimmed === '') return undefined;
    const stop = /[.;](\s|$)/.exec(trimmed);
    const head = stop ? trimmed.slice(0, stop.index + 1) : trimmed;
    return head.length > 240 ? `${head.slice(0, 237)}…` : head;
}

/** `hostPort` → `Host port` (Genie 1's `humanise`). */
function humanise(key: string): string {
    const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function fieldFor(key: string, prop: JsonSchemaProp, required: boolean): ConfigField {
    const description = firstSentence(prop.description);
    const base = { key, label: humanise(key), ...(description ? { description } : {}), ...(required ? { required: true } : {}), ...(prop.default !== undefined ? { default: prop.default } : {}) };
    if (Array.isArray(prop.enum) && prop.enum.length > 0) return { ...base, type: 'select', options: prop.enum.map((v) => ({ value: String(v), label: String(v) })) } as ConfigField;
    switch (prop.type) {
        case 'boolean': return { ...base, type: 'switch' } as ConfigField;
        case 'number': case 'integer': return { ...base, type: 'number' } as ConfigField;
        case 'string': return { ...base, type: 'text' } as ConfigField;
        default: return { ...base, type: 'json' } as ConfigField;
    }
}

function categoryFor(tool: string): NodeKindDefinition['category'] {
    if (tool === 'ForceTheQuestion' || tool === 'agentinbox' || tool === 'openFileForUser') return 'human';
    if (tool === 'imDone') return 'output';
    if (tool === 'knowledge') return 'data';
    return 'io';
}

/** One Genie tool as a node kind — serializable (no icon, no render function): the editor window gets the same object. */
export function toolKindOf(def: { name: string; description: string; inputSchema: Record<string, unknown>; title: string | null }): NodeKindDefinition {
    const schema = def.inputSchema as { properties?: Record<string, JsonSchemaProp>; required?: string[] };
    const required = new Set(schema.required ?? []);
    const configSchema = Object.entries(schema.properties ?? {}).filter(([key]) => !NEVER_AUTHORABLE.has(key)).map(([key, prop]) => fieldFor(key, prop, required.has(key)));
    return {
        name: `${TOOL_KIND_PREFIX}${def.name}`,
        aliases: [`genie.${def.name}`],
        category: categoryFor(def.name),
        label: def.title ?? humanise(def.name),
        description: firstSentence(def.description) ?? def.name,
        configSchema: def.name === 'ForceTheQuestion' ? [...configSchema, WAIT_MINUTES] : configSchema,
        inputs: [{ id: 'in' }],
        outputs: def.name === 'imDone' ? [] : (ROUTING_PORTS[def.name] ?? ['out']).map((id) => ({ id })),
    };
}

let cached: NodeKindDefinition[] | null = null;

/**
 * Every offered tool as a node kind, from the tools' own definitions. Built from the tool list with no dependencies wired:
 * a definition is the tool's name, description and schema, which exist before any handler could run (as doctor mode and
 * the tool-list test build them).
 */
export function flowToolDefinitions(): NodeKindDefinition[] {
    if (cached) return cached;
    const never = (() => { throw new Error('a tool definition was asked to run'); }) as never;
    const registrations = allGenieTools(genieToolDeps({
        inbox: never, attention: never, knowledge: never, settings: never, approve: never, roster: () => [], resolveCaller: () => null,
        userActive: () => true, glow: () => false, thumbsUp: () => {}, openFile: never, terminals: never,
        plugins: { tools: () => [], guard: () => null, run: never },
    }));
    cached = FLOW_TOOLS.flatMap((tool) => {
        const reg = registrations.find((r) => r.definition.name === tool);
        return reg ? [toolKindOf(reg.definition as unknown as { name: string; description: string; inputSchema: Record<string, unknown>; title: string | null })] : [];
    });
    return cached;
}

/** Register the tool kinds in this process (the store's door and the runner read them). Idempotent. */
export function ensureFlowToolKinds(): void {
    registerToolKinds(flowToolDefinitions());
}

/**
 * THE FLOW AS A CALLER of Genie's tools: a session key per flow, resolving to the flow — its id, `flow "<name>"`, its
 * workspace and that workspace's folder. Main's caller resolution asks this first; a key it did not mint is nobody.
 */
export class FlowCallers {
    readonly #workspacePath: (workspaceId: string) => string | null;
    readonly #byKey = new Map<string, { flowId: string; name: string; workspaceId: string }>();
    readonly #keyOf = new Map<string, string>();

    constructor(workspacePath: (workspaceId: string) => string | null) {
        this.#workspacePath = workspacePath;
    }

    keyFor(flow: Pick<FlowRecord, 'id' | 'name' | 'workspaceId'>): string {
        const key = this.#keyOf.get(flow.id) ?? `flow-session-${randomBytes(16).toString('hex')}`;
        this.#keyOf.set(flow.id, key);
        this.#byKey.set(key, { flowId: flow.id, name: flow.name, workspaceId: flow.workspaceId });
        return key;
    }

    callerFor(key: string): Caller | null {
        const f = this.#byKey.get(key);
        if (!f) return null;
        const path = this.#workspacePath(f.workspaceId);
        return path === null ? null : { agentId: f.flowId as AgentId, agentName: `flow "${f.name}"`, workspaceId: f.workspaceId, workspacePath: path, kind: 'flow' };
    }
}

export type FlowToolCall = (flow: Pick<FlowRecord, 'id' | 'name' | 'workspaceId'>, tool: string, args: Record<string, unknown>) => Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;

/** One step's tool call: the tool's real handler, as the flow. An offered tool only. */
export function createFlowToolCaller(deps: { registrations: readonly Registration[]; callers: FlowCallers }): FlowToolCall {
    return async (flow, tool, args) => {
        if (!FLOW_TOOLS.includes(tool)) return { ok: false, error: `Genie does not let a flow call “${tool}”` };
        const reg = deps.registrations.find((r) => r.definition.name === tool);
        if (!reg) return { ok: false, error: `Genie has no “${tool}” tool here` };
        const { terminalId: _never, ...rest } = args;
        try {
            const r = await reg.handler(rest as never, { server: 'genie', tool, headers: { 'genie-session': deps.callers.keyFor(flow) } } as never);
            let parsed: unknown = r.text;
            try { parsed = JSON.parse(r.text); } catch { /* plain text */ }
            if (r.isError) {
                const message = parsed !== null && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string' ? (parsed as { error: string }).error : r.text;
                return { ok: false, error: message };
            }
            return { ok: true, result: parsed };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    };
}

/** How a flow's question ended (genie#1204): answered, dismissed or withdrawn by the person's side, or no answer in time. */
export type QuestionOutcome = QuestionLeft | { readonly kind: 'timed out' };

/**
 * A FLOW'S ForceTheQuestion WAITS (genie#1204; the owner: "do it better than Genie 1"). Genie 1's question node returned at
 * once — it could not resume a paused run (main/flows/refusals.ts:45-70 at v0.7.0-beta.342) — so a flow could ask but never
 * act on the answer. Here the step holds the run, like an approval, until the question LEAVES: answered, dismissed (or
 * withdrawn) — or, after `waitMs`, it is withdrawn (the person is not asked any more) and the run goes on as timed out.
 */
export function questionWaiter(attention: Pick<AttentionStore, 'onLeave' | 'pending' | 'withdraw' | 'leftOutcome'>): (questionId: string, waitMs: number) => Promise<QuestionOutcome> {
    return (questionId, waitMs) => new Promise<QuestionOutcome>((resolve) => {
        const asked = attention.pending().find((q) => q.id === questionId);
        // Already gone: answered (or dismissed) in the moment between the ask and this wait — that answer counts.
        if (!asked) { resolve(attention.leftOutcome(questionId) ?? { kind: 'withdrawn' }); return; }
        let settled = false;
        const finish = (outcome: QuestionOutcome) => { if (settled) return; settled = true; off(); clearTimeout(timer); resolve(outcome); };
        let timingOut = false;
        // Our own take-back on the timeout is not the person withdrawing it: that one ends as timed out, below.
        const off = attention.onLeave((id, outcome) => { if (id === questionId && !(timingOut && outcome.kind === 'withdrawn')) finish(outcome); });
        const timer = setTimeout(() => {
            timingOut = true;
            // Taken back first, so the person is not asked about a run that has moved on.
            void attention.withdraw({ agentId: asked.agentId, workspaceId: asked.workspaceId }, questionId).catch(() => {}).finally(() => finish({ kind: 'timed out' }));
        }, Math.max(0, waitMs));
    });
}
