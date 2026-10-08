import { describe, expect, it } from 'vitest';
import { changedFilePaths, filePanelForWorkspace, filterChangedTree, sessionFileChanges, uniqueWorkspaceFilePanels } from '../workspace-file-panel';
import type { TerminalSpec, TreeNodeData } from '../genie';

describe('workspace file panel', () => {
    it('shows one legacy code panel per workspace without hiding terminals or other workspaces', () => {
        const specs = [
            { id: 'a', type: 'code', workspace_id: 'w' },
            { id: 'b', type: 'code', workspace_id: 'w' },
            { id: 'terminal', type: 'terminal', workspace_id: 'w' },
            { id: 'other', type: 'code', workspace_id: 'other' },
        ] as TerminalSpec[];
        expect(uniqueWorkspaceFilePanels(specs).map((spec) => spec.id)).toEqual(['a', 'terminal', 'other']);
    });
    it('includes unattributed git changes in the filter, but not ignored files', () => {
        expect([...changedFilePaths([{ path: 'reported.ts', who: 'atlas', agentId: 'a', at: 1 }], {
            'disk.ts': 'modified', 'ignored.ts': 'ignored', 'reported.ts': 'added',
        })]).toEqual(['reported.ts', 'disk.ts']);
    });
    it('keeps ancestors of changed leaves, without unchanged siblings', () => {
        const nodes: TreeNodeData[] = [{ id: 'src', label: 'src', type: 'folder', children: [
            { id: 'src/a.ts', label: 'a.ts', type: 'file' },
            { id: 'src/b.ts', label: 'b.ts', type: 'file' },
        ] }];
        expect(filterChangedTree(nodes, new Set(['src/b.ts']))).toEqual([
            { ...nodes[0], children: [nodes[0]!.children![1]] },
        ]);
        expect(filterChangedTree(nodes, new Set())).toEqual([]);
        expect(nodes[0]!.children).toHaveLength(2);
    });

    it('merges named disk events neutrally, latest first, without inventing an author', () => {
        const rows = sessionFileChanges([
            { path: 'old.ts', who: 'atlas', agentId: 'a', at: 10 },
            { path: 'new.ts', who: 'wren', agentId: 'w', at: 40 },
        ], { 'disk.ts': 30, 'old.ts': 50 });
        expect(rows.map((row) => [row.path, row.who, row.at])).toEqual([
            ['old.ts', null, 50], ['new.ts', 'wren', 40], ['disk.ts', null, 30],
        ]);
    });

    it('accepts attribution only for the observed write, not a newer unrelated disk event', () => {
        expect(sessionFileChanges([{ path: 'a.ts', who: 'atlas', agentId: 'a', at: 60 }], {
            'a.ts': 60,
        })[0]!.who).toBe('atlas');
    });

    it('reuses the workspace code spec, never an agent terminal or another workspace', () => {
        const specs = [
            { id: 'terminal', type: 'terminal', workspace_id: 'w' },
            { id: 'other', type: 'code', workspace_id: 'other' },
            { id: 'files', type: 'code', workspace_id: 'w' },
        ] as TerminalSpec[];
        expect(filePanelForWorkspace(specs, 'w')?.id).toBe('files');
        expect(filePanelForWorkspace(specs, 'missing')).toBeNull();
    });
});
