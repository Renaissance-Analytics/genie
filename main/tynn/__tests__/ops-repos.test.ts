import { describe, expect, it } from 'vitest';
import { diffOpsRepos } from '../ops-repos';

describe('diffOpsRepos', () => {
    const desired = [
        { name: 'civi-web', url: 'git@github.com:o/civi-web.agi.git', projectId: 'p1' },
        { name: 'civi-api', url: 'git@github.com:o/civi-api.agi.git', projectId: 'p2' },
    ];

    it('adds desired slave repos not yet in the envelope', () => {
        const { toAdd, toRemove } = diffOpsRepos(desired, []);
        expect(toAdd.map((r) => r.name)).toEqual(['civi-web', 'civi-api']);
        expect(toRemove).toEqual([]);
    });

    it('matches by URL, not name (a present repo is not re-added)', () => {
        const current = [
            { name: 'renamed', url: 'git@github.com:o/civi-web.agi.git', managedByOps: true },
        ];
        const { toAdd } = diffOpsRepos(desired, current);
        expect(toAdd.map((r) => r.name)).toEqual(['civi-api']);
    });

    it('removes only managedByOps repos that are no longer desired', () => {
        const current = [
            { name: 'civi-web', url: 'git@github.com:o/civi-web.agi.git', managedByOps: true },
            { name: 'dropped', url: 'git@github.com:o/dropped.agi.git', managedByOps: true },
            { name: 'hand-added', url: 'git@github.com:o/manual.git' }, // not managedByOps
        ];
        const { toAdd, toRemove } = diffOpsRepos(desired, current);
        expect(toRemove.map((r) => r.name)).toEqual(['dropped']); // not 'hand-added'
        expect(toAdd.map((r) => r.name)).toEqual(['civi-api']);
    });

    it('never touches hand-added (non-managed) repos', () => {
        const current = [{ name: 'manual', url: 'git@github.com:o/manual.git' }];
        const { toRemove } = diffOpsRepos([], current);
        expect(toRemove).toEqual([]);
    });
});
