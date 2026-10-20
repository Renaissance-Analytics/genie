import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileMenuItems } from '../src/core/file-menu.js';
import { copyName, createIn, fileOpDialog, nameProblem, tabsAfterDelete, tabsAfterRename } from '../src/core/file-ops.js';
import { FilesHost } from '../src/main/files-host.js';
import { FileOpForm } from '../src/renderer/components/FileOpModal.js';

/**
 * THE TREE'S FILE OPERATIONS (Tynn #844; Genie 1's FileTree menu): right-click a row for New file, New folder, Rename,
 * Duplicate and Delete. Delete moves to the OS trash rather than erasing (Genie 1 erased, "This cannot be undone").
 * New file/folder go INSIDE a folder, BESIDE a file, or at the root from empty space. Nothing overwrites: a name that
 * is taken is refused in words, a duplicate picks the first free `-copy` name, and every path stays inside the workspace.
 */

const exists = (p: string) => access(p).then(() => true, () => false);

describe('fileMenuItems with file operations', () => {
    const edit = { external: true, reveal: true, edit: true };
    const ids = (t: Parameters<typeof fileMenuItems>[0], a = edit) => fileMenuItems(t, a).map((i) => i.id);

    it('a file: new beside it, then open/reveal, copy, then rename, duplicate, delete', () => {
        expect(ids('tree-file')).toEqual(['new-file', 'new-folder', '-', 'open-external', 'reveal', '-', 'copy-path', 'copy-relative-path', '-', 'rename', 'duplicate', 'delete']);
    });

    it('a folder: no duplicate (Genie 1: file-only), no external editor', () => {
        expect(ids('tree-folder')).toEqual(['new-file', 'new-folder', '-', 'reveal', '-', 'copy-path', 'copy-relative-path', '-', 'rename', 'delete']);
    });

    it('empty space in the tree: create at the root only', () => {
        expect(ids('tree-root')).toEqual(['new-file', 'new-folder']);
    });

    it('a tab gets no file operations; without `edit` the menus are as before (CONTROL)', () => {
        expect(ids('tab')).not.toContain('delete');
        expect(ids('tree-file', { external: true, reveal: true, edit: false })).toEqual(['open-external', 'reveal', '-', 'copy-path', 'copy-relative-path']);
        expect(ids('tree-root', { external: true, reveal: true, edit: false })).toEqual([]);
    });

    it('labels', () => {
        const label = (id: string) => fileMenuItems('tree-file', edit).find((i) => i.id === id)?.label;
        expect([label('new-file'), label('new-folder'), label('rename'), label('duplicate'), label('delete')]).toEqual(['New file', 'New folder', 'Rename', 'Duplicate', 'Delete']);
    });
});

describe('the pure rules', () => {
    it('createIn: inside a folder, beside a file, at the root', () => {
        expect(createIn('src/lib', 'tree-folder')).toBe('src/lib');
        expect(createIn('src/lib/a.ts', 'tree-file')).toBe('src/lib');
        expect(createIn('README.md', 'tree-file')).toBe('');
        expect(createIn('', 'tree-root')).toBe('');
    });

    it('nameProblem: one name, not a path (CONTROL: a dotfile and spaces are fine)', () => {
        expect(nameProblem('')).toBe('Give it a name');
        expect(nameProblem('   ')).toBe('Give it a name');
        expect(nameProblem('a/b.ts')).toBe('A name cannot contain / or \\');
        expect(nameProblem('a\\b.ts')).toBe('A name cannot contain / or \\');
        expect(nameProblem('..')).toBe('“..” is not a name');
        expect(nameProblem('.')).toBe('“.” is not a name');
        expect(nameProblem('.env.local')).toBeNull();
        expect(nameProblem('my notes.md')).toBeNull();
    });

    it('copyName: the suffix goes before the extension (Genie 1)', () => {
        expect(copyName('foo.txt', 1)).toBe('foo-copy.txt');
        expect(copyName('foo.txt', 2)).toBe('foo-copy-2.txt');
        expect(copyName('Makefile', 1)).toBe('Makefile-copy');
        expect(copyName('.gitignore', 1)).toBe('.gitignore-copy');
    });

    it('tabs follow a rename — the file, or everything under a renamed folder (CONTROL: a sibling with the same prefix stays)', () => {
        expect(tabsAfterRename(['src/a.ts', 'README.md'], 'src/a.ts', 'src/b.ts')).toEqual(['src/b.ts', 'README.md']);
        expect(tabsAfterRename(['src/a.ts', 'src2/x.ts'], 'src', 'lib')).toEqual(['lib/a.ts', 'src2/x.ts']);
    });

    it('tabs close with a delete — the file, or everything under a folder (CONTROL: a same-prefix sibling stays)', () => {
        expect(tabsAfterDelete(['src/a.ts', 'src2/x.ts', 'README.md'], 'src')).toEqual(['src2/x.ts', 'README.md']);
        expect(tabsAfterDelete(['src/a.ts', 'README.md'], 'README.md')).toEqual(['src/a.ts']);
    });

    it('the dialogs say what will happen, and Delete says where it goes', () => {
        expect(fileOpDialog('new-file', { path: 'src', type: 'folder' })).toMatchObject({ title: 'New file in src', confirmLabel: 'Create', input: '' });
        expect(fileOpDialog('new-folder', { path: '', type: 'root' })).toMatchObject({ title: 'New folder in the workspace', confirmLabel: 'Create' });
        expect(fileOpDialog('rename', { path: 'src/a.ts', type: 'file' })).toMatchObject({ title: 'Rename a.ts', confirmLabel: 'Rename', input: 'a.ts' });
        expect(fileOpDialog('delete', { path: 'src', type: 'folder' })).toMatchObject({ title: 'Delete src', confirmLabel: 'Move to trash', body: 'src and everything in it go to the trash.', input: null });
        expect(fileOpDialog('delete', { path: 'src/a.ts', type: 'file' })).toMatchObject({ body: 'a.ts goes to the trash.' });
    });
});

