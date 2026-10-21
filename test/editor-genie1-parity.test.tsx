import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fileMenuItems } from '../src/core/file-menu.js';
import { DEFAULT_PANEL_PREFS, readPanelPrefs, writePanelPrefs } from '../src/core/files-panel-prefs.js';
import { treeFromLoaded } from '../src/core/files-tree-lazy.js';
import { clampWandX, sameAnchor } from '../src/core/wand-anchor.js';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';

/**
 * THE FILE EDITOR AT GENIE 1'S LEVEL (beta.33 item 15). The owner, 2026-10-20: "Our file editor is totally garbage compared
 * to genie 1's editor." The gap list, from Genie 1's CODE (renderer/components/Code/CodePanel.tsx, WordWrapSync, EditorWand,
 * FileTree, FileTreeContextMenu) against this panel, is in .ai/sandbox/builders/builder-editor.md. Each gap is pinned here:
 * word wrap, lock to a folder, hide / pin the tree, the remembered tabs and folders, the diff gutter, the cursor position,
 * the unsaved and git markers in the tree, and the EditorWand's geometry.
 */

const base: FilesPanelProps = {
    workspace: { id: 'tynn', name: 'tynn', path: '/w/tynn' },
    tree: [{ id: 'docs', label: 'docs', type: 'folder', children: [{ id: 'docs/a.ts', label: 'a.ts', type: 'file', ext: 'ts' }] }, { id: 'b.ts', label: 'b.ts', type: 'file', ext: 'ts' }],
    state: { files: [], activity: [], unreported: [], changed: null },
    tabs: ['b.ts'],
    open: { ok: true, path: 'b.ts', text: 'one\ntwo\n', sha: 's' },
    pinned: false,
    onSelect: () => {}, onCloseTab: () => {}, onClose: () => {},
    edit: { dirty: false, conflict: null, onChange: () => {}, onSave: () => {}, onKeepMine: () => {}, onTakeTheirs: () => {}, onCompare: () => {} },
};
const render = (p: Partial<FilesPanelProps>) => renderToStaticMarkup(<FilesPanel {...base} {...p} />);
const prefs = (p: Partial<typeof DEFAULT_PANEL_PREFS>) => ({ ...DEFAULT_PANEL_PREFS, ...p });

describe('the panel remembers itself, per workspace (Genie 1 kept these in the view meta)', () => {
    const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };

    it('defaults: no wrap, the tree shown and pinned, unlocked, no tabs', () => {
        expect(readPanelPrefs(store(), 'tynn')).toEqual(DEFAULT_PANEL_PREFS);
        expect(DEFAULT_PANEL_PREFS).toEqual({ wordWrap: false, treeHidden: false, treePinned: true, lockedRoot: null, tabs: [], active: null, expanded: [] });
    });

    it('what was written comes back — for THAT workspace only; garbage reads as the defaults', () => {
        const s = store();
        writePanelPrefs(s, 'tynn', prefs({ wordWrap: true, lockedRoot: 'docs', tabs: ['docs/a.ts', 'b.ts'], active: 'b.ts', expanded: ['docs'] }));
        expect(readPanelPrefs(s, 'tynn')).toMatchObject({ wordWrap: true, lockedRoot: 'docs', tabs: ['docs/a.ts', 'b.ts'], active: 'b.ts', expanded: ['docs'] });
        expect(readPanelPrefs(s, 'other')).toEqual(DEFAULT_PANEL_PREFS);
        s.setItem('genie.files-panel.tynn', '{not json');
        expect(readPanelPrefs(s, 'tynn')).toEqual(DEFAULT_PANEL_PREFS);
        s.setItem('genie.files-panel.tynn', JSON.stringify({ wordWrap: 'yes', tabs: [1, 'a.ts'], active: 7 }));
        expect(readPanelPrefs(s, 'tynn')).toEqual({ ...DEFAULT_PANEL_PREFS, tabs: ['a.ts'] });
    });

    it('no storage (a test, a locked-down window): defaults, and a write is a no-op, never a throw', () => {
        expect(readPanelPrefs(null, 'tynn')).toEqual(DEFAULT_PANEL_PREFS);
        expect(() => writePanelPrefs(null, 'tynn', DEFAULT_PANEL_PREFS)).not.toThrow();
    });
});

