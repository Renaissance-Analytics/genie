/**
 * PURE. May this app run this graph — decided before the first node executes.
 *
 * A flow graph is inert JSON, and every effectful step names its tool
 * STRUCTURALLY rather than deciding it at run time. That is the property an agent
 * transcript never has, and it means a whole flow can be judged up front.
 *
 * Worth doing for one blunt reason: refusing at node 7, after six irreversible
 * side effects have already happened, is a strictly worse answer than refusing at
 * node 0. Admission also lets a consent-shaped surface say what a flow WILL do
 * before anyone agrees to it.
 *
 * ## This is not the enforcement
 *
 * `dispatchAppCall` in the executor is. It stays for an admitted graph, because a
 * graph can be edited between admission and run, and because defence that only
 * happens once is defence that eventually gets skipped. Admission is fail-fast
 * and an honest explanation; the bridge is the lock.
 *
 * ## Every refusal is `decideAppCall`'s
 *
 * Nothing here invents an authority rule. Each Genie node is put to the same gate
 * a GApp window's call goes through, so a flow cannot become a second, laxer path
 * to the same tools. If that gate changes, flows change with it.
 *
 * ## It reads UNTRUSTED shape
 *
 * `importWorkflow` coerces garbage into an empty graph rather than rejecting it
 * (verified — see the research note), so nothing upstream is validating this. A
 * stored graph may be hand-edited, migrated, or corrupt. Every read here is
 * therefore defensive, and anything unreadable is refused rather than guessed at.
 */

import { decideAppCall, type AppGrant } from '../bridge-decision';
import { GENIE_NODE_PREFIX, toolForNodeKind } from './nodes';

/**
 * The minimum Genie needs to read off a node.
 *
 * Deliberately structural and all-optional rather than fancy-flow's `FlowNode`:
 * this runs on input that may not be a graph at all, and a type asserting more
 * than the data guarantees would be a lie the compiler helps tell.
 */
export interface FlowNodeLike {
    id?: unknown;
    type?: unknown;
    data?: { kind?: unknown; label?: unknown; config?: unknown } | null;
}

export interface FlowGraphLike {
    nodes?: readonly FlowNodeLike[];
    edges?: unknown;
}

export interface FlowNodeRefusal {
    nodeId: string;
    /** The node's label, when it had one — an author navigates by name, not id. */
    label?: string;
    /** Why, in words the user could act on. Verbatim from `decideAppCall`. */
    reason: string;
}

export interface FlowAdmission {
    allowed: boolean;
    /** Capabilities this graph actually uses — deduped, for a run summary. */
    capabilities: string[];
    /** Every node that cannot run. Empty when the refusal is graph-wide. */
    refusals: FlowNodeRefusal[];
    /** Set when the whole graph is refused for a reason no single node caused. */
    reason?: string;
}

function refuseGraph(reason: string): FlowAdmission {
    return { allowed: false, capabilities: [], refusals: [], reason };
}

function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

/**
 * The workspace a node targets.
 *
 * Three outcomes, and the third is the interesting one:
 *   - absent      → the app's own workspace (`decideAppCall`'s default)
 *   - a string    → that workspace, subject to the app's scope
 *   - anything else → UNREADABLE, and refused rather than defaulted. A target
 *     nobody can read is not a target anybody should act on; silently treating it
 *     as "the app's own" would turn a corrupt field into a successful write.
 */
function targetWorkspace(config: unknown): string | null | 'unreadable' {
    if (config === null || config === undefined) return null;
    if (typeof config !== 'object') return 'unreadable';
    const raw = (config as { workspaceId?: unknown }).workspaceId;
    if (raw === undefined || raw === null) return null;
    return typeof raw === 'string' ? raw : 'unreadable';
}

export function decideFlowAdmission(
    graph: FlowGraphLike | null | undefined,
    grant: AppGrant | null | undefined,
): FlowAdmission {
    if (!grant) {
        return refuseGraph('This app has no permission grant, so it cannot run a flow.');
    }
    if (grant.revoked) {
        // Checked before any node, because revocation is total. A stored flow is
        // exactly the thing that would otherwise keep running after "stop".
        return refuseGraph(
            `“${grant.appName}” has been revoked — its permissions were turned off, so none of its flows will run.`,
        );
    }

    const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : null;
    if (!nodes) {
        return refuseGraph('This flow could not be read as a graph, so it will not be run.');
    }
    if (nodes.length === 0) {
        // Not "trivially allowed". An empty graph is almost always a failed load
        // or a bad edit, and reporting success for it would hide both.
        return refuseGraph('This flow has no steps.');
    }

    const refusals: FlowNodeRefusal[] = [];
    const capabilities = new Set<string>();

    for (const raw of nodes) {
        if (!raw || typeof raw !== 'object') continue;

        const kind = asString(raw.data?.kind);
        // Not a Genie node: a Fancy builtin, an annotation, or unreadable. None of
        // them can reach Genie, so none of them is admission's business.
        if (!kind) continue;
        const tool = toolForNodeKind(kind);
        const nodeId = asString(raw.id) ?? '';
        const label = asString(raw.data?.label);

        if (!tool) {
            // The distinction that earns its keep. A kind OUTSIDE Genie's
            // namespace is simply somebody else's node. A kind INSIDE it that
            // resolves to nothing is a broken graph — a typo, a tool that was
            // removed, or a hand-written `genie.submitFeedback` hoping the
            // executor trusts the string.
            //
            // Either way it would fail closed at run time, but only AFTER
            // everything upstream had already run. That is the exact outcome
            // admission exists to prevent, so it is refused here instead.
            if (!kind.startsWith(GENIE_NODE_PREFIX)) continue;
            refusals.push({
                nodeId,
                ...(label ? { label } : {}),
                reason: `“${kind}” is not a Genie step. It may be misspelt, or name something no app may use.`,
            });
            continue;
        }

        const target = targetWorkspace(raw.data?.config);

        if (target === 'unreadable') {
            refusals.push({
                nodeId,
                ...(label ? { label } : {}),
                reason: 'This step names a workspace Genie could not read, so it will not run.',
            });
            continue;
        }

        const decision = decideAppCall(
            { tool, ...(target ? { workspaceId: target } : {}) },
            grant,
        );
        if (!decision.allowed) {
            refusals.push({
                nodeId,
                ...(label ? { label } : {}),
                reason: decision.reason ?? 'This step is not permitted.',
            });
            continue;
        }
        if (decision.capability) capabilities.add(decision.capability);
    }

    return {
        allowed: refusals.length === 0,
        capabilities: [...capabilities].sort(),
        refusals,
    };
}
