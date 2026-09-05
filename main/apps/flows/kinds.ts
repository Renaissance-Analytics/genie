/**
 * Genie's steps, as node kinds a canvas can offer — DERIVED, never hand-written.
 *
 * ## The bug this closes
 *
 * `nodes.ts` has always known which Genie tools could be flow steps. Nothing ever
 * put them in fancy-flow's registry, and nothing in the renderer ever asked for
 * them. So the palette a person saw was fancy-flow's 27 builtins — every one of
 * which Genie's executor refuses — and the steps Genie CAN run were unreachable.
 * The canvas could author only what would not run.
 *
 * ## Where a node's config panel comes from
 *
 * The tool's own MCP `inputSchema`. That is the same schema an agent calls the
 * tool with, so a panel built from it can express exactly the calls the tool
 * accepts — no more (a field for something the tool ignores) and no less (a call
 * an author cannot make from the canvas). Maintaining a second, hand-written
 * field list beside it would drift the first time a tool gained an argument, and
 * the drift would present as "the canvas can't do what the agent can".
 *
 * `terminalId` is the one deliberate omission: it identifies the agent's own
 * terminal, and a flow has none. Offering it would be a box whose only correct
 * value is empty.
 *
 * ## Everything here is SERIALIZABLE, and that is load-bearing
 *
 * The registry is per-process. `<FlowEditor>` reads the RENDERER's registry, and
 * the executors read MAIN's, so both have to register the same kinds. They do it
 * from one payload that crosses IPC — which means no `icon`, no `renderBody`, no
 * `component`, because a React element serializes to `{}` and the renderer would
 * end up with a kind subtly unlike main's. A test asserts the payload survives
 * `structuredClone`.
 */

import { getNodeKind, registerNodeKind } from '@particle-academy/fancy-flow/engine';
import { CORE_TOOLS } from '../../mcp/protocol';
import { listGenieNodeKinds, type GenieFlowNodeKind } from './nodes';

/* ===== the serializable definition ====================================== */

export interface GenieConfigField {
    key: string;
    label: string;
    type: 'text' | 'textarea' | 'number' | 'select' | 'switch' | 'json';
    description?: string;
    required?: boolean;
    default?: unknown;
    options?: { value: string; label: string }[];
}

export interface GenieNodeDefinition {
    /** The canonical kind id, e.g. `@genie/manageSite`. */
    name: string;
    /** The pre-namespace spelling, registered as an alias so old graphs resolve. */
    aliases: string[];
    /** The Genie tool this step calls. */
    tool: string;
    /** The capability that governs it — what a consent prompt would name. */
    capability: string;
    category: 'io' | 'human' | 'data' | 'output';
    label: string;
    description: string;
    configSchema: GenieConfigField[];
    inputs: { id: string }[];
    outputs: { id: string }[];
    sideEffects: 'none' | 'idempotent' | 'unsafe-to-replay';
}

/* ===== reading an MCP schema ============================================ */

interface JsonSchemaProp {
    type?: string;
    enum?: unknown[];
    description?: string;
    default?: unknown;
}

interface ToolLike {
    name: string;
    description?: string;
    inputSchema?: {
        properties?: Record<string, JsonSchemaProp>;
        required?: string[];
    };
}

const TOOLS = new Map((CORE_TOOLS as ToolLike[]).map((t) => [t.name, t]));

/**
 * A field's help text: the FIRST SENTENCE of the tool's own description.
 *
 * Genie's MCP descriptions are written for an agent reading a whole schema at
 * once, and several run to paragraphs. A config panel that reproduced them would
 * be unreadable, and truncating mid-word would be worse than saying less. The
 * first sentence is what the author of the field wrote to introduce it.
 */
function firstSentence(text: string | undefined): string | undefined {
    if (!text) return undefined;
    const trimmed = text.trim();
    if (trimmed === '') return undefined;
    const stop = /[.;](\s|$)/.exec(trimmed);
    const head = stop ? trimmed.slice(0, stop.index + 1) : trimmed;
    return head.length > 240 ? `${head.slice(0, 237)}…` : head;
}

