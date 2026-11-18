import { createHash } from 'node:crypto';

/**
 * DEPLOYMENT: THE PLAN (Tynn #871; spec .ai/plans/specs/deployment.md §4, decision D3).
 *
 * Every change Genie makes to a cloud account is a Plan first: a pure, serialisable object made from READS only (the
 * provider's dry-run where it has one, otherwise Genie's diff against live GETs). Planning is always allowed.
 *
 * THE HASH BINDS AN APPROVAL TO WHAT WAS SEEN. It covers the target (and so the account), the ordered steps, the cost delta
 * AND the live state the plan was made against. If anything at the provider moves between Approve and apply, re-planning
 * gives a different hash and the approval no longer applies (deploy-approval.ts). Key order never matters: the same state
 * read twice hashes the same.
 *
 * APPROVAL CLASSES (D3, approved 2026-11-18):
 * - free: no steps (a read, a plan).
 * - approval: anything that creates, destroys, or can change the bill or the app's config (create, update, destroy, set-env,
 *   set-budget), the first deploy to a new target, any deploy on an "always ask" target, and any deploy or rollback whose
 *   cost delta is not exactly $0, including an unknown one.
 * - alone: a redeploy or rollback of an already-approved target at a $0 delta. An agent may do that without the person.
 * - refused: any change to an ADOPTED target Genie has not been allowed to manage. Adopted = read-only (§4.5).
 */

export type CloudProvider = 'laravel-cloud' | 'digitalocean' | 'vercel' | 'azure' | 'aws' | 'render' | 'linode';
export type StepKind = 'create' | 'update' | 'destroy' | 'deploy' | 'rollback' | 'set-env' | 'set-budget';
export type ResourceKind = 'app' | 'environment' | 'service' | 'database' | 'cache' | 'bucket' | 'domain' | 'queue' | 'budget';

export interface PlanStep {
    readonly kind: StepKind;
    readonly resource: { readonly kind: ResourceKind; readonly name: string; readonly providerId?: string };
    readonly detail?: string;
}

/** One (repo, branch, provider account, provider environment) Genie manages, as far as approval needs it. */
export interface DeployTarget {
    readonly id: string;
    readonly accountId: string;
    readonly provider: CloudProvider;
    /** The person has approved a deploy to this target before: it is no longer new. */
    readonly firstDeployApproved: boolean;
    /** Production targets can be marked so: every deploy asks, even at $0. */
    readonly alwaysAsk: boolean;
    /** Found at the provider, not created by Genie. */
    readonly adopted: boolean;
    /** The person flipped "Genie may manage this" (itself an approval item). Always true for a target Genie created. */
    readonly managed: boolean;
}

export interface PlanInput {
    readonly target: DeployTarget;
    readonly steps: readonly PlanStep[];
    /** The live state the plan was made against, as read from the provider. */
    readonly live: unknown;
    /** The plan's change to the monthly bill, in cents; null when Genie cannot price it ("unknown", never $0). */
    readonly monthlyDeltaCents: number | null;
}

export interface Plan extends PlanInput {
    readonly hash: string;
}

export type ApprovalClass = 'free' | 'approval' | 'alone' | 'refused';

/** Steps that create, destroy, or can change the bill or the app's config: these always wait for the person. */
const ALWAYS_ASK: ReadonlySet<StepKind> = new Set(['create', 'update', 'destroy', 'set-env', 'set-budget']);

function sorted(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sorted);
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort()) {
            const item = (value as Record<string, unknown>)[key];
            if (item !== undefined) out[key] = sorted(item);
        }
        return out;
    }
    return value;
}

/** JSON with every object's keys sorted, so equal values always give equal text. */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(sorted(value)) ?? 'null';
}

export function sha256Hex(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The hash of exactly what the plan would do, to which account, against which live state. */
export function planHash(input: PlanInput): string {
    const { target, steps, live, monthlyDeltaCents } = input;
    return sha256Hex(canonicalJson({ v: 1, target, steps, live, monthlyDeltaCents }));
}

export function makePlan(input: PlanInput): Plan {
    const { target, steps, live, monthlyDeltaCents } = input;
    return { target, steps, live, monthlyDeltaCents, hash: planHash(input) };
}

const describeStep = (step: PlanStep): string => `${step.kind} ${step.resource.kind} ${step.resource.name}`;

export function approvalClass(plan: Plan): { readonly cls: ApprovalClass; readonly why: string } {
    if (plan.steps.length === 0) return { cls: 'free', why: 'It only reads.' };
    const { target } = plan;
    if (target.adopted && !target.managed) {
        return { cls: 'refused', why: 'This target was adopted read-only: Genie may not change it until the person lets Genie manage it.' };
    }
    const asking = plan.steps.find((step) => ALWAYS_ASK.has(step.kind));
    if (asking) return { cls: 'approval', why: `It would ${describeStep(asking)}.` };
    // Only deploys and rollbacks are left.
    if (!target.firstDeployApproved) return { cls: 'approval', why: 'It is the first deploy to a new target.' };
    if (target.alwaysAsk) return { cls: 'approval', why: 'This target is set to always ask.' };
    if (plan.monthlyDeltaCents === null) return { cls: 'approval', why: 'Its cost change is unknown.' };
    if (plan.monthlyDeltaCents !== 0) return { cls: 'approval', why: 'It changes the monthly bill.' };
    return { cls: 'alone', why: 'A redeploy or rollback of an approved target at no change in cost.' };
}
