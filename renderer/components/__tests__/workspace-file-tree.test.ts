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
        // The chip is now `WhoChip` (a Fancy Badge) rather than a ` · who` text run, per the
        // owner's mockup: the `?` is a chip of its own in NEUTRAL GREY, and the colour is what
        // carries "Genie does not guess the author". So the assertions move from the old text
        // separator to the two things the mockup actually specifies.
        expect(html).toContain('on disk · not attributed');
        expect(html).toContain('>?<');
        // Violet for a named agent, zinc for the unclaimed write — the distinction the old
        // single-colour `.tree-agent` span could not draw.
        expect(html).toContain('bg-violet-100');
        expect(html).toContain('code-who is-unattributed');
    });

    it('marks the git state with git’s own letter', () => {
        // `b.ts` is modified and unclaimed: an `M` in amber beside the `?`.
        const html = render();
        expect(html).toContain('>M<');
        expect(html).toContain('code-change-marker');
        // And the file nobody reported a status for carries no marker — a marker is a state
        // claim, and git made none about `a.ts`.
        expect(html.split('code-change-marker').length - 1).toBe(1);
    });

    it('keeps git-only changes in Changed, not just agent-reported changes', () => {
        expect(render(true)).toContain('b.ts');
    });
});
