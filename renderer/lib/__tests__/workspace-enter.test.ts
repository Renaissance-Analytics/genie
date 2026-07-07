import { describe, it, expect } from 'vitest';
import {
    enterableWorkspaceIds,
    newlyAddedWorkspaceIds,
} from '../workspace-enter';

const SYSTEM = '__system__';

describe('enterableWorkspaceIds', () => {
    it('collects every workspace id', () => {
        const ids = enterableWorkspaceIds(
            [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
            SYSTEM,
        );
        expect([...ids].sort()).toEqual(['a', 'b', 'c']);
    });

    it('excludes the synthetic System Workspace id', () => {
        const ids = enterableWorkspaceIds(
            [{ id: SYSTEM }, { id: 'a' }],
            SYSTEM,
        );
        expect([...ids]).toEqual(['a']);
    });

    it('is empty for an empty list', () => {
        expect(enterableWorkspaceIds([], SYSTEM).size).toBe(0);
    });
});

describe('newlyAddedWorkspaceIds', () => {
    it('returns [] on the first observation (no baseline) — initial list never animates', () => {
        const current = new Set(['a', 'b']);
        expect(newlyAddedWorkspaceIds(null, current)).toEqual([]);
    });

    it('detects a genuinely-new id absent from the previous set', () => {
        const prev = new Set(['a', 'b']);
        const current = new Set(['a', 'b', 'c']);
        expect(newlyAddedWorkspaceIds(prev, current)).toEqual(['c']);
    });

    it('detects multiple new ids at once (host push of several)', () => {
        const prev = new Set(['a']);
        const current = new Set(['a', 'b', 'c']);
        expect(newlyAddedWorkspaceIds(prev, current).sort()).toEqual(['b', 'c']);
    });

    it('does NOT re-fire for ids already seen (re-render / reorder / rename)', () => {
        const prev = new Set(['a', 'b', 'c']);
        const current = new Set(['c', 'b', 'a']); // reordered, same members
        expect(newlyAddedWorkspaceIds(prev, current)).toEqual([]);
    });

    it('ignores removals — a dropped id is not "new"', () => {
        const prev = new Set(['a', 'b', 'c']);
        const current = new Set(['a', 'b']);
        expect(newlyAddedWorkspaceIds(prev, current)).toEqual([]);
    });

    it('treats a removed-then-readded id as new again (real re-arrival)', () => {
        // Baseline had it, a later diff dropped it, then it comes back: the
        // caller advances `prev` to the dropped set, so re-adding fires again.
        const droppedBaseline = new Set(['a']);
        const current = new Set(['a', 'b']);
        expect(newlyAddedWorkspaceIds(droppedBaseline, current)).toEqual(['b']);
    });
});
