import type { Plan } from './deploy-plan.js';

/** DEPLOYMENT: APPROVALS (Tynn #871; spec §4.3, §4.5). RED stub: types only. */

export const APPROVAL_TTL_MS = 0;

export type Approver = { readonly kind: 'person' } | { readonly kind: 'agent'; readonly name: string; readonly workspace: string };
export type Granted = { readonly ok: true; readonly approvalId: string } | { readonly ok: false; readonly reason: string };
export type Consumed = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export class ApprovalBook {
    constructor(_now: () => number = Date.now) {}

    grant(_plan: Plan, _by: Approver, _typed: readonly string[] = []): Granted {
        throw new Error('not built yet (#871 RED)');
    }

    consume(_approvalId: string, _plan: Plan): Consumed {
        throw new Error('not built yet (#871 RED)');
    }
}
