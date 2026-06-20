/**
 * Cross-workspace authorization for the agent-control MCP tools
 * (manageTerminals / runAgent / manageWorkspaces).
 *
 * SECURITY CORE. An agent's tool call arrives on its OWN workspace's endpoint
 * token (the per-workspace MCP URL). By default a tool acts on the caller's
 * workspace. An OPS agent may additionally target a workspace it GOVERNS (an Ops
 * project → its child/slave projects). It must NEVER be able to target an
 * arbitrary, unrelated workspace — that would let any agent spawn terminals /
 * run code / launch sub-agents anywhere on the machine.
 *
 * This module splits the decision into:
 *   - `decideTargetWorkspace(...)` — a PURE function over the already-resolved
 *     facts (caller id, requested target, the set of workspaces the caller
 *     governs). Unit-tested directly. It is the single chokepoint that says
 *     allowed/denied; the reason string is surfaced to the agent verbatim.
 *   - `resolveTargetWorkspace(...)` — the async wrapper that gathers those facts
 *     (the caller's governed-children set via the Ops slaves resolution, reusing
 *     the SAME path provisionWorkspaces uses) and calls the pure decision. Lives
 *     here so background.ts wires one function; the I/O is injected so it stays
 *     testable.
 */

export interface TargetDecision {
    /** True when the caller may act on the resolved workspace. */
    allowed: boolean;
    /** The workspace id the action should run against (only meaningful when allowed). */
    workspaceId: string;
    /** Human-readable reason, surfaced to the agent on denial (and for logs). */
    reason: string;
    /** How the target was authorized: the caller's own ws, or a governed child. */
    via: 'self' | 'governed' | 'denied';
}

/**
 * Decide whether `callerWorkspaceId` may act on `requestedWorkspaceId`.
 *
 *   - No requested id (or it equals the caller) → act on the caller's own
 *     workspace. Always allowed.
 *   - A different id → allowed ONLY if it's in `governedIds` (the set of child
 *     workspaces this caller's Ops project governs). Otherwise denied.
 *   - No caller workspace at all (an unattached terminal) → denied; there's no
 *     authority to act from.
 *
 * Pure: all the facts are passed in. `governedIds` is the set of workspace ids
 * the caller governs (already resolved + mapped to LOCAL workspace ids).
 */
export function decideTargetWorkspace(
    callerWorkspaceId: string | null,
    requestedWorkspaceId: string | undefined,
    governedIds: ReadonlySet<string>,
): TargetDecision {
    if (!callerWorkspaceId) {
        return {
            allowed: false,
            workspaceId: '',
            reason:
                'This terminal is not attached to a Genie workspace, so it has no authority to act on one.',
            via: 'denied',
        };
    }

    const requested = requestedWorkspaceId?.trim();
    if (!requested || requested === callerWorkspaceId) {
        return {
            allowed: true,
            workspaceId: callerWorkspaceId,
            reason: 'Acting on the caller’s own workspace.',
            via: 'self',
        };
    }

    if (governedIds.has(requested)) {
        return {
            allowed: true,
            workspaceId: requested,
            reason: 'Acting on a workspace this Ops project governs.',
            via: 'governed',
        };
    }

    return {
        allowed: false,
        workspaceId: '',
        reason:
            `Not allowed to target workspace "${requested}". An agent may act on its own ` +
            'workspace, or — for an Ops project — a workspace it governs. This workspace is neither.',
        via: 'denied',
    };
}

/** The facts the async resolver gathers to feed the pure decision. */
export interface TargetResolverDeps {
    /** The caller terminal → its workspace id (null when unattached). */
    callerWorkspaceId: string | null;
    /**
     * Resolve the set of LOCAL workspace ids the caller's workspace governs (Ops
     * → child projects mapped to their local workspaces). Returns an empty set
     * for a non-Ops caller, signed-out, or any failure — fail CLOSED (the pure
     * decision then denies any cross-workspace target). Reuses the same ops
     * slaves resolution provisionWorkspaces relies on.
     */
    governedWorkspaceIds: () => Promise<Set<string>>;
}

/**
 * Resolve + authorize a target workspace for a cross-workspace tool call. Only
 * computes the (potentially networked) governed set when a DIFFERENT workspace
 * is requested — the common "act on my own workspace" path needs no I/O.
 */
export async function resolveTargetWorkspace(
    requestedWorkspaceId: string | undefined,
    deps: TargetResolverDeps,
): Promise<TargetDecision> {
    const requested = requestedWorkspaceId?.trim();
    // Fast path: own workspace (or no/unattached caller) — no governance lookup.
    if (!requested || requested === deps.callerWorkspaceId || !deps.callerWorkspaceId) {
        return decideTargetWorkspace(deps.callerWorkspaceId, requested, new Set());
    }
    let governed = new Set<string>();
    try {
        governed = await deps.governedWorkspaceIds();
    } catch {
        governed = new Set(); // fail closed
    }
    return decideTargetWorkspace(deps.callerWorkspaceId, requested, governed);
}
