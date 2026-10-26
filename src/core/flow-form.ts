import type { WorkflowSchema } from '@particle-academy/fancy-flow/schema';
import type { FlowForm } from './forms.js';

/**
 * THE "ADD A FLOW" FORM'S DOCUMENT — pure, and free of Node imports so the renderer's form can use it
 * (core/forms.ts reads the disk for the site form and must stay out of the renderer bundle).
 *
 * What a flow made with the form RUNS when its schedule fires (hosting ship line P4): a command in the
 * workspace (`genie/terminal_run`, the folder relative to the workspace), a prompt to an agent
 * (`genie/agent_prompt`, an inbox address), or a log line (`log`) — the last only says the schedule fired.
 */
export type FlowStep =
    | { readonly kind: 'log' }
    | { readonly kind: 'command'; readonly command: string; readonly folder: string }
    | { readonly kind: 'agent'; readonly agent: string; readonly prompt: string };

/**
 * THE ONE SHAPE A FLOW DOCUMENT HAS: fancy-flow's `WorkflowSchema` — `{ $schema, version: 1, graph: { nodes, edges } }`,
 * exactly what the engine's `exportWorkflow` writes and its `importWorkflow` reads (`schema.graph.nodes`).
 *
 * Earlier betas wrote `nodes` and `edges` at the TOP level, and `importWorkflow` reads none of them there — so every
 * such document validated ZERO nodes and passed. Those documents (a flows.json from an earlier beta, an agent that
 * sends the old shape) are MIGRATED by `canonicalFlowDocument` wherever a document comes in — the store's create,
 * update, Genie 1 import and open — so nothing is ever stored or run in two shapes.
 *
 * The URL is the engine's own literal: the type is `WorkflowSchema['$schema']`, so a different string is a type error
 * (a type-only import — this module stays free of runtime imports, for the renderer).
 */
export const FLOW_SCHEMA_URL: WorkflowSchema['$schema'] = 'https://particle.academy/schemas/workflow/v1.json';

export type FlowDocument = WorkflowSchema;

/**
 * Any flow document into the canonical shape: a version-1 document with top-level `nodes`/`edges` is moved under
 * `graph`, and a version-1 document without `$schema` gains it. Anything else (not an object, another version) is
 * returned AS IS for the engine to refuse in its own words. A document already canonical is returned unchanged
 * (the same object), so a caller can tell whether anything moved.
 */
export function canonicalFlowDocument(document: unknown): unknown {
    if (document === null || typeof document !== 'object' || Array.isArray(document)) return document;
    const doc = document as Record<string, unknown>;
    if (doc.version !== 1) return doc;
    const hasGraph = doc.graph !== null && typeof doc.graph === 'object';
    if (!hasGraph && ('nodes' in doc || 'edges' in doc)) {
        const { nodes, edges, ...rest } = doc;
        return { $schema: FLOW_SCHEMA_URL, ...rest, graph: { nodes: Array.isArray(nodes) ? nodes : [], edges: Array.isArray(edges) ? edges : [] } };
    }
    return doc.$schema === undefined ? { $schema: FLOW_SCHEMA_URL, ...doc } : doc;
}

/**
 * A schedule feeding one step — the document the form makes, in the canonical shape. No timezone: the schedule is
 * evaluated in this machine's local time, as Genie 1's were (core/cron.ts).
 */
export function flowDocument(input: { workspaceId: string; cron: string; step: FlowStep }): FlowDocument {
    const { step } = input;
    const node =
        step.kind === 'command'
            ? { id: 's', kind: 'genie/terminal_run', position: { x: 240, y: 0 }, config: { workspace: input.workspaceId, command: step.command.trim(), ...(step.folder.trim() ? { cwd: step.folder.trim() } : {}) } }
            : step.kind === 'agent'
              ? { id: 's', kind: 'genie/agent_prompt', position: { x: 240, y: 0 }, config: { agent: step.agent.trim(), prompt: step.prompt } }
              : { id: 's', kind: 'log', position: { x: 240, y: 0 }, config: { message: 'tick' } };
    return {
        $schema: FLOW_SCHEMA_URL,
        version: 1,
        graph: {
            nodes: [{ id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: input.cron.trim() } }, node],
            edges: [{ id: 'e1', source: 't', target: 's' }],
        },
    };
}

export type FlowDocNode = { id: string; kind: string; config?: Record<string, unknown> };

/** The step kinds the form writes (flowDocument). */
const FORM_STEPS = new Set(['genie/terminal_run', 'genie/agent_prompt', 'log']);

/**
 * Whether the Add-a-flow form can EDIT this document without losing anything (genie#1204): exactly one schedule and at
 * most one step of a kind the form writes. A bigger flow (an agent's multi-step one) is refused for the form rather than
 * flattened into what the form can show.
 */
export function formEditable(document: unknown): boolean {
    const nodes = flowNodes(document);
    const triggers = nodes.filter((n) => /(^|\/)schedule_trigger$/.test(n.kind));
    const steps = nodes.filter((n) => !/(^|\/)schedule_trigger$/.test(n.kind));
    return triggers.length === 1 && steps.length <= 1 && steps.every((n) => FORM_STEPS.has(n.kind));
}

/** A document's nodes, read from the canonical shape (an old top-level document is migrated first). */
export function flowNodes(document: unknown): FlowDocNode[] {
    const doc = canonicalFlowDocument(document) as { graph?: { nodes?: unknown } } | null;
    const nodes = doc !== null && typeof doc === 'object' && doc.graph !== null && typeof doc.graph === 'object' ? doc.graph.nodes : undefined;
    return Array.isArray(nodes) ? (nodes as FlowDocNode[]) : [];
}

/** The schedule and the step a document holds, as the form shows them (the first of each). */
export function flowFields(document: unknown): { cron: string; step: FlowStep } {
    const nodes = flowNodes(document);
    const trigger = nodes.find((n) => /(^|\/)schedule_trigger$/.test(n.kind));
    const cron = typeof trigger?.config?.cron === 'string' ? trigger.config.cron : '';
    const text = (n: FlowDocNode, key: string) => (typeof n.config?.[key] === 'string' ? (n.config[key] as string) : '');
    const command = nodes.find((n) => n.kind === 'genie/terminal_run');
    if (command) return { cron, step: { kind: 'command', command: text(command, 'command'), folder: text(command, 'cwd') } };
    const agent = nodes.find((n) => n.kind === 'genie/agent_prompt');
    if (agent) return { cron, step: { kind: 'agent', agent: text(agent, 'agent'), prompt: text(agent, 'prompt') } };
    return { cron, step: { kind: 'log' } };
}

/** The form as submitted — its fields by name, as the DOM hands them over — into a `FlowForm`. */
export function flowFormFromFields(defaults: FlowForm, fields: Readonly<Record<string, string>>): FlowForm {
    const field = (name: string) => fields[name] ?? '';
    const kind = field('step');
    const step: FlowStep =
        kind === 'command' ? { kind: 'command', command: field('command'), folder: field('folder') } : kind === 'agent' ? { kind: 'agent', agent: field('agent'), prompt: field('prompt') } : { kind: 'log' };
    return {
        workspaceId: defaults.workspaceId,
        name: field('name'),
        armed: field('armed') === 'on',
        document: flowDocument({ workspaceId: defaults.workspaceId, cron: field('cron'), step }),
    };
}
