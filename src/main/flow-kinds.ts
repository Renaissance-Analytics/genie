import { getNodeKind, registerNodeKind, type FlowGraph, type NodeKindDefinition } from '@particle-academy/fancy-flow/engine';
import { importWorkflow } from '@particle-academy/fancy-flow/schema';
import { canonicalFlowDocument, type FlowDocument } from '../core/flow-form.js';

/**
 * GENIE'S NODE KINDS, REGISTERED WITH FANCY-FLOW — and the one way a flow document is read: through the engine.
 *
 * fancy-flow validates a document against its global kind registry (`importWorkflow` in `/schema` reports an
 * unknown kind as an error and a node's config against its kind's `configSchema`). Genie's three step kinds are
 * Genie's, so the engine knows nothing of them until they are registered with `registerNodeKind` (`/engine`, the
 * React-free entry; the same registry `/schema` reads — both ESM entries share one registry chunk). They are
 * registered HERE, once, and both the store (what is accepted) and the runner (what is executed) come through
 * `importFlowDocument`, so a document is never accepted against one registry and run against another.
 *
 * What the executors (flow-executors.ts) need is what the config schema REQUIRES:
 * - `genie/agent_prompt`  — `agent` (an inbox address) and `prompt`;
 * - `genie/terminal_run`  — `workspace` and `command`; `cwd` optional, `allowFailure` a switch;
 * - `genie/knowledge_add` — `workspace` and `title`; `body`, `class` (one of four) and `tags` optional.
 *
 * ## Genie refuses what the engine only WARNS about
 *
 * `importWorkflow` reports a node's config problems (a required field missing, a wrong type, a value outside a
 * select's options) and an edge to a node that is not there as WARNINGS: an editor must be able to hold a
 * half-drawn graph. Genie's store does not hold drafts — anything it accepts can be armed and will run on a
 * schedule, unattended — so EVERY issue the engine raises, warning or error, refuses the document, in the
 * engine's words. A command step with no command is refused when it is created, not discovered at 03:00. And for
 * Genie's own kinds, a required field that is only whitespace counts as blank and is refused too (`blankRequired`).
 */

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
            { type: 'text', key: 'agent', label: 'Agent', placeholder: 'claude:atlas', required: true, description: 'An inbox address: {provider}:{name} or {workspace}:{provider}:{name}.' },
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
];

/**
 * Put Genie's kinds in fancy-flow's registry. Idempotent: a kind already registered under its name is left alone,
 * so every caller may call it and the registry still holds exactly one definition per kind.
 */
export function ensureGenieKinds(): void {
    for (const kind of GENIE_NODE_KINDS) {
        if (getNodeKind(kind.name)?.name !== kind.name) registerNodeKind(kind);
    }
}

export type FlowImport = { readonly ok: true; readonly document: FlowDocument; readonly graph: FlowGraph } | { readonly ok: false; readonly problems: readonly string[] };

/**
 * A flow document as the engine reads it: migrated to the canonical shape (core/flow-form.ts), imported by
 * fancy-flow's own `importWorkflow` with Genie's kinds registered, and refused on ANY issue (see the header).
 * The graph is the engine's own hydration — what the runner hands `runFlow`.
 */
export function importFlowDocument(document: unknown): FlowImport {
    ensureGenieKinds();
    const doc = canonicalFlowDocument(document);
    if (doc !== null && typeof doc === 'object' && ('nodes' in doc || 'edges' in doc)) {
        // Both shapes at once: the engine reads `graph` and would silently ignore the top-level steps.
        return { ok: false, problems: ['the document has nodes or edges both at the top level and under graph; send one graph'] };
    }
    const result = importWorkflow(doc);
    if (!result.ok || result.issues.length > 0) {
        const problems = result.issues.map((i) => (i.nodeId !== undefined ? `node ${i.nodeId}: ${i.message}` : i.edgeId !== undefined ? `edge ${i.edgeId}: ${i.message}` : i.message));
        return { ok: false, problems: problems.length > 0 ? problems : ['not a usable workflow (check version: 1)'] };
    }
    const blank = blankRequired(result.graph);
    if (blank.length > 0) return { ok: false, problems: blank };
    return { ok: true, document: doc as FlowDocument, graph: result.graph };
}

/**
 * After the engine's own check: a field Genie's kinds mark `required` whose value is a string that trims to "" is
 * BLANK, and refused. The engine only treats "" as missing, so a command of "   " would pass it and run nothing (or
 * a shell's idea of nothing) at 03:00. Worded as the engine words a missing field: `<key>: <Label> is required`.
 */
function blankRequired(graph: FlowGraph): string[] {
    const byName = new Map(GENIE_NODE_KINDS.map((k) => [k.name, k]));
    return graph.nodes.flatMap((node) => {
        const data = (node.data ?? {}) as { kind?: unknown; config?: Record<string, unknown> };
        const kind = typeof data.kind === 'string' ? byName.get(data.kind) : undefined;
        if (!kind) return [];
        const config = data.config ?? {};
        return (kind.configSchema ?? [])
            .filter((field) => field.required === true && typeof config[field.key] === 'string' && (config[field.key] as string).trim() === '')
            .map((field) => `node ${node.id}: ${field.key}: ${field.label} is required`);
    });
}
