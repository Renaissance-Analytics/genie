/**
 * Mid-turn tool approval — `session/request_permission`.
 *
 * The hazard is **granting more than the human chose.** The agent supplies the options,
 * inventing their ids and deciding their order, so:
 *
 * - picking one by POSITION is a coin flip that silently reverses a decision when the
 *   agent reorders them;
 * - falling back from "allow once" to "allow always" because the first is not on offer
 *   hands over a standing permission nobody gave, and reads as a plain success.
 *
 * So selection is by KIND, and a kind that is not offered is a **refusal** rather than a
 * substitution. Refusing is safe: the protocol's `cancelled` outcome is a legitimate
 * answer that ends the agent's wait, where a wrong grant is not recoverable.
 */

import type { PendingApproval } from '../agentsession/model';

/** What the human decided. Deliberately four, matching the protocol's four kinds, so
 *  nothing has to be inferred at the boundary. */
export type PermissionDecision = 'allow-once' | 'allow-always' | 'deny-once' | 'deny-always';

/** The protocol's option kinds. */
export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface PermissionOption {
    optionId: string;
    name: string;
    kind: PermissionOptionKind;
}

export interface RequestPermissionParams {
    sessionId: string;
    toolCall?: { toolCallId?: string; title?: string; kind?: string };
    options: readonly PermissionOption[];
}

export type PermissionResponse =
    | { outcome: { outcome: 'selected'; optionId: string } }
    | { outcome: { outcome: 'cancelled' } };

const KIND_FOR: Record<PermissionDecision, PermissionOptionKind> = {
    'allow-once': 'allow_once',
    'allow-always': 'allow_always',
    'deny-once': 'reject_once',
    'deny-always': 'reject_always',
};

const KNOWN_KINDS = new Set<string>(['allow_once', 'allow_always', 'reject_once', 'reject_always']);

/** Turn the request into something a human can answer. */
export function approvalFromRequest(params: RequestPermissionParams): PendingApproval {
    const id = params.toolCall?.toolCallId ?? `permission:${params.sessionId}`;
    return {
        id,
        // A row reading "approve?" with no subject is unanswerable; the id is a poor
        // name but it is at least a handle.
        name: params.toolCall?.title?.trim() || id,
        args: params.toolCall?.kind ? { kind: params.toolCall.kind } : {},
    };
}

/**
 * The response for a decision.
 *
 * Matched on kind, and **never substituted**. If the agent did not offer the kind the
 * human chose, this cancels — because the two possible substitutions are both wrong in
 * the direction that matters: upgrading an allow grants a standing permission nobody
 * gave, and downgrading a refusal lets the same thing be asked again immediately.
 */
export function permissionOutcome(
    decision: PermissionDecision,
    options: readonly PermissionOption[],
): PermissionResponse {
    const wanted = KIND_FOR[decision];
    // An unrecognised kind is ignored rather than matched loosely: a protocol version
    // that adds one must not have it chosen by accident.
    const match = options.find((o) => KNOWN_KINDS.has(o.kind) && o.kind === wanted);
    if (!match) return cancelledOutcome();
    return { outcome: { outcome: 'selected', optionId: match.optionId } };
}

/**
 * The answer the protocol REQUIRES for a permission still pending when a turn is
 * cancelled: *"When a client sends a `session/cancel` notification … it MUST respond to
 * all pending `session/request_permission` requests with cancelled."*
 *
 * It is also the right answer whenever we cannot honour a decision exactly, because an
 * unanswered request parks the agent's turn forever.
 */
export function cancelledOutcome(): PermissionResponse {
    return { outcome: { outcome: 'cancelled' } };
}
