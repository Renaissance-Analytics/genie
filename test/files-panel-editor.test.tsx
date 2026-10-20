import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FilesPanel, isSaveShortcut, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';

/**
 * THE EDITOR FILLS ITS PANE, AND EDITS (Tynn #840; the owner, 2026-10-20: "I cannot edit files in our file browser and
 * the editor doesn't even fill the space it's in"). The editor was fancy-code's FileViewer: a content-high block, so the
 * editor shrank to its text and the space under it was dead — a click there did nothing, which reads as "can't edit" —
 * and fancy-code's own scroller never scrolled. Genie 1 hit the same (genie#603). Now the CodeEditor IS the pane: its root
 * fills the column and its Panel is the one scroller. Ctrl/Cmd+S saves; a dirty tab says so; a save that fails without
 * a conflict says why instead of vanishing. Tailwind scans fancy-code, or the classes only it uses are never generated.
 */

const base: FilesPanelProps = {
    workspace: { id: 'tynn', name: 'tynn', path: '/w/tynn' },
    tree: [{ id: 'src', label: 'src', type: 'folder', children: [{ id: 'src/a.ts', label: 'a.ts', type: 'file', ext: 'ts' }] }],
    state: { files: [], activity: [], unreported: [], changed: null },
    tabs: ['src/a.ts'],
    open: { ok: true, path: 'src/a.ts', text: 'one\n', sha: 'abc' },
    pinned: false,
    onSelect: () => {}, onCloseTab: () => {}, onPin: () => {}, onClose: () => {},
    edit: { dirty: false, conflict: null, onChange: () => {}, onSave: () => {}, onKeepMine: () => {}, onTakeTheirs: () => {}, onCompare: () => {} },
};
const render = (p: Partial<FilesPanelProps>) => renderToStaticMarkup(<FilesPanel {...base} {...p} />);
const classOf = (html: string, attr: string) => new RegExp(`${attr}=""[^>]*class="([^"]*)"`).exec(html)?.[1] ?? new RegExp(`class="([^"]*)"[^>]*${attr}=""`).exec(html)?.[1] ?? null;

describe('the editor is the pane', () => {
    it('a text file: fancy-code’s CodeEditor fills the column and its Panel is the one scroller', () => {
        const html = render({});
        const root = classOf(html, 'data-fancy-code-editor');
        const panel = classOf(html, 'data-fancy-code-panel');
        expect(root).toMatch(/\bh-full\b/);
        expect(root).toMatch(/\bflex-col\b/);
        expect(panel).toMatch(/\bflex-1\b/);
        expect(panel).toMatch(/\bmin-h-0\b/);
        // Not the content-high FileViewer block any more.
        expect(html).not.toContain('data-fancy-file-viewer');
    });

    it('editable: the text area is not read-only (CONTROL: without edit ops it is)', () => {
        expect(render({})).not.toMatch(/<textarea[^>]*readonly/i);
        expect(render({ edit: undefined })).toMatch(/<textarea[^>]*readonly/i);
    });

    it('a media file still opens in the viewer', () => {
        const html = render({ tabs: ['logo.png'], open: { ok: true, path: 'logo.png', text: '', sha: 'x' } });
        expect(html).toContain('data-kind="media"');
    });
});

describe('saving', () => {
    it('Ctrl+S and Cmd+S save; plain S, and Ctrl+Shift+S, do not', () => {
        expect(isSaveShortcut({ key: 's', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(true);
        expect(isSaveShortcut({ key: 'S', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false })).toBe(true);
        expect(isSaveShortcut({ key: 's', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBe(false);
        expect(isSaveShortcut({ key: 's', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false })).toBe(false);
    });

    it('a dirty tab shows the dot; a clean one does not', () => {
        expect(render({ edit: { ...base.edit!, dirty: true } })).toContain('data-dirty-dot');
        expect(render({})).not.toContain('data-dirty-dot');
    });

    it('a save that failed without a conflict says why', () => {
        const html = render({ edit: { ...base.edit!, dirty: true, saveError: 'EACCES: permission denied' } });
        expect(html).toMatch(/data-save-error[^>]*>[^<]*EACCES: permission denied/);
    });
});

describe('the stylesheet', () => {
    it('Tailwind scans fancy-code as well as react-fancy', () => {
        const css = readFileSync('src/renderer/styles.css', 'utf8');
        expect(css).toContain('@source "../../node_modules/@particle-academy/fancy-code/dist/**/*.js";');
    });
});
