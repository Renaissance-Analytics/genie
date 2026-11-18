import { describe, expect, it } from 'vitest';
import { approvalClass, canonicalJson, makePlan, type DeployTarget, type PlanInput } from '../src/main/deploy-plan.js';

/**
 * DEPLOYMENT D0-1 (Tynn #871; spec .ai/plans/specs/deployment.md §4, decision D3). A plan is what Genie WOULD do to a
 * cloud account, made from reads only. Its hash binds an approval to exactly that plan AND the live state it was made
 * against: if either changes, the hash changes and the approval no longer applies.
 *
 * Approval classes: free (read/plan), approval (creates, destroys, or can change the bill, and the first deploy to a new
 * target), alone (D3: redeploy or roll back an already-approved target at a $0 cost delta, unless it is "always ask").
 */

const target = (over: Partial<DeployTarget> = {}): DeployTarget => ({
    id: 'tgt-1',
    accountId: 'acc-do-1',
    provider: 'digitalocean',
    firstDeployApproved: true,
    alwaysAsk: false,
    adopted: false,
    managed: true,
    ...over,
});

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
    target: target(),
    steps: [{ kind: 'deploy', resource: { kind: 'app', name: 'shop' }, detail: 'commit abc1234' }],
    live: { app: { id: 'a-1', activeDeployment: 'd-9', commit: 'fff0000' } },
    monthlyDeltaCents: 0,
    ...over,
});

describe('the plan hash', () => {
    it('changes when the live state the plan was made against changes', () => {
        const a = makePlan(input());
        const b = makePlan(input({ live: { app: { id: 'a-1', activeDeployment: 'd-10', commit: 'fff0000' } } }));
        expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(b.hash).not.toBe(a.hash);
    });

    it('changes when a step, the account or the cost delta changes', () => {
        const base = makePlan(input()).hash;
        expect(makePlan(input({ steps: [{ kind: 'deploy', resource: { kind: 'app', name: 'shop' }, detail: 'commit abc1235' }] })).hash).not.toBe(base);
        expect(makePlan(input({ target: target({ accountId: 'acc-do-2' }) })).hash).not.toBe(base);
        expect(makePlan(input({ monthlyDeltaCents: 500 })).hash).not.toBe(base);
    });

    it('does not depend on key order (the same plan read twice hashes the same)', () => {
        const a = makePlan(input({ live: { app: { id: 'a-1', activeDeployment: 'd-9', commit: 'fff0000' } } }));
        const b = makePlan(input({ live: { app: { commit: 'fff0000', activeDeployment: 'd-9', id: 'a-1' } } }));
        expect(b.hash).toBe(a.hash);
        expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    });
});

describe('approval classes (D3)', () => {
    it('a plan with no steps (a read, a plan) is free', () => {
        expect(approvalClass(makePlan(input({ steps: [] }))).cls).toBe('free');
    });

    it('a create step needs approval', () => {
        const plan = makePlan(input({ steps: [{ kind: 'create', resource: { kind: 'database', name: 'shop-db' } }], monthlyDeltaCents: 1500 }));
        expect(approvalClass(plan).cls).toBe('approval');
    });

    it('a destroy, a set-budget, an update and a set-env each need approval, even at $0', () => {
        for (const kind of ['destroy', 'set-budget', 'update', 'set-env'] as const) {
            const plan = makePlan(input({ steps: [{ kind, resource: { kind: 'app', name: 'shop' } }], monthlyDeltaCents: 0 }));
            expect(approvalClass(plan).cls, kind).toBe('approval');
        }
    });

    it('a $0-delta redeploy or rollback of an already-approved target runs alone', () => {
        expect(approvalClass(makePlan(input())).cls).toBe('alone');
        const rollback = makePlan(input({ steps: [{ kind: 'rollback', resource: { kind: 'app', name: 'shop' }, detail: 'to d-8' }] }));
        expect(approvalClass(rollback).cls).toBe('alone');
    });

    it('the same redeploy on an "always ask" target needs approval', () => {
        expect(approvalClass(makePlan(input({ target: target({ alwaysAsk: true }) }))).cls).toBe('approval');
    });

    it('the first deploy to a new target needs approval', () => {
        expect(approvalClass(makePlan(input({ target: target({ firstDeployApproved: false }) }))).cls).toBe('approval');
    });

    it('a redeploy whose cost delta is not $0, or unknown, needs approval', () => {
        expect(approvalClass(makePlan(input({ monthlyDeltaCents: 1 }))).cls).toBe('approval');
        expect(approvalClass(makePlan(input({ monthlyDeltaCents: null }))).cls).toBe('approval');
    });

    it('any change to an adopted target Genie has not been allowed to manage is refused, in words', () => {
        const verdict = approvalClass(makePlan(input({ target: target({ adopted: true, managed: false }) })));
        expect(verdict.cls).toBe('refused');
        expect(verdict.why).toMatch(/read-only/i);
        expect(approvalClass(makePlan(input({ target: target({ adopted: true, managed: false }), steps: [] }))).cls).toBe('free');
    });
});