describe('word wrap (Genie 1 header toggle + WordWrapSync)', () => {
    it('a header toggle says whether it is on; the editor wraps when it is (CONTROL: off = pre)', () => {
        const off = render({ prefs: prefs({ wordWrap: false }), onPrefs: () => {} });
        const on = render({ prefs: prefs({ wordWrap: true }), onPrefs: () => {} });
        expect(off).toMatch(/data-action="word-wrap"[^>]*aria-pressed="false"/);
        expect(on).toMatch(/data-action="word-wrap"[^>]*aria-pressed="true"/);
        expect(on).toContain('white-space:pre-wrap');
        expect(off).not.toContain('white-space:pre-wrap');
    });
});

describe('lock the panel to a folder (Genie 1 FileTreeContextMenu)', () => {
    it('right-click a folder: "Lock Files panel to this folder"; locked: "Unlock Files panel" anywhere in the tree', () => {
        const open = { external: true, reveal: true, edit: true, lock: { lockedRoot: null } };
        expect(fileMenuItems('tree-folder', open).map((i) => i.label)).toContain('Lock Files panel to this folder');
        expect(fileMenuItems('tree-file', open).map((i) => i.id)).not.toContain('lock-folder');
        const locked = { ...open, lock: { lockedRoot: 'docs' } };
        expect(fileMenuItems('tree-file', locked).map((i) => i.label)).toContain('Unlock Files panel');
        expect(fileMenuItems('tree-root', locked).map((i) => i.id)).toContain('unlock');
        // CONTROL: without the lock option (a code pane), no lock items at all.
        expect(fileMenuItems('tree-folder', { external: true, reveal: true }).map((i) => i.id)).not.toContain('lock-folder');
    });

    it('the tree is rooted at the locked folder: its children are the top level', () => {
        const loaded = new Map([['', [{ id: 'docs', label: 'docs', type: 'folder' as const }]], ['docs', [{ id: 'docs/a.ts', label: 'a.ts', type: 'file' as const }]]]);
        expect(treeFromLoaded(loaded, 'docs')).toEqual([{ id: 'docs/a.ts', label: 'a.ts', type: 'file' }]);
        expect(treeFromLoaded(loaded)).toEqual([{ id: 'docs', label: 'docs', type: 'folder', children: [{ id: 'docs/a.ts', label: 'a.ts', type: 'file' }] }]);
        expect(treeFromLoaded(loaded, 'nope')).toBeNull();
    });

    it('a locked panel says where it is locked, with Unlock in the header', () => {
        const html = render({ prefs: prefs({ lockedRoot: 'docs' }), onPrefs: () => {} });
        expect(html).toMatch(/data-locked-root="docs"/);
        expect(html).toContain('data-action="unlock-tree"');
        expect(render({ prefs: prefs({}), onPrefs: () => {} })).not.toContain('data-locked-root');
    });
});

describe('hide and pin the tree (Genie 1: the tree auto-hides on open unless pinned)', () => {
    it('hidden: no tree column, and a toggle to bring it back; shown: the tree', () => {
        const hidden = render({ prefs: prefs({ treeHidden: true }), onPrefs: () => {} });
        expect(hidden).toContain('data-action="toggle-tree"');
        expect(hidden).not.toContain('data-files-tree');
        expect(render({ prefs: prefs({}), onPrefs: () => {} })).toContain('data-files-tree');
        expect(render({ prefs: prefs({ treePinned: true }), onPrefs: () => {} })).toMatch(/data-action="pin-tree"[^>]*aria-pressed="true"/);
    });
});

