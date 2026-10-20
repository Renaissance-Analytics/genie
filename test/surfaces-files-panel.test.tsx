import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';

/**
 * THE FILE PANEL (§4.3), rendered server-side. A 220px tree with ONE dot plus a COUNT per touched
 * file (violet while an edit is in flight, green when changed this session, neutral `?` when nobody
 * reported it); tabs; the footer naming who is touching what; the Changes section ABSENT when
 * nothing changed; an error in the tab body, never a blank editor. Skeletons before the tree is known.
 */

const base: FilesPanelProps = {
    workspace: { id: 'tynn', name: 'tynn', path: '/w/tynn' },
    tree: [
        { id: 'src', label: 'src', type: 'folder', children: [{ id: 'src/db.ts', label: 'db.ts', type: 'file', ext: 'ts' }, { id: 'src/ipc.ts', label: 'ipc.ts', type: 'file', ext: 'ts' }] },
        { id: 'mystery.ts', label: 'mystery.ts', type: 'file', ext: 'ts' },
        { id: 'README.md', label: 'README.md', type: 'file', ext: 'md' },
    ],
    state: {
        files: [
            { path: 'src/db.ts', agents: Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, name: `agent${i}` })), count: 20, inFlight: false },
            { path: 'src/ipc.ts', agents: [{ id: 'agent_kora', name: 'kora' }], count: 1, inFlight: true },
        ],
        activity: [{ agent: 'kora', verb: 'writing', path: 'src/ipc.ts' }, { agent: 'zane', verb: 'reading', path: 'model.ts' }],
        unreported: ['mystery.ts'],
        changed: [{ who: 'kora', files: ['src/ipc.ts'] }, { who: '?', files: ['mystery.ts'] }],
    },
    tabs: ['src/ipc.ts'],
    open: { ok: true, path: 'src/ipc.ts', text: 'export const a = 1;\n', sha: 'sha_ipc_1' },
    pinned: false,
    onSelect: () => {},
    onCloseTab: () => {},
    onPin: () => {},
    onClose: () => {},
};
const render = (p: Partial<FilesPanelProps>) => renderToStaticMarkup(<FilesPanel {...base} {...p} />);

describe('FilesPanel', () => {
    it('one dot plus a count per touched file — never a dot per agent — violet in flight, green changed, neutral ? unreported', () => {
        // src opened, so its files are drawn (nothing is open by itself — core/files-tree-lazy.ts).
        const html = render({ expanded: ['src'] });
        expect(html).toContain('data-file-marker="src/db.ts" data-count="20" data-tone="changed"');
        expect(html).toContain('data-file-marker="src/ipc.ts" data-count="1" data-tone="writing"');
        expect(html).toContain('data-file-marker="mystery.ts" data-tone="unreported"');
        expect((html.match(/data-file-marker="src\/db\.ts"/g) ?? []).length).toBe(1);
        expect(html).not.toContain('data-file-marker="README.md"');
    });

    it('NOTHING OPENS BY ITSELF (the owner, 2026-10-19): with no folder open, only the top level is drawn (COUNTED); CONTROL: src open draws its files', () => {
        const closed = render({});
        expect(closed).toContain('data-react-fancy-virtual-list-rows="3"');
        expect(closed).not.toContain('data-react-fancy-virtual-row-id="src/db.ts"');
        expect(render({ expanded: ['src'] })).toContain('data-react-fancy-virtual-row-id="src/db.ts"');
    });

    it('the footer names who is touching what and how many changed; the Changes section is ABSENT when nothing changed', () => {
        const html = render({});
        expect(html).toMatch(/kora writing src\/ipc\.ts/);
        expect(html).toMatch(/zane reading model\.ts/);
        expect(html).toMatch(/3 changed in this workspace/);
        expect(html).toContain('data-changes');
        const quiet = render({ state: { files: [], activity: [], unreported: [], changed: null }, tabs: [], open: null });
        expect(quiet).not.toContain('data-changes');
        expect(quiet).not.toMatch(/changed in this workspace/);
        expect(quiet).toMatch(/No file open/);
    });

    it('an error renders in the tab body in words, never a blank editor; the open file renders in the viewer', () => {
        const html = render({ open: { ok: false, path: 'huge.bin', error: 'this file is 180 MB; Genie will not open it' }, tabs: ['huge.bin'] });
        expect(html).toContain('data-tab-error');
        expect(html).toMatch(/this file is 180 MB; Genie will not open it/);
        expect(render({})).toContain('data-fancy-code-editor'); // the editor itself (Tynn #840: no FileViewer wrapper for text)
    });

    it('before the tree is known, skeletons — not an empty tree', () => {
        const html = render({ tree: null, state: null, tabs: [], open: null });
        expect(html).toContain('data-files-skeleton');
        expect(html).not.toMatch(/No file open/);
    });

    it('header: the workspace chip, pin and close; the pin lamp reflects the dock', () => {
        expect(render({})).toContain('data-pin="off"');
        expect(render({ pinned: true })).toContain('data-pin="on"');
        expect(render({})).toContain('data-action="close-files"');
    });
});