/** Turn a word into something a form label can show. `hostPort` → `Host port`. */
function humanise(key: string): string {
    const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * One JSON-Schema property as a config field.
 *
 * An `enum` becomes a select whatever its type — a closed set of values is a
 * choice, and rendering it as free text invites a typo the tool will reject at
 * run time for reasons the author cannot see from the canvas.
 *
 * Anything that is not a scalar becomes `json`. Not a guess and not a fallback
 * to text: an array or a nested object typed into a text box would be stored as
 * a string and refused by the tool, so the field has to be one that produces the
 * right shape. Whether these deserve richer editors is a real question, and the
 * honest answer today is that a JSON box is correct and legible while a
 * half-guessed form is neither.
 */
function fieldFor(key: string, prop: JsonSchemaProp, required: boolean): GenieConfigField {
    const base = {
        key,
        label: humanise(key),
        ...(firstSentence(prop.description) ? { description: firstSentence(prop.description) } : {}),
        ...(required ? { required: true } : {}),
        ...(prop.default !== undefined ? { default: prop.default } : {}),
    };

    if (Array.isArray(prop.enum) && prop.enum.length > 0) {
        return {
            ...base,
            type: 'select',
            options: prop.enum.map((v) => ({ value: String(v), label: String(v) })),
        };
    }

    switch (prop.type) {
        case 'boolean':
            return { ...base, type: 'switch' };
        case 'number':
        case 'integer':
            return { ...base, type: 'number' };
        case 'string':
            return { ...base, type: 'text' };
        default:
            return { ...base, type: 'json' };
    }
}

/**
 * The step's own terminal id is never authorable.
 *
 * It identifies the AGENT's terminal so Genie can resolve which workspace the
 * call means. A flow is not an agent and has no terminal; its workspace comes
 * from the flow's scope. A box for it would have exactly one correct value.
 */
const NEVER_AUTHORABLE = new Set(['terminalId']);

function configSchemaFor(tool: string): GenieConfigField[] {
    const schema = TOOLS.get(tool)?.inputSchema;
    const props = schema?.properties ?? {};
    const required = new Set(schema?.required ?? []);

    return Object.entries(props)
        .filter(([key]) => !NEVER_AUTHORABLE.has(key))
        .map(([key, prop]) => fieldFor(key, prop, required.has(key)));
}

/* ===== side effects ===================================================== */

/**
 * How a step behaves on a retry — what `RunIdentity.isReplaySafe` and the
 * durable coordinator consult before running something a second time.
 *
 * Conservative by DEFAULT, and deliberately so: a tool nobody has classified is
 * assumed to write. The opposite default would mean forgetting to classify a new
 * writing tool silently makes it replayable, and the symptom of that is a
 * duplicated side effect nobody can trace to a missing table entry.
 *
 * Only the tools that are genuinely read-only are named.
 */
const READ_ONLY_TOOLS = new Set(['checkIssues', 'checkEnv', 'genieGuide', 'connectToGenie']);

/** Tools that write, but where writing the same thing twice changes nothing. */
const IDEMPOTENT_TOOLS = new Set(['knowledge', 'setEnv']);

function sideEffectsFor(tool: string): GenieNodeDefinition['sideEffects'] {
    if (READ_ONLY_TOOLS.has(tool)) return 'none';
    if (IDEMPOTENT_TOOLS.has(tool)) return 'idempotent';
    return 'unsafe-to-replay';
}

/* ===== ports ============================================================ */

/**
 * Steps whose OUTCOME is the point, and which therefore route.
 *
 * A step that can only continue forwards makes the author write a `branch` after
 * it to ask the question the step already answered. These are the cases where
 * the answer is the step's whole reason for existing — so it is a port.
 */
const ROUTING_PORTS: Readonly<Record<string, string[]>> = {
    // Did the agent finish, or fail? A flow that dispatches an agent and cannot
    // tell is not an orchestrator, it is a fire-and-forget.
    runAgent: ['done', 'failed'],
    // The convention the marketplace git nodes already use (`git_issue_list`,
    // `git_pr_list`, `git_log` all branch on whether anything matched).
    checkIssues: ['found', 'none'],
};

/**
 * Steps that stop and wait for a person.
 *
 * `ForceTheQuestion` is a question with options, so each option is a port: the
 * flow continues down the branch the person chose. That is the whole reason it
 * is worth having as a node rather than a message.
 */
const PAUSES: Readonly<Record<string, 'input' | 'approval'>> = {
    ForceTheQuestion: 'input',
};

function categoryFor(tool: string): GenieNodeDefinition['category'] {
    if (tool in PAUSES || tool === 'agentinbox' || tool === 'openFileForUser') return 'human';
    if (tool === 'imDone') return 'output';
    if (tool === 'knowledge' || tool === 'checkEnv' || tool === 'setEnv') return 'data';
    return 'io';
}

function outputsFor(tool: string): { id: string }[] {
    if (tool === 'imDone') return []; // A terminal step. Nothing follows it.
    return (ROUTING_PORTS[tool] ?? ['out']).map((id) => ({ id }));
}

/* ===== the definitions ================================================== */

function defineKind(node: GenieFlowNodeKind): GenieNodeDefinition {
    const tool = TOOLS.get(node.tool);
    return {
        name: node.kind,
        aliases: [node.legacyKind],
        tool: node.tool,
        capability: node.capability,
        category: categoryFor(node.tool),
        // The TOOL's name, not the capability's. `nodes.ts` carries the
        // capability label ("Run commands") because that is what a consent prompt
        // says; a palette entry has to say what the STEP is, and three steps all
        // labelled "Run commands" is a palette nobody can use.
        label: humanise(node.tool),
        description: firstSentence(tool?.description) ?? node.label,
        configSchema: configSchemaFor(node.tool),
        inputs: [{ id: 'in' }],
        outputs: outputsFor(node.tool),
        sideEffects: sideEffectsFor(node.tool),
    };
}

let cached: GenieNodeDefinition[] | null = null;

/**
 * Every Genie step, as a registrable definition.
 *
 * Built once — the capability catalogue and the tool schemas are both
 * compile-time constants, so a rebuild per call would be waste. Returned as the
 * same array each time, which also means the renderer and main really do get
 * identical objects rather than two equal ones.
 */
export function genieNodeDefinitions(): GenieNodeDefinition[] {
    if (!cached) cached = listGenieNodeKinds().map(defineKind);
    return cached;
}

/**
 * Put Genie's steps in this process's registry.
 *
 * Idempotent: registering a kind twice would throw, and this is called from
 * app boot, from the MCP tool, and from tests — none of which should have to
 * know whether one of the others got there first.
 */
export function registerGenieKinds(defs: GenieNodeDefinition[] = genieNodeDefinitions()): void {
    for (const def of defs) {
        if (getNodeKind(def.name)) continue;
        registerNodeKind(def as never);
    }
}
