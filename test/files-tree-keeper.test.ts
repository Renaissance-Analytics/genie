import { describe, expect, it, vi } from 'vitest';
import { FilesTreeKeeper } from '../src/main/files-tree-keeper.js';

/* The window's copy of each workspace's git tree (Tynn #524): genie-host sends the whole tree once, then its changes. */
describe('FilesTreeKeeper', () => {
    it('keeps the whole tree, turns changes back into it, and names the tree they changed from', () => {
        const keeper = new FilesTreeKeeper();
        const first = { 'a.ts': 'modified', 'gone.ts': 'deleted' } as const;
        expect(keeper.accept({ kind: 'git', workspaceId: 'w', tree: first })).toEqual({ kind: 'git', workspaceId: 'w', tree: first });
        const next = keeper.accept({ kind: 'git', workspaceId: 'w', treeChanges: { set: { 'b.ts': 'added' }, removed: ['gone.ts'] } });
        expect(next).toEqual({ kind: 'git', workspaceId: 'w', tree: { 'a.ts': 'modified', 'b.ts': 'added' }, changes: { prev: first, set: { 'b.ts': 'added' }, removed: ['gone.ts'] } });
        expect(next.kind === 'git' && next.changes!.prev).toBe(first);
        // The tree it made is the one the next changes apply to.
        const third = keeper.accept({ kind: 'git', workspaceId: 'w', treeChanges: { set: { 'a.ts': 'added' }, removed: [] } });
        expect(third.kind === 'git' && third.tree).toEqual({ 'a.ts': 'added', 'b.ts': 'added' });
        expect(third.kind === 'git' && third.changes!.prev).toBe(next.kind === 'git' ? next.tree : null);
    });

    it('changes with no tree kept are not guessed at: sent on without a tree, said once', () => {
        const log = vi.fn(), keeper = new FilesTreeKeeper(log);
        for (let i = 0; i < 2; i += 1) expect(keeper.accept({ kind: 'git', workspaceId: 'w', treeChanges: { set: { 'a.ts': 'added' }, removed: [] }, repos: {} })).toEqual({ kind: 'git', workspaceId: 'w', repos: {} });
        expect(log).toHaveBeenCalledOnce();
    });

    it('a batch of paths, and a git event with no tree, pass as they are', () => {
        const keeper = new FilesTreeKeeper();
        const changed = { kind: 'changed', workspaceId: 'w', changes: [{ path: 'a.ts', at: 1 }] } as const;
        expect(keeper.accept(changed)).toBe(changed);
        const repos = { kind: 'git', workspaceId: 'w', repos: {} } as const;
        expect(keeper.accept(repos)).toBe(repos);
    });
});
