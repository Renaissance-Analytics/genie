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

    it('SAFETY: refuses to reap when there are no specs at all (load race)', () => {
        // Empty spec set + live terminals → the DB likely hasn't loaded; never
        // treat that as "everything is orphaned".
        expect(computeOrphans(['x', 'y'], [])).toEqual([]);
    });

    it('SAFETY: refuses to reap when EVERY live terminal looks orphaned (id mismatch)', () => {
        // None of the live ids match a spec → the id namespaces don't line up
        // (the bug that wiped real terminals on reopen). Bail, don't nuke them.
        expect(computeOrphans(['x', 'y'], ['a', 'b', 'c'])).toEqual([]);
    });

    it('still reaps a partial orphan set (some live ids DO match specs)', () => {
        // Overlap proves the matching + spec load work, so the unmatched id is a
        // genuine orphan.
        expect(computeOrphans(['a', 'b', 'gone'], ['a', 'b'])).toEqual(['gone']);
    });

    it('returns nothing when the host has no live terminals', () => {
        expect(computeOrphans([], ['a', 'b'])).toEqual([]);
    });
});