describe('the editor itself', () => {
    it('the diff gutter marks what changed since the file was opened or saved (fancy-code diffBase)', () => {
        const html = render({ open: { ok: true, path: 'b.ts', text: 'one\nTWO\nthree\n', sha: 's' }, baseline: 'one\ntwo\n', edit: { ...base.edit!, dirty: true } });
        expect(html).toMatch(/data-diff="(modified|added)"/);
        // CONTROL: the same text as the baseline marks nothing.
        expect(render({ baseline: 'one\ntwo\n' })).not.toMatch(/data-diff="(modified|added)"/);
    });

    it('the status bar reports the cursor (Ln, Col) beside language · line ending · encoding', () => {
        const html = render({});
        expect(html).toMatch(/Ln 1, Col 1/);
        expect(html).toMatch(/data-file-status="b.ts"/);
    });

    it('the editor follows GENIE\'s theme, not the OS (Genie 1 useResolvedTheme)', () => {
        expect(render({ theme: 'light' })).toMatch(/data-editor-theme="light"/);
        expect(render({ theme: 'dark' })).toMatch(/data-editor-theme="dark"/);
    });
});

describe('the tree marks what you have not saved, and git\'s state', () => {
    it('an unsaved file carries the dot in the tree; git colours modified and untracked rows', () => {
        const html = render({ unsaved: ['b.ts'], git: { 'b.ts': 'modified', 'docs/a.ts': 'untracked' }, expanded: ['docs'] });
        expect(html).toMatch(/data-unsaved="b.ts"/);
        expect(html).toMatch(/data-git="modified"[^>]*>[\s\S]*?b\.ts|b\.ts[\s\S]*?data-git="modified"/);
        expect(html).toContain('data-git="untracked"');
        // CONTROL: nothing unsaved, no git — no markers.
        const plain = render({ expanded: ['docs'] });
        expect(plain).not.toContain('data-unsaved');
        expect(plain).not.toContain('data-git=');
    });
});

describe('EditorWand geometry (Genie 1 wand-anchor, kept)', () => {
    it('sub-pixel jitter is the same anchor; a real move is not', () => {
        expect(sameAnchor({ x: 10, y: 20 }, { x: 10.2, y: 20.1 })).toBe(true);
        expect(sameAnchor({ x: 10, y: 20 }, { x: 11, y: 20 })).toBe(false);
        expect(sameAnchor(null, null)).toBe(true);
    });

    it('the pill is kept on screen and settles in one pass; too wide pins left (no update loop)', () => {
        expect(clampWandX({ x: 2, left: -20, right: 24, viewportWidth: 800 })).toBe(28);
        expect(clampWandX({ x: 28, left: 6, right: 50, viewportWidth: 800 })).toBeNull();
        expect(clampWandX({ x: 790, left: 770, right: 810, viewportWidth: 800 })).toBe(774);
        expect(clampWandX({ x: 400, left: 0, right: 900, viewportWidth: 800 })).toBe(406);
        expect(clampWandX({ x: 406, left: 6, right: 906, viewportWidth: 800 })).toBeNull();
    });
});

describe('closing what you have not saved asks first (Genie 1 showPrompt "Unsaved changes — Discard?")', () => {
    it('one file names it; several count them; Discard is the destructive choice, Keep editing the way out', async () => {
        const { DiscardForm, discardWords } = await import('../src/renderer/components/DiscardModal.js');
        expect(discardWords(['src/a.ts'])).toBe('a.ts has unsaved edits. Discard them?');
        expect(discardWords(['a.ts', 'b.ts'])).toBe('2 open files have unsaved edits. Discard them all?');
        const html = renderToStaticMarkup(<DiscardForm paths={['src/a.ts']} onDiscard={() => {}} onCancel={() => {}} />);
        expect(html).toContain('a.ts has unsaved edits. Discard them?');
        expect(html).toMatch(/data-action="discard"[^>]*>(<[^>]*>)*Discard</);
        expect(html).toMatch(/data-action="keep-editing"[^>]*>(<[^>]*>)*Keep editing</);
    });
});
