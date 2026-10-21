import { ToolDefinition, type JsonObject, type McpToolResult } from '@particle-academy/prism-mcp';
import { flowNodes } from '../core/flow-form.js';
import { callerFrom } from './mcp-callers.js';
import { MIRRORED_TERMINAL_ID, type Caller, type Registration } from './mcp-tools.js';
import type { Actor, FlowRecord, FlowRun, FlowStore } from './flow-store.js';

/**
 * THE AGENTS' FLOWS (§6.6). An agent can write the watcher it needs — "every 30 minutes run this check; if it exits 10,
 * tell me" — as a flow, and read back how its runs went. It makes the very calls the Flows tab makes, on the same store
 * (flow-store.ts), validated by the same engine, run by the same scheduler and runner.
 *
 * **An agent makes a flow; the PERSON arms it.** Arming is when a schedule starts firing commands on the person's machine
 * with nobody watching (flow-store.ts), so it stays the person's, in the Flows tab. Everything here keeps that decision
 * whole rather than going around it:
 * - `create` is always DISARMED, whatever the agent asks for; `arm` goes to the store with the agent as the actor, which
 *   refuses it and NAMES the attempt on the flow — the tool answers with that refusal and builds no approval prompt.
 * - `runNow` runs only an ARMED flow. The scheduler's Run now runs a flow armed or not (it is the person's button), so an
 *   agent's Run now of a disarmed flow would execute shell steps the person never agreed to run — the arming decision,
 *   skipped. Armed, the person has agreed to that document running unattended; one more run of it is within that.
 * - `update` cannot change an ARMED flow's document: the person armed THAT document, and an edit under it would run
 *   unseen at the next due. The agent disarms it, changes it, and the person arms it again.
 * - Every step that names a workspace must name the caller's own: a flow lives in one workspace, and an agent's flow
 *   must not reach into another's (the person arming it would be arming a command somewhere they were not looking).
 * - `remove` only a flow this agent created (the store records who); `disarm` any of its workspace's flows — it only ever
 *   makes less happen, as the store says.
 *
 * A flow in another workspace is invisible: every action on it answers exactly as for an id that does not exist.
 */

/** What the tool acts on: the flow store, and the scheduler's Run now. Main wires the composition's. */
export interface FlowsPort {
    readonly store: Pick<FlowStore, 'list' | 'get' | 'schedules' | 'create' | 'update' | 'arm' | 'disarm' | 'remove'>;
    readonly runNow: (flowId: string) => Promise<FlowRun>;
}

export interface FlowToolsDeps {
    readonly resolveCaller: (terminalId: string) => Caller | null;
    /** `null` where this Genie keeps no flows (doctor mode), and every action says so. */
    readonly flows: FlowsPort | null;
}

const ok = (payload: unknown): McpToolResult => ({ text: JSON.stringify(payload), isError: false });
const err = (message: string): McpToolResult => ({ text: JSON.stringify({ ok: false, error: message }), isError: true });
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** How many runs `list` shows per flow; `get` shows every run the store keeps. */
export const LIST_RUNS = 5;
const NOT_HERE = 'this Genie keeps no flows (doctor mode runs none); nothing was done';
const ACTIONS = 'list, get, create, update, arm, disarm, runNow, remove';
/** Genie's step kinds that act in a workspace, by their `workspace` config (flow-kinds.ts). */
const WORKSPACE_STEPS = new Set(['genie/terminal_run', 'genie/knowledge_add']);

const byName = (by: Actor): string => (by.kind === 'agent' ? by.name : 'the person');

function summary(store: FlowsPort['store'], f: FlowRecord): Record<string, unknown> {
    return {
        id: f.id,
        name: f.name,
        armed: f.armed,
        createdBy: byName(f.createdBy),
        schedules: store.schedules(f.id),
        runs: f.runs.slice(-LIST_RUNS),
    };
}

function detail(store: FlowsPort['store'], f: FlowRecord): Record<string, unknown> {
    return { ...summary(store, f), createdAt: f.createdAt, updatedAt: f.updatedAt, document: f.document, refusals: f.refusals, runs: f.runs };
}

/** The first step that names a workspace other than the caller's, in words; null when every step stays home. */
function strayStep(document: unknown, workspaceId: string): string | null {
    for (const n of flowNodes(document)) {
        if (n === null || typeof n !== 'object' || !WORKSPACE_STEPS.has(n.kind)) continue;
        const ws = n.config?.workspace;
        // A missing or non-text workspace is the engine's to refuse, in its own words (the field is required text). A
        // template ({{in.ws}}) is text, and refused here: it could name any workspace when it runs.
        if (typeof ws === 'string' && ws !== workspaceId) {
            return `node ${String(n.id)} runs in workspace ${ws}; a flow an agent makes runs only in its own workspace, ${workspaceId}. Nothing was stored`;
        }
    }
    return null;
}

