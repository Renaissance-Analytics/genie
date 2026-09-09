import { describe, expect, it } from 'vitest';
import {
    isWorkspaceCollapsed,
    parseCollapsedWorkspaces,
    serializeCollapsedWorkspaces,
    toggleWorkspaceCollapsed,
} from '../workspace-collapse';

/**
 * genie#580 — the workspace sidebar opened with EVERY workspace expanded.
 *
 * `collapsed_workspaces` stores the ids that ARE collapsed, and the seed read it
 * as `JSON.parse(s?.collapsed_workspaces ?? '[]')` — so "no preference recorded"
 * (any new remote connection) and "the user deliberately expanded everything"
 * were the SAME value, and both rendered maximised. The owner wants workspaces to
 * start minimised.
 *
 * Inverting the default is not enough on its own: with collapsed polarity, an
 * ABSENT setting has to stay distinguishable from a recorded EMPTY list, or a
 * user who genuinely expanded everything gets re-collapsed on every launch. So
 * "nothing recorded" is its own state (`null`) rather than an empty set, and it
 * is materialised into a real list the first time the user toggles a row.
 */
describe('parseCollapsedWorkspaces', () => {
    it('reads a recorded list of collapsed ids', () => {
        expect(parseCollapsedWorkspaces('["a","b"]')).toEqual(new Set(['a', 'b']));
    });

    it('reads a recorded EMPTY list as a real preference (everything expanded)', () => {
        // The distinction the whole fix rests on: `'[]'` is the user having
        // expanded every workspace, NOT the absence of a setting.
        expect(parseCollapsedWorkspaces('[]')).toEqual(new Set());
    });

    it('reports NOTHING RECORDED for an unset setting', () => {
        for (const raw of [undefined, null, '']) {
            expect(parseCollapsedWorkspaces(raw)).toBeNull();
        }
    });

    it('reports NOTHING RECORDED for a malformed or wrong-shaped value', () => {
        for (const raw of ['not json', '{"a":1}', '42', 'null']) {
            expect(parseCollapsedWorkspaces(raw)).toBeNull();
        }
    });

    it('drops non-string entries from a hand-edited list', () => {
        expect(parseCollapsedWorkspaces('["a",7,null,"b"]')).toEqual(new Set(['a', 'b']));
    });
});

describe('isWorkspaceCollapsed', () => {
    it('collapses every workspace when nothing has been recorded (the #580 default)', () => {
        expect(isWorkspaceCollapsed(null, 'anything')).toBe(true);
    });

    it('honours a recorded EMPTY list — the user expanded everything, keep it expanded', () => {
        expect(isWorkspaceCollapsed(new Set(), 'a')).toBe(false);
    });

    it('honours a recorded list', () => {
        const state = new Set(['a']);
        expect(isWorkspaceCollapsed(state, 'a')).toBe(true);
        expect(isWorkspaceCollapsed(state, 'b')).toBe(false);
    });
});

describe('toggleWorkspaceCollapsed', () => {
    it('materialises the unrecorded default: toggling expands ONE row, the rest stay collapsed', () => {
        const next = toggleWorkspaceCollapsed(null, 'b', ['a', 'b', 'c']);
        expect(next).toEqual(new Set(['a', 'c']));
        expect(isWorkspaceCollapsed(next, 'b')).toBe(false);
        expect(isWorkspaceCollapsed(next, 'a')).toBe(true);
    });

    it('expands a recorded collapsed row', () => {
        expect(toggleWorkspaceCollapsed(new Set(['a', 'b']), 'a', ['a', 'b'])).toEqual(
            new Set(['b']),
        );
    });

    it('collapses a recorded expanded row', () => {
        expect(toggleWorkspaceCollapsed(new Set(['a']), 'b', ['a', 'b'])).toEqual(
            new Set(['a', 'b']),
        );
    });

    it('is immutable — the input set is left alone', () => {
        const state = new Set(['a']);
        toggleWorkspaceCollapsed(state, 'b', ['a', 'b']);
        expect(state).toEqual(new Set(['a']));
    });

    it('expanding the LAST collapsed row records an empty list, which then survives', () => {
        // The regression this guards: if "all expanded" round-tripped back to
        // "nothing recorded", the next launch would re-collapse everything and the
        // user could never keep an all-expanded sidebar.
        const next = toggleWorkspaceCollapsed(new Set(['a']), 'a', ['a', 'b']);
        expect(next).toEqual(new Set());
        const reloaded = parseCollapsedWorkspaces(serializeCollapsedWorkspaces(next));
        expect(reloaded).toEqual(new Set());
        expect(isWorkspaceCollapsed(reloaded, 'a')).toBe(false);
    });
});

describe('the whole first-launch round trip', () => {
    it('a fresh client starts collapsed, and its first toggle is remembered', () => {
        // 1. Nothing recorded (a new remote connection) → every workspace minimised.
        const seeded = parseCollapsedWorkspaces(undefined);
        expect(['a', 'b', 'c'].every((id) => isWorkspaceCollapsed(seeded, id))).toBe(true);

        // 2. The user expands `b`. That writes a REAL value for the first time.
        const afterToggle = toggleWorkspaceCollapsed(seeded, 'b', ['a', 'b', 'c']);
        const persisted = serializeCollapsedWorkspaces(afterToggle);

        // 3. Next launch reads that value back — `b` stays expanded, the rest stay
        //    collapsed. The default no longer applies once something is recorded.
        const reloaded = parseCollapsedWorkspaces(persisted);
        expect(isWorkspaceCollapsed(reloaded, 'b')).toBe(false);
        expect(isWorkspaceCollapsed(reloaded, 'a')).toBe(true);
        expect(isWorkspaceCollapsed(reloaded, 'c')).toBe(true);
    });
});
