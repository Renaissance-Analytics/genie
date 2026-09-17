import { describe, expect, it } from 'vitest';
import {
    activeAfterHiding,
    hiddenHibernatedCount,
    withoutHibernated,
} from '../hibernated-visibility';

/**
 * HIBERNATED WORKSPACES ARE OUT OF THE WAY BY DEFAULT (genie#705).
 *
 * The owner: "let's hide hibernated Workspaces by default but include a button
 * for showing hibernated workspaces." Hibernation is for the workspaces you are
 * NOT working in — on a rail carrying five asleep among the awake, the thing you
 * hibernated to get out of the way is still in the way.
 *
 * PURE, so the rail, the rail's icon strip and the count all decide this the same
 * way; the System Workspace already works exactly like this, and these mirror it.
 */

const ws = (id: string, hibernated_at: number | null = null) => ({ id, hibernated_at });

describe('withoutHidden — what the rail shows', () => {
    it('hides hibernated workspaces by default', () => {
        const rows = [ws('awake'), ws('asleep', 1), ws('also-awake')];
        expect(withoutHibernated(rows, false).map((w) => w.id)).toEqual(['awake', 'also-awake']);
    });

    it('shows them all when revealed, in their normal order', () => {
        // Revealing must not reshuffle the rail — an asleep workspace keeps its
        // place, it does not get bumped to the bottom.
        const rows = [ws('awake'), ws('asleep', 1), ws('also-awake')];
        expect(withoutHibernated(rows, true).map((w) => w.id)).toEqual([
            'awake',
            'asleep',
            'also-awake',
        ]);
    });

    it('leaves a rail with nothing hibernated exactly as it is', () => {
        // POSITIVE CONTROL: the filter must be inert for the common case, or every
        // rail pays for a feature most machines never use.
        const rows = [ws('a'), ws('b')];
        expect(withoutHibernated(rows, false)).toEqual(rows);
    });
});

describe('hiddenHibernatedCount — the button has to say how many', () => {
    it('counts what is being hidden, so the control is not a mystery', () => {
        expect(hiddenHibernatedCount([ws('a'), ws('b', 1), ws('c', 2)])).toBe(2);
    });

    it('is zero when nothing is asleep', () => {
        expect(hiddenHibernatedCount([ws('a'), ws('b')])).toBe(0);
    });
});

describe('activeAfterHiding — the window must not point at a row nobody can see', () => {
    it('falls back to the first visible workspace when the ACTIVE one is hidden', () => {
        // The System Workspace toggle already handles this case; hiding a
        // hibernated ACTIVE workspace would stand the window on an invisible row,
        // with a floor for a workspace the rail denies exists.
        const rows = [ws('awake'), ws('asleep', 1)];
        expect(activeAfterHiding('asleep', rows, false)).toBe('awake');
    });

    it('leaves the active workspace alone when it is visible', () => {
        const rows = [ws('awake'), ws('asleep', 1)];
        expect(activeAfterHiding('awake', rows, false)).toBe('awake');
    });

    it('leaves it alone while hibernated workspaces are REVEALED', () => {
        const rows = [ws('awake'), ws('asleep', 1)];
        expect(activeAfterHiding('asleep', rows, true)).toBe('asleep');
    });

    it('hands back null rather than inventing one when every workspace is asleep', () => {
        // Nothing visible to fall back to is a real state — a machine where the
        // owner hibernated everything — and it must not resolve to a hidden row.
        expect(activeAfterHiding('asleep', [ws('asleep', 1)], false)).toBeNull();
    });
});
