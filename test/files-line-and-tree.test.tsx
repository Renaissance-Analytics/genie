import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TreeNav } from '@particle-academy/react-fancy';
import { openFileRoute } from '../src/core/files-panel.js';
import { formatRoute, parseRoute } from '../src/core/route.js';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';

/**
 * THE FILE PANEL LANDS ON A LINE AND DRAWS ITS TREE CHEAPLY (Tynn #804, #803; the fancy agent's react-fancy 5.43.0 and
 * fancy-code 0.12.0, 2026-10-17, asked for by Genie).
 *
 *  - openFileForUser(path, line) opens Genie's file panel on the file AT THE LINE: the route carries `line=`, and the
 *    panel's FileViewer lands on it (scrolled mid-view, highlighted).
 *  - The tree is VIRTUALIZED: only the rows in view are in the page, not all 5,000 the listing may hold — and Genie's
 *    tree is fully expanded (`defaultExpandAll`), so before this every one of them was mounted.
 */
describe('the route carries the line', () => {
    it('a file at a line, read back as that file and line; a bad or missing line is none; no file, no line', () => {
        expect(parseRoute('genie://workspace/tynn?files=src%2Fa.ts&line=12')).toMatchObject({ file: 'src/a.ts', line: 12 });
        expect(parseRoute('genie://workspace/tynn?files=src%2Fa.ts&line=zero')).toMatchObject({ file: 'src/a.ts', line: null });
        expect(parseRoute('genie://workspace/tynn?files=src%2Fa.ts&line=-3')).toMatchObject({ line: null });
        expect(parseRoute('genie://workspace/tynn?files=src%2Fa.ts')).toMatchObject({ line: null });
        expect(parseRoute('genie://workspace/tynn?files=&line=4')).toMatchObject({ file: null, line: null });
        const r = parseRoute('genie://workspace/tynn?files=src%2Fa.ts&line=12');
        expect(parseRoute(formatRoute(r))).toMatchObject({ file: 'src/a.ts', line: 12 });
    });

    it('openFileForUser’s route lands on the line it was given; none given, none in the route', () => {
        expect(parseRoute(openFileRoute('tynn', 'docs/plan.md', 40))).toMatchObject({ surface: 'workspace', panel: 'files', file: 'docs/plan.md', line: 40 });
        expect(parseRoute(openFileRoute('tynn', 'docs/plan.md', null))).toMatchObject({ file: 'docs/plan.md', line: null });
    });
});

const tree = Array.from({ length: 30 }, (_, i) => ({ id: `dir${i}`, label: `dir${i}`, type: 'folder' as const, children: [{ id: `dir${i}/f.ts`, label: 'f.ts', type: 'file' as const, ext: 'ts' }] }));
const panel = (over: Partial<FilesPanelProps> = {}) => renderToStaticMarkup(
    <FilesPanel
        workspace={{ id: 'tynn', name: 'tynn', path: '/w/tynn' }}
        tree={tree}
        state={null}
        tabs={['dir0/f.ts']}
        open={{ ok: true, path: 'dir0/f.ts', text: Array.from({ length: 80 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n'), sha: 'x' }}
        pinned={false}
        onSelect={() => {}}
        onCloseTab={() => {}}
        onPin={() => {}}
        onClose={() => {}}
        {...(over as object)}
    />,
);

describe('the panel', () => {
    it('the open file lands on the route’s line: Fancy’s FileViewer highlights it', () => {
        expect(panel({ line: 12 })).toContain('data-fancy-code-highlight-line="12"');
        // CONTROL: no line, no highlight.
        expect(panel()).not.toContain('data-fancy-code-highlight-line=');
    });

    it('the tree is virtualized — rows flat, no nested children wrappers; CONTROL: Fancy’s plain tree nests them', () => {
        const html = panel();
        expect(html).toContain('dir0');
        expect(html).not.toContain('data-react-fancy-tree-node-children');
        expect(renderToStaticMarkup(<TreeNav nodes={tree} defaultExpandAll />)).toContain('data-react-fancy-tree-node-children');
    });
});
