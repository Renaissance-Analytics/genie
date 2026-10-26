import type { ExecutorRegistry, NodeExecutor } from '@particle-academy/fancy-flow/engine';
import { QUESTION_DISMISSED, QUESTION_NONE_CHOSEN, toolKinds, waitMs } from '../core/flow-canvas.js';
import type { QuestionOutcome } from './flow-tools.js';
import type { MemoryClass, Scope } from './knowledge-store.js';

/**
 * FLOW EXECUTORS — what Genie's own node kinds DO in fancy-flow. What they ARE (name, ports, required config) is
 * registered with the engine in flow-kinds.ts, which the store validates against and the runner imports through.
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
    /** genie/file_move: into `toFolder` (relative) of the same workspace; `to: null` when it was already there. No shell. */
    moveFile?(workspaceId: string, from: string, toFolder: string): Promise<{ from: string; to: string | null }>;
    /** fancy-flow's Wait, for a duration (genie#1204): injected so a test need not wait in real time; a timer otherwise. */
    sleep?(ms: number): Promise<void>;
    /** A `@genie/<tool>` step (genie#1204, main/flow-tools.ts): the tool's own handler, called as the flow. */
    callTool?(tool: string, args: Record<string, unknown>): Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;
    /** A flow's question waits for the person (genie#1204, main/flow-tools.ts `questionWaiter`). Absent = it goes on at once. */
    awaitQuestion?(questionId: string, waitMs: number): Promise<QuestionOutcome>;
}

/** Every string in a step's settings rendered against its inputs; other values as they are. */
function renderDeep(value: unknown, inputs: Record<string, unknown>): unknown {
    if (typeof value === 'string') return renderTemplate(value, inputs);
    if (Array.isArray(value)) return value.map((v) => renderDeep(v, inputs));
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, inputs)]));
    return value;
}

/**
 * A flow's question, waited for (genie#1204): the port is the option the person chose for the FIRST question, "none chosen"
 * when they answered with a note alone, "dismissed" when they dismissed it, it was withdrawn, or no answer came in time.
 * The data carries every choice and note, so a later step can read what they wrote (`{{in.note}}`).
 */
async function questionAnswer(args: Record<string, unknown>, asked: unknown, wait: NonNullable<FlowPorts['awaitQuestion']>): Promise<unknown> {
    const questionId = (asked as { questionId?: unknown } | null)?.questionId;
    if (typeof questionId !== 'string') return asked;
    const minutes = typeof args.waitMinutes === 'number' && Number.isFinite(args.waitMinutes) && args.waitMinutes >= 0 ? args.waitMinutes : 24 * 60;
    const outcome = await wait(questionId, minutes * 60_000);
    if (outcome.kind !== 'answered') {
        return { __port: QUESTION_DISMISSED, value: { questionId, outcome: outcome.kind === 'timed out' ? 'timed out' : outcome.kind, note: outcome.kind === 'dismissed' ? (outcome.notes.find((x) => x.trim() !== '') ?? '') : '', notes: outcome.kind === 'dismissed' ? outcome.notes : [] } };
    }
    const { selections, notes = [], note } = outcome.answer;
    const options = ((args.questions as Array<{ options?: Array<{ label?: unknown }> }> | undefined)?.[0]?.options ?? []).map((o) => o.label);
    const choice = (selections[0] ?? []).find((label) => options.includes(label)) ?? null;
    const firstNote = (notes[0] ?? '').trim() || note.trim();
    return { __port: choice ?? QUESTION_NONE_CHOSEN, value: { questionId, outcome: 'answered', choice, choices: selections, note: firstNote, notes, overallNote: note } };
}

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
    // GENIE'S TOOLS AS STEPS (genie#1204): each `@genie/<tool>` calls the tool as the flow; a refusal or a denial fails
    // the step in the tool's words. checkIssues routes `found` / `none`, as Genie 1's node did (main/flows/kinds.ts).
    const toolSteps: ExecutorRegistry = Object.fromEntries(toolKinds().map((kind) => [kind, async (ctx: Ctx) => {
        const tool = kind.slice('@genie/'.length);
        if (!ports.callTool) ctx.abort(`Genie’s tools are not reachable from this run; ${tool} was not called`);
        const args = renderDeep(configOf(ctx), ctx.inputs as Record<string, unknown>) as Record<string, unknown>;
        const r = await ports.callTool!(tool, args);
        if (!r.ok) ctx.abort(r.error);
        const result = (r as { result: unknown }).result;
        if (tool === 'ForceTheQuestion' && (args.action ?? 'ask') === 'ask' && ports.awaitQuestion) {
            return questionAnswer(args, result, ports.awaitQuestion);
        }
        if (tool === 'checkIssues') {
            const answer = (result ?? {}) as { ok?: unknown; reason?: unknown; items?: unknown };
            if (answer.ok === false) ctx.abort(`checkIssues could not tell: ${String(answer.reason ?? 'no answer')}`);
            return { __port: Array.isArray(answer.items) && answer.items.length > 0 ? 'found' : 'none', value: result };
        }
        return result;
    }]));
    return {
        ...toolSteps,
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
        'genie/file_move': async (ctx) => {
            const config = configOf(ctx);
            const inputs = ctx.inputs as Record<string, unknown>;
            const workspace = text(config, 'workspace', inputs);
            const from = text(config, 'from', inputs);
            const to = text(config, 'to', inputs);
            if (!workspace || !from || !to) ctx.abort('genie/file_move needs a workspace, a file and a folder');
            if (!ports.moveFile) ctx.abort('moving a file is not available here');
            const moved = await ports.moveFile!(workspace, from, to);
            return { from: moved.from, to: moved.to ?? moved.from, moved: moved.to !== null };
        },
        // fancy-flow declares Wait and leaves running it to the host (it has no executor). Genie waits a DURATION; the
        // other modes are refused when the flow is saved (core/flow-canvas.ts structuralProblems), and again here.
        '@particle-academy/wait': async (ctx) => {
            const config = configOf(ctx);
            const ms = (config.mode ?? 'duration') === 'duration' ? waitMs(config.duration) : null;
            if (ms === null) ctx.abort(`Wait needs a duration Genie can wait (5s, 10m, 1h, up to 24h); it has "${String(config.duration ?? '')}"`);
            await (ports.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(ms!);
            const inputs = ctx.inputs as Record<string, unknown>;
            return { waited: 'duration', duration: ms, input: inputs.in ?? inputs };
        },
    };
}
