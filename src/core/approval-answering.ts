import type { Approval } from './approval.js';

/**
 * AN ANSWER IN FLIGHT — which agent's, for which approval, and how it ended.
 *
 * ## Why this is per approval and not a window-wide flag
 *
 * The desktop window kept one `answering: string | null`, set on every answer path and cleared by nothing (its own
 * comment promised "cleared when the agent's detail changes"; no code did it). So the FIRST approval answered in a
 * window disabled the buttons of every approval after it, for the life of the window — the owner, 2026-10-22,
 * blocked: "I have agents trying to do work and ask for approval from me but I can't approve anything because the
 * UI is disabled". A Codex card with Allow once / Allow and remember / Reject all grey, and the ledger closing the
 * request as `cancelled`: never answered.
 *
 * So the flight names the agent AND the approval (`key`). A surface asks `answeringFor(…)` with the approval it is
 * showing: only THAT approval's buttons refuse a second press — the provider is blocked on one promise, and a second
 * answer to it would resolve nothing — while any other approval, of this agent or another, is live.
 *
 * ## It ends on the host's reply
 *
 * `answerApproval` answers (`ok`, the session resolved the provider's request) or refuses (`ok: false` — nothing
 * parked, an option the request never offered, the agent not running). Either way the flight is over. A refusal is
 * SAID, on the card, in words (the owner, 2026-10-14: "I click the answer button but nothing happens" — a refusal
 * that only reached the console was nothing happening). Clearing on a timer would guess at when the host replied.
 */
export interface ApprovalAnswering {
    agentId: string;
    /** `approvalKey` of the approval answered — a Deck row, which has no approval to compare, keys on the agent alone. */
    key: string;
    optionId: string;
}

export interface ApprovalRefusal {
    agentId: string;
    key: string;
    /** `refusalWords`: a sentence, never the host's bare `false`. */
    reason: string;
}

/** A Deck row answers an agent's parked approval without holding it; a session parks one at a time, so the agent is the identity. */
export const AGENT_ONLY_KEY = '';

/**
 * An approval's identity: the provider's own tool-call id when it gave one, else what it asked — the tool, the
 * question and the command. The options are not part of it (the same call asked again is the same identity; the flight
 * ends on the host's reply, not on this).
 */
export function approvalKey(approval: Pick<Approval, 'question' | 'tool' | 'toolCallId' | 'command'> | null): string {
    if (approval === null) return AGENT_ONLY_KEY;
    if (approval.toolCallId) return `call:${approval.toolCallId}`;
    return `ask:${approval.tool ?? ''}\u0000${approval.question}\u0000${approval.command ?? ''}`;
}

function belongs(to: { agentId: string; key: string } | null, agentId: string, approval: Approval | null): boolean {
    if (to === null || to.agentId !== agentId) return false;
    // A Deck row shows no approval to compare: the agent alone decides. A flight begun from a Deck row carries the
    // agent-only key and holds the agent's one parked approval wherever it is shown.
    if (approval === null || to.key === AGENT_ONLY_KEY) return true;
    return to.key === approvalKey(approval);
}

/** The option id in flight for THIS agent's THIS approval, else `null` — the card's `answering`. */
export function answeringFor(inFlight: ApprovalAnswering | null, agentId: string, approval: Approval | null): string | null {
    return belongs(inFlight, agentId, approval) ? inFlight!.optionId : null;
}

/** The host's refusal of THIS agent's THIS approval, in words, else `null`. */
export function refusalFor(refusal: ApprovalRefusal | null, agentId: string, approval: Approval | null): string | null {
    return belongs(refusal, agentId, approval) ? refusal!.reason : null;
}

/** The host's refusal as a sentence for the card. A host that gave no reason still gets one; an empty line is "nothing happened". */
export function refusalWords(result: { ok: false; reason?: string | undefined }): string {
    const reason = result.reason?.trim();
    return `Not answered: ${reason || 'Genie could not deliver that answer — the agent may have stopped, or the question was already answered'}`;
}
