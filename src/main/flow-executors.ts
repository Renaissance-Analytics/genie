import type { ExecutorRegistry, NodeExecutor } from '@particle-academy/fancy-flow/engine';
import type { MemoryClass, Scope } from './knowledge-store.js';

/**
 * FLOW EXECUTORS — Genie's own node kinds for fancy-flow.
 *
 * Every effect sits behind an injected port (`FlowPorts`), so a flow runs in a test with no agent,
 * no pty and no store, and in production the ports are the session host, the supervisor and the
 * knowledge store. Three kinds to start, each namespaced `genie/…`:
 *
 * - `genie/agent_prompt`  — prompt an agent (by inbox address) and wait for its reply.
 * - `genie/terminal_run`  — run a command in a workspace terminal; a non-zero exit FAILS the node
 *                           unless `allowFailure`, because a pipeline that shrugs at a failing step
 *                           reports success it did not earn.
 * - `genie/knowledge_add` — add a knowledge node, scoped to the flow's workspace by default.
 *
 * Config values are templates: `{{in.text}}` resolves a dotted path into the node's inputs. A
 * missing path renders EMPTY — never the literal braces, which an agent would read as instructions.
 */

export interface FlowPorts {
    promptAgent(address: string, text: string): Promise<string>;
    runCommand(workspaceId: string, command: string, cwd: string | undefined): Promise<{ exitCode: number; output: string }>;
    addKnowledge(input: { title: string; body: string; class: MemoryClass; scope: Scope; tags: string[] }): Promise<{ id: string }>;
}

export interface GenieNodeKind {
    readonly name: string;
    readonly category: 'action';
    readonly label: string;
    readonly description: string;
    readonly icon: string;
    readonly inputs: ReadonlyArray<{ id: string; label?: string }>;
    readonly outputs: ReadonlyArray<{ id: string; label?: string }>;
    readonly configSchema: ReadonlyArray<Record<string, unknown>>;
}

export const GENIE_NODE_KINDS: readonly GenieNodeKind[] = [
    {
        name: 'genie/agent_prompt',
        category: 'action',
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
        category: 'action',
        label: 'Run a command',
        description: 'Run a command in a workspace terminal and read its exit code and output.',
        icon: '⌨',
        inputs: [{ id: 'in' }],
        outputs: [{ id: 'out', label: 'result' }],
        configSchema: [
            { type: 'text', key: 'workspace', label: 'Workspace', required: true },
            { type: 'text', key: 'command', label: 'Command', required: true },
            { type: 'text', key: 'cwd', label: 'Working directory', description: 'Relative to the workspace; empty = the workspace root.' },
            { type: 'toggle', key: 'allowFailure', label: 'Continue on a non-zero exit', default: false },
        ],
    },
    {
        name: 'genie/knowledge_add',
        category: 'action',
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

/** `{{a.b.c}}` → the value at that path in `inputs`, stringified; missing → empty. */
export function renderTemplate(template: string, inputs: Record<string, unknown>): string {
    return template.replace(/\{\{\s*([A-Za-z0-9_.$-]+)\s*\}\}/g, (_m, path: string) => {
        let cur: unknown = inputs;
        for (const seg of path.split('.')) {
            if (cur === null || typeof cur !== 'object' || !(seg in (cur as Record<string, unknown>))) return '';
            cur = (cur as Record<string, unknown>)[seg];
        }
        if (cur === undefined || cur === null) return '';
        return typeof cur === 'object' ? JSON.stringify(cur) : String(cur);
    });
}

type Ctx = Parameters<NodeExecutor>[0];

function configOf(ctx: Ctx): Record<string, unknown> {
    const data = (ctx.node as { data?: { config?: Record<string, unknown> } }).data;
    return data?.config ?? {};
}

const text = (config: Record<string, unknown>, key: string, inputs: Record<string, unknown>): string => {
    const raw = config[key];
    return typeof raw === 'string' ? renderTemplate(raw, inputs) : '';
};

export function genieExecutors(ports: FlowPorts): ExecutorRegistry {
    return {
        'genie/agent_prompt': async (ctx) => {
            const config = configOf(ctx);
            const inputs = ctx.inputs as Record<string, unknown>;
            const agent = text(config, 'agent', inputs);
            if (!agent) ctx.abort('genie/agent_prompt needs an agent address in its config');
            const prompt = text(config, 'prompt', inputs);
            const reply = await ports.promptAgent(agent, prompt);
            return { reply, agent };
        },
        'genie/terminal_run': async (ctx) => {
            const config = configOf(ctx);
            const inputs = ctx.inputs as Record<string, unknown>;
            const workspace = text(config, 'workspace', inputs);
            const command = text(config, 'command', inputs);
            if (!workspace || !command) ctx.abort('genie/terminal_run needs a workspace and a command');
            const cwd = text(config, 'cwd', inputs) || undefined;
            const r = await ports.runCommand(workspace, command, cwd);
            if (r.exitCode !== 0 && config.allowFailure !== true) ctx.abort(`${command} ended with exit code ${r.exitCode}`);
            return { exitCode: r.exitCode, output: r.output, ok: r.exitCode === 0 };
        },
        'genie/knowledge_add': async (ctx) => {
            const config = configOf(ctx);
            const inputs = ctx.inputs as Record<string, unknown>;
            const workspace = text(config, 'workspace', inputs);
            const title = text(config, 'title', inputs);
            if (!workspace || !title) ctx.abort('genie/knowledge_add needs a workspace and a title');
            const cls = (typeof config.class === 'string' ? config.class : 'knowledge') as MemoryClass;
            const tags = text(config, 'tags', inputs).split(',').map((t) => t.trim()).filter((t) => t.length > 0);
            return ports.addKnowledge({ title, body: text(config, 'body', inputs), class: cls, scope: { kind: 'workspace', id: workspace }, tags });
        },
    };
}
