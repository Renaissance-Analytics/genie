/**
 * DEPLOYMENT: THE PLAN (Tynn #871; spec .ai/plans/specs/deployment.md §4, decision D3). RED stub: types only.
 */

export type CloudProvider = 'laravel-cloud' | 'digitalocean' | 'vercel' | 'azure' | 'aws' | 'render' | 'linode';
export type StepKind = 'create' | 'update' | 'destroy' | 'deploy' | 'rollback' | 'set-env' | 'set-budget';
export type ResourceKind = 'app' | 'environment' | 'service' | 'database' | 'cache' | 'bucket' | 'domain' | 'queue' | 'budget';

export interface PlanStep {
    readonly kind: StepKind;
    readonly resource: { readonly kind: ResourceKind; readonly name: string; readonly providerId?: string };
    readonly detail?: string;
}

export interface DeployTarget {
    readonly id: string;
    readonly accountId: string;
    readonly provider: CloudProvider;
    readonly firstDeployApproved: boolean;
    readonly alwaysAsk: boolean;
    readonly adopted: boolean;
    readonly managed: boolean;
}

export interface PlanInput {
    readonly target: DeployTarget;
    readonly steps: readonly PlanStep[];
    readonly live: unknown;
    readonly monthlyDeltaCents: number | null;
}

export interface Plan extends PlanInput {
    readonly hash: string;
}

export type ApprovalClass = 'free' | 'approval' | 'alone' | 'refused';

export function canonicalJson(_value: unknown): string {
    throw new Error('not built yet (#871 RED)');
}

export function makePlan(_input: PlanInput): Plan {
    throw new Error('not built yet (#871 RED)');
}

export function approvalClass(_plan: Plan): { readonly cls: ApprovalClass; readonly why: string } {
    throw new Error('not built yet (#871 RED)');
}
