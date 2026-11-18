import { describe, expect, it } from 'vitest';
import { ApprovalBook, APPROVAL_TTL_MS } from '../src/main/deploy-approval.js';
import { makePlan, type PlanInput } from '../src/main/deploy-plan.js';

/**
 * DEPLOYMENT D0-1 (Tynn #871; spec §4.3, §4.5). An approval is bound to the plan hash AND the account, expires 1 h after
 * it is given, is used once, and only a person gives it. Destroying data (a database, cache or bucket) needs the
 * resource's name typed as well as Approve.
 */

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
    target: { id: 'tgt-1', accountId: 'acc-1', provider: 'laravel-cloud', firstDeployApproved: false, alwaysAsk: false, adopted: false, managed: true },
    steps: [{ kind: 'create', resource: { kind: 'app', name: 'shop' } }],
    live: {},
    monthlyDeltaCents: 2000,
    ...over,
});
const person = { kind: 'person' } as const;

function book(start = 1_000_000) {
    let now = start;
    const b = new ApprovalBook(() => now);
    return { b, advance: (ms: number) => { now += ms; } };
}

describe('an approval applies to exactly the plan it was given for', () => {
    it('positive control: the approved plan, same account, within the hour, is accepted once', () => {
        const { b } = book();
        const plan = makePlan(input());
        const granted = b.grant(plan, person);
        expect(granted.ok).toBe(true);
        if (!granted.ok) return;
        expect(b.consume(granted.approvalId, plan)).toEqual({ ok: true });
    });

    it('is refused for a different plan hash (the live state changed before apply)', () => {
        const { b } = book();
        const granted = b.grant(makePlan(input()), person);
        if (!granted.ok) throw new Error('grant failed');
        const replanned = makePlan(input({ live: { app: { id: 'new' } } }));
        const used = b.consume(granted.approvalId, replanned);
        expect(used.ok).toBe(false);
        if (!used.ok) expect(used.reason).toMatch(/changed|hash/i);
    });

    it('is refused for a different account', () => {
        const { b } = book();
        const plan = makePlan(input());
        const granted = b.grant(plan, person);
        if (!granted.ok) throw new Error('grant failed');
        const other = makePlan(input({ target: { ...input().target, accountId: 'acc-2' } }));
        expect(b.consume(granted.approvalId, other).ok).toBe(false);
    });

    it('expires one hour after it was given', () => {
        expect(APPROVAL_TTL_MS).toBe(60 * 60 * 1000);
        const { b, advance } = book();
        const plan = makePlan(input());
        const granted = b.grant(plan, person);
        if (!granted.ok) throw new Error('grant failed');
        advance(APPROVAL_TTL_MS + 1);
        const used = b.consume(granted.approvalId, plan);
        expect(used.ok).toBe(false);
        if (!used.ok) expect(used.reason).toMatch(/expired/i);
    });

    it('is used once: a second apply with the same approval is refused', () => {
        const { b } = book();
        const plan = makePlan(input());
        const granted = b.grant(plan, person);
        if (!granted.ok) throw new Error('grant failed');
        expect(b.consume(granted.approvalId, plan).ok).toBe(true);
        expect(b.consume(granted.approvalId, plan).ok).toBe(false);
    });

    it('an unknown approval id is refused', () => {
        const { b } = book();
        expect(b.consume('nope', makePlan(input())).ok).toBe(false);
    });
});

describe('who may approve, and what must be typed', () => {
    it('an agent can never approve a plan', () => {
        const { b } = book();
        const granted = b.grant(makePlan(input()), { kind: 'agent', name: 'worker', workspace: 'shop' });
        expect(granted.ok).toBe(false);
        if (!granted.ok) expect(granted.reason).toMatch(/person/i);
    });

    it('destroying a database without its typed name is refused; with it, accepted', () => {
        const destroy = makePlan(input({ steps: [{ kind: 'destroy', resource: { kind: 'database', name: 'shop-db' } }], monthlyDeltaCents: -1500 }));
        const { b } = book();
        const without = b.grant(destroy, person);
        expect(without.ok).toBe(false);
        if (!without.ok) expect(without.reason).toContain('shop-db');
        expect(b.grant(destroy, person, ['shop-DB']).ok).toBe(false);
        expect(b.grant(destroy, person, ['shop-db']).ok).toBe(true);
    });

    it('caches and buckets are data too; an app destroy needs no typed name', () => {
        const { b } = book();
        for (const kind of ['cache', 'bucket'] as const) {
            expect(b.grant(makePlan(input({ steps: [{ kind: 'destroy', resource: { kind, name: `x-${kind}` } }] })), person).ok, kind).toBe(false);
        }
        expect(b.grant(makePlan(input({ steps: [{ kind: 'destroy', resource: { kind: 'app', name: 'shop' } }] })), person).ok).toBe(true);
    });
});
