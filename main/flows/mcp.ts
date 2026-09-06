/**
 * `manageFlows` — how an AGENT authors a flow.
 *
 * Genie's flows will mostly be written by agents, which makes this the half of
 * the feature that did not exist: phase 1 of genie#394 shipped a complete flow
 * model that nothing in Genie could create, and there was no MCP tool at all.
 *
 * `fancy-flow-mcp` does exactly this job — list kinds, add and connect nodes,
 * configure, validate, export a `WorkflowSchema` — and is **Laravel-only**
 * (`composer require particle-academy/fancy-flow-mcp`, no npm path). So Genie
 * builds the surface itself, thinly, over primitives the engine already
 * exports: `getNodeKind`, `defaultConfigFor`, `validateConfig` and
 * `checkGraphConnectivity`, plus Genie's own `decideFlowAdmission`. Nothing here
 * re-implements a graph.
 *
 * ## Two rules that are not conveniences
 *
 * **An agent may never ARM a flow, and may not RUN an unarmed one.** Arming
 * hands a flow standing permission to act unattended. An agent that could arm
 * its own flow would grant itself standing permission nobody agreed to, at 3am,
 * in a terminal nobody is watching — the exact shape of the thing arming exists
 * to gate.
 *
 * The second half matters just as much, and is easy to miss: a person may run a
 * DISARMED flow by hand, because they are present and the attendance IS the
 * consent. An agent is not present in that sense, so letting it run one would
 * put a door beside the gate — author a flow, ask nobody, run it whenever you
 * like. `disable` is allowed either way: the machine doing LESS needs no
 * permission, and refusing it would mean an agent that noticed its own flow
 * misbehaving could not stop it.
 *
 * **An agent may not give a flow machine-wide scope.** Widening from "this
 * workspace" to "everywhere" is the same escalation as arming, one step earlier.
 * A person can do it in the Flow Manager, where the confirmation says what it
 * means.
 *
 * ## `check` before `save` is the affordance
 *
 * A canvas shows refusals continuously as the author draws. An agent gets the
 * same feedback in a call: `check` judges a graph and stores nothing, and `save`
 * returns the refusals alongside the saved flow — because saving is not
 * authorising, and an author (human or not) is allowed to be mid-edit.
 */

import type Database from 'better-sqlite3';
import { getNodeKind, listNodeKinds } from '@particle-academy/fancy-flow/engine';
import { decideFlowAdmission, type FlowNodeRefusal } from './admission';
import { authorityForScope } from './authority';
import { genieNodeDefinitions } from './kinds';
import { starterFlowGraph } from './graph';
import {
    deleteFlowIn,
    getFlowIn,
    listFlowsVisibleToIn,
    setFlowEnabledIn,
    upsertFlowIn,
    type FlowRow,
} from './store';
import { parseFlowScope, type FlowScope } from './types';
import type { AppGrant } from '../apps/bridge-decision';

export interface ManageFlowsDeps {
    db: Database.Database;
    /** The workspace the CALLING agent acts in, or null when it has none. */
    workspaceId: () => string | null;
    loadGrant: (appId: string) => AppGrant | null;
    /** Start a flow by hand. Bound to the runner in production. */
    run: (flowId: string) => Promise<{ ok: boolean; error?: string }>;
}

export interface ManageFlowsResult {
    error?: string;
    flows?: { id: string; title: string; enabled: boolean; triggers: number }[];
    flow?: { id: string; title: string; enabled: boolean };
    nodes?: {
        kind: string;
        label: string;
        description?: string;
        config?: { key: string; label: string; type: string; required?: boolean }[];
    }[];
    allowed?: boolean;
    refusals?: FlowNodeRefusal[];
    capabilities?: string[];
    ok?: boolean;
}

/** The scope an agent's flows live in: its own workspace, and nothing wider. */
function agentScope(deps: ManageFlowsDeps): FlowScope | null {
    const ws = deps.workspaceId();
    return ws ? { kind: 'workspace', workspaceId: ws } : null;
}

/** The flow, if this agent may see it at all. */
function visible(deps: ManageFlowsDeps, flowId: string, scope: FlowScope): FlowRow | null {
    const rows = listFlowsVisibleToIn(deps.db, scope as never);
    return rows.find((f) => f.id === flowId) ?? null;
}

function summarise(flow: FlowRow) {
    return {
        id: flow.id,
        title: flow.title,
        enabled: flow.enabled,
        triggers: flow.graph && Array.isArray(flow.graph.nodes) ? flow.graph.nodes.length : 0,
    };
}

