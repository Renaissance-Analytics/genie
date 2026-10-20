import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileMenuItems } from '../src/core/file-menu.js';
import { FilesHost } from '../src/main/files-host.js';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';

/**
 * RIGHT-CLICK A FILE (Tynn #841; the owner, 2026-10-20: "no context menu on the file in the tree or the tab either, there
 * should be just like genie 1 had. I should be able to right click and choose open in external editor"). A tree row and an
 * editor tab each get a menu: Open in external editor (the OS's own app for the file), Reveal in the file manager, Copy
 * path, Copy relative path; a tab also Close / Close others / Close all. The two that act on the HOST's screen are only
 * offered where this window IS the host (not a window driving another machine).
 */

describe('fileMenuItems — what each right-click offers', () => {
    const all = { external: true, reveal: true };

    it('a file in the tree', () => {
        expect(fileMenuItems('tree-file', all).map((i) => i.id)).toEqual(['open-external', 'reveal', '-', 'copy-path', 'copy-relative-path']);
    });

    it('a folder in the tree: reveal and copy (no external editor for a folder)', () => {
        expect(fileMenuItems('tree-folder', all).map((i) => i.id)).toEqual(['reveal', '-', 'copy-path', 'copy-relative-path']);
    });

    it('a tab', () => {
        expect(fileMenuItems('tab', all).map((i) => i.id)).toEqual(['open-external', 'reveal', '-', 'copy-path', 'copy-relative-path', '-', 'close', 'close-others', 'close-all']);
    });

    it('a window driving another host: nothing that acts on the host’s screen (CONTROL: copy still offered)', () => {
        const ids = fileMenuItems('tab', { external: false, reveal: false }).map((i) => i.id);
        expect(ids).not.toContain('open-external');
        expect(ids).not.toContain('reveal');
        expect(ids[0]).toBe('copy-path');
        expect(ids).toContain('close');
    });

    it('labels say what happens', () => {
        expect(fileMenuItems('tree-file', all).find((i) => i.id === 'open-external')?.label).toBe('Open in external editor');
    });
});

describe('the panel wires the menus', () => {
    const base: FilesPanelProps = {
        workspace: { id: 'tynn', name: 'tynn', path: '/w/tynn' },
        tree: [{ id: 'src/a.ts', label: 'a.ts', type: 'file', ext: 'ts' }],
        state: { files: [], activity: [], unreported: [], changed: null },
        tabs: ['src/a.ts', 'README.md'],
        open: { ok: true, path: 'src/a.ts', text: 'x', sha: 's' },
        pinned: false,
        onSelect: () => {}, onCloseTab: () => {}, onPin: () => {}, onClose: () => {},
    };

    it('the tree and every tab are right-click targets when file actions are wired', () => {
        const html = renderToStaticMarkup(<FilesPanel {...base} fileActions={{ onAction: () => {}, external: true, reveal: true }} />);
        expect(html).toContain('data-file-menu="tree"');
        expect(html).toMatch(/data-file-menu="tab"[^]*data-file-tab="src\/a.ts"|data-file-tab="src\/a.ts"[^]*data-file-menu="tab"/);
        expect((html.match(/data-file-menu="tab"/g) ?? []).length).toBe(2);
    });

    it('without file actions, no menus (CONTROL)', () => {
        expect(renderToStaticMarkup(<FilesPanel {...base} />)).not.toContain('data-file-menu');
    });
});

describe('FilesHost.absolute — the host path a menu acts on, confined to the workspace', () => {
    let root: string;
    let host: FilesHost;
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'genie2-file-menu-'));
        await mkdir(join(root, 'src'));
        await writeFile(join(root, 'src', 'a.ts'), 'x');
        host = new FilesHost({ workspace: (id: string) => (id === 'tynn' ? { id: 'tynn', path: root } : null), agentsOf: () => [], eventsOf: () => [] } as never);
    });
    afterEach(async () => { await rm(root, { recursive: true, force: true }); });

    it('a file in the workspace → its absolute path', () => {
        expect(host.absolute('tynn', 'src/a.ts')).toBe(join(root, 'src', 'a.ts'));
    });

    it('outside the workspace, or an unknown workspace → null (nothing is opened or revealed)', () => {
        expect(host.absolute('tynn', '../../etc/passwd')).toBeNull();
        expect(host.absolute('nope', 'src/a.ts')).toBeNull();
    });
});