describe('FilesHost file operations over a real folder', () => {
    let root: string;
    let host: FilesHost;
    const trashed: string[] = [];
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'genie2-tree-ops-'));
        await mkdir(join(root, 'src'));
        await writeFile(join(root, 'src', 'a.ts'), 'A');
        await writeFile(join(root, 'README.md'), '# hi');
        trashed.length = 0;
        host = new FilesHost({
            workspace: (id: string) => (id === 'tynn' ? { id: 'tynn', path: root } : null),
            agentsOf: () => [],
            eventsOf: () => [],
            trash: async (abs: string) => { trashed.push(abs); await rm(abs, { recursive: true, force: true }); },
        });
    });
    afterEach(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });

    it('creates an empty file and a folder', async () => {
        expect(await host.create('tynn', 'src/b.ts', 'file')).toEqual({ ok: true, path: 'src/b.ts' });
        expect(await readFile(join(root, 'src', 'b.ts'), 'utf8')).toBe('');
        expect(await host.create('tynn', 'docs', 'folder')).toEqual({ ok: true, path: 'docs' });
        expect(await exists(join(root, 'docs'))).toBe(true);
    });

    it('never overwrites: a taken name is refused in words and the file is untouched', async () => {
        expect(await host.create('tynn', 'src/a.ts', 'file')).toEqual({ ok: false, reason: 'src/a.ts already exists' });
        expect(await host.create('tynn', 'src', 'folder')).toEqual({ ok: false, reason: 'src already exists' });
        expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toBe('A');
    });

    it('renames a file and a folder; refuses a taken name (CONTROL: both files intact)', async () => {
        expect(await host.rename('tynn', 'src/a.ts', 'src/c.ts')).toEqual({ ok: true, path: 'src/c.ts' });
        expect(await readFile(join(root, 'src', 'c.ts'), 'utf8')).toBe('A');
        expect(await host.rename('tynn', 'src', 'lib')).toEqual({ ok: true, path: 'lib' });
        expect(await exists(join(root, 'lib', 'c.ts'))).toBe(true);
        expect(await host.rename('tynn', 'README.md', 'lib/c.ts')).toEqual({ ok: false, reason: 'lib/c.ts already exists' });
        expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('# hi');
    });

    it('duplicates a file to the first free -copy name; a folder is refused', async () => {
        expect(await host.duplicate('tynn', 'src/a.ts')).toEqual({ ok: true, path: 'src/a-copy.ts' });
        expect(await host.duplicate('tynn', 'src/a.ts')).toEqual({ ok: true, path: 'src/a-copy-2.ts' });
        expect(await readFile(join(root, 'src', 'a-copy-2.ts'), 'utf8')).toBe('A');
        expect(await host.duplicate('tynn', 'src')).toEqual({ ok: false, reason: 'only a file can be duplicated' });
    });

    it('delete hands the HOST path to the trash port — nothing is erased by Genie itself', async () => {
        expect(await host.trash('tynn', 'src')).toEqual({ ok: true, path: 'src' });
        expect(trashed).toEqual([join(root, 'src')]);
        expect(await exists(join(root, 'src'))).toBe(false);
    });

    it('without a trash port nothing is deleted (CONTROL: the file is still there)', async () => {
        const bare = new FilesHost({ workspace: () => ({ id: 'tynn', path: root }), agentsOf: () => [], eventsOf: () => [] });
        expect(await bare.trash('tynn', 'README.md')).toEqual({ ok: false, reason: 'this Genie cannot move files to the trash' });
        expect(await exists(join(root, 'README.md'))).toBe(true);
        await bare.close();
    });

    it('every operation stays inside the workspace, and the workspace itself is never a target', async () => {
        const outside = { ok: false, reason: 'that path is outside the workspace; Genie changes nothing there' };
        expect(await host.create('tynn', '../evil.ts', 'file')).toEqual(outside);
        expect(await host.rename('tynn', 'README.md', '../README.md')).toEqual(outside);
        expect(await host.rename('tynn', '../x', 'y')).toEqual(outside);
        expect(await host.duplicate('tynn', '../x')).toEqual(outside);
        expect(await host.trash('tynn', '')).toEqual(outside);
        expect(await host.trash('tynn', '..')).toEqual(outside);
        expect(trashed).toEqual([]);
        expect(await host.create('nope', 'a.ts', 'file')).toEqual({ ok: false, reason: 'no such workspace' });
    });
});

describe('FileOpForm (the dialog’s body; Fancy’s Modal does not render on the server)', () => {
    it('a name dialog: the input, filled for a rename, and the confirm label', () => {
        const html = renderToStaticMarkup(<FileOpForm dialog={fileOpDialog('rename', { path: 'src/a.ts', type: 'file' })} error={null} onConfirm={() => {}} onCancel={() => {}} />);
        expect(html).toContain('data-file-op="rename"');
        expect(html).toContain('value="a.ts"');
        expect(html).toContain('Rename');
    });

    it('delete: no input, says where it goes, and shows a refusal when there is one', () => {
        const html = renderToStaticMarkup(<FileOpForm dialog={fileOpDialog('delete', { path: 'src/a.ts', type: 'file' })} error="the trash is full" onConfirm={() => {}} onCancel={() => {}} />);
        expect(html).toContain('a.ts goes to the trash.');
        expect(html).not.toContain('<input');
        expect(html).toContain('Move to trash');
        expect(html).toContain('the trash is full');
    });
});
