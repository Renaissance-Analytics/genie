import { randomUUID } from 'node:crypto';
import { makePlan, type Plan } from './deploy-plan.js';

/**
 * DEPLOYMENT: APPROVALS (Tynn #871; spec .ai/plans/specs/deployment.md §4.3, §4.5).
 *
 * An approval applies to EXACTLY the plan it was given for:
 * - bound to the plan hash and the account. Apply re-plans first; a different hash (the live state moved, a step changed)
 *   or a different account is refused, and a new approval is needed;
 * - expires 1 h after it was given, unused;
 * - used once;
 * - given only by the person. An agent can never approve a plan, its own or another's (§6).
 *
 * DATA DESTROYS need the resource's name typed, exactly, as well as Approve: a database, cache or bucket goes with its data.
 *
 * The hash is RECOMPUTED from the plan handed to `consume`, never read off it, so a plan object carrying an old hash over
 * new steps cannot pass.
 */

export const APPROVAL_TTL_MS = 60 * 60 * 1000;

const DATA_KINDS: ReadonlySet<string> = new Set(['database', 'cache', 'bucket']);

export type Approver = { readonly kind: 'person' } | { readonly kind: 'agent'; readonly name: string; readonly workspace: string };
export type Granted = { readonly ok: true; readonly approvalId: string } | { readonly ok: false; readonly reason: string };
export type Consumed = { readonly ok: true } | { readonly ok: false; readonly reason: string };

interface Held {
    readonly planHash: string;
    readonly accountId: string;
    readonly at: number;
    used: boolean;
}

/** The names a person must type to approve this plan: one per data resource it destroys. */
export function typedNamesNeeded(plan: Plan): string[] {
    return plan.steps.filter((step) => step.kind === 'destroy' && DATA_KINDS.has(step.resource.kind)).map((step) => step.resource.name);
}

export class ApprovalBook {
    readonly #now: () => number;
    readonly #held = new Map<string, Held>();

    constructor(now: () => number = Date.now) {
        this.#now = now;
    }

    grant(plan: Plan, by: Approver, typed: readonly string[] = []): Granted {
        if (by.kind !== 'person') return { ok: false, reason: 'Only the person approves a deployment plan; an agent cannot approve one, its own or another\'s.' };
        const missing = typedNamesNeeded(plan).filter((name) => !typed.includes(name));
        if (missing.length > 0) return { ok: false, reason: `To approve, type the name of each data resource this plan destroys: ${missing.join(', ')}.` };
        const approvalId = randomUUID();
        this.#held.set(approvalId, { planHash: makePlan(plan).hash, accountId: plan.target.accountId, at: this.#now(), used: false });
        return { ok: true, approvalId };
    }

    consume(approvalId: string, plan: Plan): Consumed {
        const held = this.#held.get(approvalId);
        if (!held) return { ok: false, reason: 'There is no such approval.' };
        if (held.used) return { ok: false, reason: 'This approval was already used; a new apply needs a new approval.' };
        if (this.#now() - held.at > APPROVAL_TTL_MS) {
            this.#held.delete(approvalId);
            return { ok: false, reason: 'This approval expired (an approval lasts 1 hour unused); the plan needs a new approval.' };
        }
        if (held.accountId !== plan.target.accountId) return { ok: false, reason: 'This approval was given for a different cloud account.' };
        if (held.planHash !== makePlan(plan).hash) return { ok: false, reason: 'The plan changed since it was approved (its hash differs), so it needs a new approval.' };
        held.used = true;
        return { ok: true };
    }
}
