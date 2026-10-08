import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import FileTree from '../Code/FileTree';

function render(changedOnly = false) {
    return renderToStaticMarkup(React.createElement(FileTree, {
        nodes: [{ id: 'a.ts', label: 'a.ts', type: 'file' }, { id: 'b.ts', label: 'b.ts', type: 'file' }],
        workspacePath: '/w', expandedIds: [], locked: false, lockedRoot: '',
        onSelectFile: () => {}, onTreeChanged: () => {}, onOpenCreatedFile: () => {},
        onLockToFolder: () => {}, onUnlock: () => {}, onExpandedChange: () => {},
        gitStatus: { 'b.ts': 'modified' },
        changes: [{ path: 'a.ts', who: 'atlas', agentId: 'a', at: 10 }], changedOnly,
    }));
}

describe('existing Fancy file tree attribution', () => {
    it('names a reported writer and leaves a git-only author neutral', () => {
        const html = render();
        expect(html).toContain('atlas');
        expect(html).toContain('On disk · not attributed');
        expect(html).toContain(' · ?');
    });

    it('keeps git-only changes in Changed, not just agent-reported changes', () => {
        expect(render(true)).toContain('b.ts');
    });
});
