import { describe, expect, it } from 'vitest';
import { groupPendingByWorkspace, pendingCount } from '../inbox';
import type { PendingQuestion } from '../force-question';

/**
 * PendingQuestions inbox grouping (Phase B). Pure — the renderer draws these
 * workspace groups (top-bar icon → workspace list → questions in answer order).
 */
const Q = (over: Partial<PendingQuestion>): PendingQuestion => ({
    id: over.id ?? Math.random().toString(36).slice(2),
    questions: over.questions ?? [{ header: 'H', question: 'H?', options: [{ label: 'Yes' }] }],
    index: over.index ?? 0,
    ...over,
});

describe('groupPendingByWorkspace', () => {
    it('groups by workspace with a count + top priority, most-urgent workspace first', () => {
        const groups = groupPendingByWorkspace([
            Q({ workspaceLabel: 'Alpha', index: 0, priority: 'normal' }),
            Q({ workspaceLabel: 'Beta', index: 1, priority: 'urgent' }),
            Q({ workspaceLabel: 'Alpha', index: 2, priority: 'high' }),
        ]);

        expect(groups.map((g) => g.workspaceLabel)).toEqual(['Beta', 'Alpha']); // Beta (urgent) first
        const beta = groups[0];
        expect(beta.count).toBe(1);
        expect(beta.topPriority).toBe('urgent');
        const alpha = groups[1];
        expect(alpha.count).toBe(2);
        expect(alpha.topPriority).toBe('high'); // the higher of normal/high
    });

    it('orders questions within a workspace by index (modal queue first, then deferred)', () => {
        const groups = groupPendingByWorkspace([
            Q({ id: 'deferred', workspaceLabel: 'W', index: 5, deferred: true }),
            Q({ id: 'head', workspaceLabel: 'W', index: 0 }),
            Q({ id: 'queued', workspaceLabel: 'W', index: 1 }),
        ]);
        expect(groups[0].questions.map((q) => q.id)).toEqual(['head', 'queued', 'deferred']);
    });

    it('keeps a remote host workspace DISTINCT from a local same-named one (§8 attribution)', () => {
        const groups = groupPendingByWorkspace([
            Q({ workspaceLabel: 'Wonder', index: 0 }), // local
            Q({ workspaceLabel: 'Wonder', index: 1, remoteHost: 'cloud-host' }), // remote
        ]);
        expect(groups).toHaveLength(2);
        expect(groups.some((g) => g.remoteHost === undefined)).toBe(true);
        expect(groups.some((g) => g.remoteHost === 'cloud-host')).toBe(true);
    });

    it('falls back to "Unassigned" for a question with no workspace label', () => {
        const groups = groupPendingByWorkspace([Q({ index: 0 })]);
        expect(groups[0].workspaceLabel).toBe('Unassigned');
    });

    it('empty in → empty out', () => {
        expect(groupPendingByWorkspace([])).toEqual([]);
    });
});

describe('pendingCount', () => {
    it('is the total across all workspaces (the top-bar badge)', () => {
        expect(pendingCount([Q({ workspaceLabel: 'A' }), Q({ workspaceLabel: 'B' })])).toBe(2);
        expect(pendingCount([])).toBe(0);
    });
});