export async function handleManageFlows(
    raw: Record<string, unknown>,
    deps: ManageFlowsDeps,
): Promise<ManageFlowsResult> {
    const action = typeof raw.action === 'string' ? raw.action : '';
    const flowId = typeof raw.flowId === 'string' ? raw.flowId : '';

    const scope = agentScope(deps);
    if (!scope) {
        // Not "act machine-wide". An agent with no workspace has no place its
        // flows belong to, and the widest scope is never the safe default.
        return {
            error:
                'This agent is not attached to a workspace, so it has nowhere to keep a flow. ' +
                'Flows belong to a workspace, a Genie App, or the machine.',
        };
    }

    if (action === 'nodes') {
        return {
            nodes: [
                ...genieNodeDefinitions().map((d) => ({
                    kind: d.name,
                    label: d.label,
                    description: d.description,
                    config: d.configSchema.map((f) => ({
                        key: f.key,
                        label: f.label,
                        type: f.type,
                        ...(f.required ? { required: true } : {}),
                    })),
                })),
                // Fancy's own kit, so an agent can wire a decision without
                // being told the names out of band.
                ...listNodeKinds()
                    .filter((k) => k.name.startsWith('@particle-academy/'))
                    .map((k) => ({
                        kind: k.name,
                        label: k.label,
                        ...(k.description ? { description: k.description } : {}),
                    })),
            ],
        };
    }

    if (action === 'list') {
        return { flows: listFlowsVisibleToIn(deps.db, scope as never).map(summarise) };
    }

    if (action === 'check') {
        const target = parseFlowScope(raw.scope) ?? scope;
        const wide = refuseWideScope(target);
        if (wide) return { error: wide };
        const decision = decideFlowAdmission(
            raw.graph as never,
            authorityForScope(target, deps.loadGrant),
        );
        return {
            allowed: decision.allowed,
            refusals: decision.refusals,
            capabilities: decision.capabilities,
        };
    }

    if (action === 'save') {
        const target = parseFlowScope(raw.scope) ?? scope;
        const wide = refuseWideScope(target);
        if (wide) return { error: wide };

        if (flowId) {
            const existing = visible(deps, flowId, scope);
            if (!existing) {
                return { error: `This agent cannot see a flow called “${flowId}”.` };
            }
        }

        const id = flowId || `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const graph = raw.graph ?? starterFlowGraph();
        const existing = flowId ? getFlowIn(deps.db, flowId) : null;

        upsertFlowIn(deps.db, {
            id,
            scope: target,
            title:
                typeof raw.title === 'string' && raw.title.trim() !== ''
                    ? raw.title.trim()
                    : (existing?.title ?? 'New flow'),
            ...(typeof raw.purpose === 'string' ? { purpose: raw.purpose } : {}),
            ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
            graph,
            // NEVER from the payload. There is no path from here to armed.
            enabled: false,
        });

        // The refusals come back with the saved flow, because saving is not
        // authorising: an author may be mid-edit, and the reasons are what tell
        // them what is still wrong.
        const decision = decideFlowAdmission(
            graph as never,
            authorityForScope(target, deps.loadGrant),
        );
        const saved = getFlowIn(deps.db, id)!;
        return {
            flow: { id: saved.id, title: saved.title, enabled: saved.enabled },
            allowed: decision.allowed,
            refusals: decision.refusals,
            capabilities: decision.capabilities,
        };
    }

    if (action === 'enable') {
        return {
            error:
                'An agent cannot arm a flow. Arming gives it standing permission to act ' +
                'unattended, which is the user’s decision — ask them with ForceTheQuestion, ' +
                'or point them at the Flow Manager, where the switch says what the flow will do.',
        };
    }

    if (action === 'disable') {
        const flow = visible(deps, flowId, scope);
        if (!flow) return { error: `This agent cannot see a flow called “${flowId}”.` };
        setFlowEnabledIn(deps.db, flow.id, false);
        return { ok: true, flow: { id: flow.id, title: flow.title, enabled: false } };
    }

    if (action === 'run') {
        const flow = visible(deps, flowId, scope);
        if (!flow) return { error: `This agent cannot see a flow called “${flowId}”.` };

        // "By hand" means BY A HUMAN.
        //
        // A person may run a DISARMED flow — that is how one is tried before
        // arming it, and it is safe because they are present, and the
        // attendance IS the consent. An agent is not present in that sense. If
        // it could run a disarmed flow, the arming gate would have a door
        // beside it: author a flow, ask nobody, run it whenever you like.
        if (!flow.enabled) {
            return {
                error:
                    `“${flow.title}” is not turned on. An agent can only run a flow the user has ` +
                    `armed — ask them with ForceTheQuestion, or have them run it once themselves ` +
                    `from the Flow Manager, which is how a flow is tried before it is armed.`,
            };
        }

        const result = await deps.run(flow.id);
        return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
    }

    if (action === 'delete') {
        const flow = visible(deps, flowId, scope);
        if (!flow) return { error: `This agent cannot see a flow called “${flowId}”.` };
        deleteFlowIn(deps.db, flow.id);
        return { ok: true };
    }

    if (action === 'get') {
        const flow = visible(deps, flowId, scope);
        if (!flow) return { error: `This agent cannot see a flow called “${flowId}”.` };
        return { flow: { id: flow.id, title: flow.title, enabled: flow.enabled } };
    }

    return {
        error:
            `manageFlows needs an \`action\`: list | get | nodes | check | save | run | ` +
            `disable | delete. (\`enable\` exists and always refuses — see the tool description.)`,
    };
}

/** Machine-wide scope is a person's decision. See the header. */
function refuseWideScope(scope: FlowScope): string | null {
    if (scope.kind === 'system') {
        return (
            'An agent cannot give a flow the whole machine. Keep it in this workspace, or ask ' +
            'the user to widen it in the Flow Manager, where the confirmation says what that means.'
        );
    }
    return null;
}

/** Does this kind exist? For a caller checking a name before writing a node. */
export function flowNodeKindExists(kind: string): boolean {
    return getNodeKind(kind) !== null;
}
