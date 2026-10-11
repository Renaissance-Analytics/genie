import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { codeOpened, emptyWorkspace, terminalOpened, type TerminalTab } from '../src/core/workspace-view.js';
import { NO_FILES, NO_TERMINALS } from '../src/renderer/bridge.js';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';
import { Workspace } from '../src/renderer/components/Workspace.js';

/**
 * CODE PANES AND SPLIT HANDLES ON SCREEN (§4.6, §6.5). `+code` sits beside `+terminal` when the workspace
 * has a files bridge; a code pane is a tab with the file's name and a grid slot holding the file panel in
 * SINGLE mode (one file, no tree); between two shown panes there is a handle to drag the split, and the grid
 * is weighted by the remembered fractions. The file panel's own tabs offer "open in a pane".
 */

const tab = (id: string): TerminalTab => ({ id, workspaceId: 'tynn', shell: 'sh', pid: 1, exited: null });
const workspace = { id: 'tynn', name: 'tynn', path: '/w/tynn' };
const withCode = codeOpened(terminalOpened(emptyWorkspace(), tab('t1'), ''), 'src/a.ts');

describe('the Workspace surface with code panes', () => {
    it('offers +code beside +terminal when there is a files bridge; not otherwise', () => {
        expect(renderToStaticMarkup(<Workspace workspace={workspace} terminals={NO_TERMINALS} files={NO_FILES} />)).toContain('data-action="add-code"');
        expect(renderToStaticMarkup(<Workspace workspace={workspace} terminals={NO_TERMINALS} />)).not.toContain('data-action="add-code"');
    });

    it('a code pane is a tab named by the file and a grid slot holding the file panel in single mode', () => {
        const html = renderToStaticMarkup(<Workspace workspace={workspace} terminals={NO_TERMINALS} files={NO_FILES} initialState={withCode} />);
        expect(html).toContain('data-code-tab="code:src/a.ts"');
        expect(html).toMatch(/data-code-tab="code:src\/a\.ts"[^>]*data-active="true"/);
        expect(html).toContain('data-pane-slot="code:src/a.ts"');
        expect(html).toContain('data-pane-kind="code"');
        expect(html).toContain('data-files-panel="tynn"');
        expect(html).toContain('data-single="src/a.ts"');
        expect(html).not.toContain('data-terminal-pane="code:src/a.ts"');
    });

    it('two panes shown in columns get one split handle between them and a weighted grid from the stored fractions; one pane gets none', () => {
        const settings = { values: { panel_layout: 'columns', panel_splits: JSON.stringify({ columns: [0.6, 0.4] }) }, overridden: [], onSet: () => {}, onReset: () => {} };
        const ops = { asleep: false, onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {}, removePreview: false, lastOutcome: null, settings } as never;
        const html = renderToStaticMarkup(<Workspace workspace={workspace} terminals={NO_TERMINALS} files={NO_FILES} initialState={withCode} ops={ops} />);
        expect(html.match(/data-split-handle="0"/g)?.length ?? 0).toBe(1);
        expect(html).toContain('grid-template-columns:minmax(0, 60fr) minmax(0, 40fr)');
        const single = renderToStaticMarkup(<Workspace workspace={workspace} terminals={NO_TERMINALS} files={NO_FILES} initialState={withCode} />);
        expect(single).not.toContain('data-split-handle');
    });
});

describe('the file panel’s "open in a pane"', () => {
    const base: FilesPanelProps = {
        workspace,
        tree: null,
        state: null,
        tabs: ['src/a.ts'],
        open: { ok: true, path: 'src/a.ts', text: 'one\n', sha: 'abc' },
        pinned: false,
        onSelect: () => {}, onCloseTab: () => {}, onPin: () => {}, onClose: () => {},
    };

    it('each tab offers to open the file in a pane when the panel can; single mode draws no tree and no other tabs', () => {
        const withPane = renderToStaticMarkup(<FilesPanel {...base} onOpenInPane={() => {}} />);
        expect(withPane).toContain('data-action="open-in-pane"');
        expect(renderToStaticMarkup(<FilesPanel {...base} />)).not.toContain('data-action="open-in-pane"');
        const single = renderToStaticMarkup(<FilesPanel {...base} tabs={['src/a.ts', 'src/b.ts']} single="src/a.ts" />);
        expect(single).toContain('data-single="src/a.ts"');
        expect(single).not.toContain('data-react-fancy-tree-nav');
        expect(single).not.toContain('data-file-tab="src/b.ts"');
        expect(single).toContain('data-file-tab="src/a.ts"');
    });
});