export function flowTools(deps: FlowToolsDeps): Registration[] {
    const tool: Registration = {
        definition: new ToolDefinition(
            'flows',
            'Your workspace’s flows — scheduled and repeating work Genie runs for you: a watcher (“every 30 minutes run this check; if it exits 10, prompt an agent”), a nightly job. '
                + 'A flow is a fancy-flow document `{ version: 1, graph: { nodes, edges } }`: triggers `schedule_trigger` {cron, timezone?} or `manual_trigger`; steps `genie/terminal_run` {workspace, command, cwd?, allowFailure?} (its output is {exitCode, output, ok}), '
                + '`genie/agent_prompt` {agent (an inbox address), prompt}, `genie/knowledge_add` {workspace, title, body?}; `branch` {conditions: [{left: "{{in.exitCode}}", operator: "eq", right: "10"}]} routes on its `true`/`false` port (an edge’s sourceHandle). '
                + 'A flow you create is created DISARMED and does not run: the person arms it in Genie’s Flows tab — an agent can never arm one, and `arm` only records that you asked. '
                + 'Actions: `list` — this workspace’s flows, armed or not, with their schedules and last runs. '
                + '`get` {id} — one flow: its document, refusals and every run’s outcome. '
                + '`create` {name, document} — every step in your own workspace. '
                + '`update` {id, name?, document?} — an armed flow’s document cannot change: disarm it first, and the person arms it again. '
                + '`arm` {id} — refused to agents and recorded on the flow, so the person sees it. '
                + '`disarm` {id}. '
                + '`runNow` {id} — one run of an ARMED flow, now; its outcome lands in its runs (`get`). '
                + '`remove` {id} — only a flow you created.',
            {
                type: 'object',
                properties: {
                    terminalId: MIRRORED_TERMINAL_ID,
                    action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'arm', 'disarm', 'runNow', 'remove'] },
                    id: { type: 'string', description: 'get / update / arm / disarm / runNow / remove: the flow’s id, from `list`.' },
                    name: { type: 'string', description: 'create / update: what to call it (queue watcher).' },
                    document: { type: 'object', description: 'create / update: the fancy-flow document, { version: 1, graph: { nodes, edges } }.' },
                },
                required: ['action'],
            },
            'Flows',
        ),
        handler: async (args: JsonObject, context) => {
            const caller = callerFrom(args, context.headers, deps.resolveCaller);
            if (typeof caller === 'string') return err(caller);
            const port = deps.flows;
            if (!port) return err(NOT_HERE);
            const { store } = port;
            const action = str(args.action) ?? '';
            const me: Actor = { kind: 'agent', id: caller.agentId, name: caller.agentName };
            // Every lookup is among THIS workspace's flows: another workspace's answers exactly as a missing one.
            const find = (): FlowRecord | string => {
                const id = str(args.id);
                if (!id) return `${action} needs \`id\`; \`flows list\` shows them. Nothing was done`;
                const f = store.get(id);
                return f && f.workspaceId === caller.workspaceId ? f : `no flow ${id} in this workspace; \`flows list\` shows them. Nothing was done`;
            };
            try {
                switch (action) {
                    case 'list':
                        return ok({ ok: true, flows: store.list(caller.workspaceId).map((f) => summary(store, f)) });
                    case 'get': {
                        const f = find();
                        if (typeof f === 'string') return err(f);
                        return ok({ ok: true, flow: detail(store, f) });
                    }
                    case 'create': {
                        const name = str(args.name);
                        if (!name || args.document === undefined) return err('create needs `name` and `document`. Nothing was stored');
                        const stray = strayStep(args.document, caller.workspaceId);
                        if (stray) return err(stray);
                        // No `armed`: whatever the agent sent, the store would ignore it for an agent — leaving it out says so here.
                        const f = await store.create({ workspaceId: caller.workspaceId, name, document: args.document, by: me });
                        return ok({ ok: true, flow: detail(store, f), note: `created DISARMED: it does not run until the person arms it in Genie’s Flows tab` });
                    }
                    case 'update': {
                        const f = find();
                        if (typeof f === 'string') return err(f);
                        const name = str(args.name);
                        if (name === undefined && args.document === undefined) return err('update needs `name` or `document`. Nothing was changed');
                        if (args.document !== undefined) {
                            if (f.armed) return err(`"${f.name}" is armed: the person armed the document it has. To change it, disarm it first (\`flows disarm\`); the person arms it again. Nothing was changed`);
                            const stray = strayStep(args.document, caller.workspaceId);
                            if (stray) return err(stray);
                        }
                        const next = await store.update(f.id, { ...(name === undefined ? {} : { name }), ...(args.document === undefined ? {} : { document: args.document }) }, me);
                        return ok({ ok: true, flow: detail(store, next) });
                    }
                    case 'arm': {
                        const f = find();
                        if (typeof f === 'string') return err(f);
                        // The store refuses an agent and records the attempt on the flow; its words are the answer.
                        const r = await store.arm(f.id, me);
                        return r.ok ? ok({ ok: true, flow: detail(store, r.flow) }) : err(r.reason);
                    }
                    case 'disarm': {
                        const f = find();
                        if (typeof f === 'string') return err(f);
                        return ok({ ok: true, flow: detail(store, await store.disarm(f.id, me)) });
                    }
                    case 'runNow': {
                        const f = find();
                        if (typeof f === 'string') return err(f);
                        if (!f.armed) return err(`"${f.name}" is not armed, so nothing in it runs — on a schedule or on demand — until the person arms it in Genie’s Flows tab. Nothing was run`);
                        // Started, not awaited, as the Flows tab's Run now is: a prompted agent's turn can take minutes. The
                        // outcome lands in the flow's runs (a run already going is recorded held). A rejection here is a flow
                        // removed while it ran, which has no runs left to read.
                        void port.runNow(f.id).catch(() => {});
                        return ok({ ok: true, started: f.id, note: 'running now; its outcome lands in the flow’s runs (`flows get`)' });
                    }
                    case 'remove': {
                        const f = find();
                        if (typeof f === 'string') return err(f);
                        if (f.createdBy.kind !== 'agent' || f.createdBy.id !== caller.agentId) {
                            return err(`"${f.name}" was made by ${byName(f.createdBy)}; an agent removes only a flow it created (\`disarm\` stops it). Nothing was done`);
                        }
                        await store.remove(f.id);
                        return ok({ ok: true, removed: f.id });
                    }
                    default:
                        return err(`unknown action ${JSON.stringify(action)}; the actions are ${ACTIONS}`);
                }
            } catch (error) {
                return err((error as Error).message);
            }
        },
    };
    return [tool];
}
