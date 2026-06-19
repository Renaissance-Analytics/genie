import { describe, expect, it } from 'vitest';
import { computeOrphans } from '../orphans';

describe('computeOrphans', () => {
    it('flags live host terminals whose id has no spec', () => {
        const live = ['a', 'b', 'orphan1', 'orphan2'];
        const specs = ['a', 'b', 'c'];
        expect(computeOrphans(live, specs)).toEqual(['orphan1', 'orphan2']);
    });

    it('keeps every live terminal that still has a spec (detached ≠ orphan)', () => {
        const live = ['a', 'b'];
        // 'c' has a spec but isn't currently live — irrelevant; nothing reaped.
        expect(computeOrphans(live, ['a', 'b', 'c'])).toEqual([]);
    });

    it('reaps everything when there are no specs at all', () => {
        expect(computeOrphans(['x', 'y'], [])).toEqual(['x', 'y']);
    });

    it('returns nothing when the host has no live terminals', () => {
        expect(computeOrphans([], ['a', 'b'])).toEqual([]);
    });
});
