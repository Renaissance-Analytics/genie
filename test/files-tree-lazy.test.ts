import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { revealFor, treeFromLoaded } from '../src/core/files-tree-lazy.js';
import type { TreeNode } from '../src/core/files-panel.js';
import { FilesHost } from '../src/main/files-host.js';

/**
 * THE FILE TREE LOADS A FOLDER WHEN IT IS OPENED (the owner, 2026-10-19: "I can't load files below the 3rd layer and
 * when it opens all folders are open at once. it should not be like that at all"). The tree was ONE eager breadth-first
 * walk with an entry budget, so on a big workspace the budget ran out a few levels down and deeper folders were never
 * listed — and Fancy's TreeNav was told to expand everything. Now the host lists ONE folder's direct children on
 * demand (no depth limit: a folder ten levels down is one more call), the panel nests only what has been loaded, opens
 * nothing by itself, and a file named by the route opens its folders.
 */

let root: string;
let host: FilesHost;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie2-lazy-'));
    // Ten levels deep — deeper than any budget-and-depth walk reached.
    const deep = join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j');
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, 'deep.ts'), 'x');
    await writeFile(join(root, 'README.md'), '# hi');
    await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
    await mkdir(join(root, '.git'), { recursive: true });
    host = new FilesHost({ workspace: (id) => (id === 'ws' ? { id: 'ws', path: root } : null), agentsOf: () => [], eventsOf: () => [] });
});
afterEach(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
});

describe('FilesHost.children — one folder, on demand', () => {
    it('the root: its direct entries only, folders first, never .git or node_modules; a folder carries no children yet', async () => {
        const top = await host.children('ws', '');
        expect(top).toEqual([
            { id: 'a', label: 'a', type: 'folder' },
            { id: 'README.md', label: 'README.md', type: 'file', ext: 'md' },
        ]);
    });

    it('NO DEPTH LIMIT: ten levels down is reached one folder at a time (COUNTED: the file is found at the end)', async () => {
        let dir = '';
        for (const part of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
            const listed = await host.children('ws', dir);
            dir = dir ? `${dir}/${part}` : part;
            expect(listed?.map((n) => n.id)).toContain(dir);
        }
        expect(await host.children('ws', dir)).toEqual([{ id: `${dir}/deep.ts`, label: 'deep.ts', type: 'file', ext: 'ts' }]);
    });

    it('a folder outside the workspace, or an unknown workspace, is refused (null) — nothing is listed there', async () => {
        expect(await host.children('ws', '../')).toBeNull();
        expect(await host.children('ws', '../../etc')).toBeNull();
        expect(await host.children('nope', '')).toBeNull();
    });
});

describe('treeFromLoaded — only what has been opened is nested', () => {
    const loaded = new Map<string, readonly TreeNode[]>([
        ['', [{ id: 'a', label: 'a', type: 'folder' }, { id: 'z', label: 'z', type: 'folder' }, { id: 'README.md', label: 'README.md', type: 'file', ext: 'md' }]],
        ['a', [{ id: 'a/b', label: 'b', type: 'folder' }, { id: 'a/x.ts', label: 'x.ts', type: 'file', ext: 'ts' }]],
    ]);

    it('a loaded folder carries its children; one never opened is a folder with none yet (it still shows as a folder)', () => {
        const tree = treeFromLoaded(loaded)!;
        expect(tree.map((n) => n.id)).toEqual(['a', 'z', 'README.md']);
        expect(tree[0]!.children?.map((n) => n.id)).toEqual(['a/b', 'a/x.ts']);
        expect(tree[0]!.children?.[0]).toEqual({ id: 'a/b', label: 'b', type: 'folder' });
        expect(tree[1]).toEqual({ id: 'z', label: 'z', type: 'folder' });
    });

    it('nothing loaded yet: no tree (null), not an empty one', () => {
        expect(treeFromLoaded(new Map())).toBeNull();
    });
});

describe('revealFor — a file named by the route opens its folders, and nothing else', () => {
    it("the file's ancestors join what is open; what was open stays open", () => {
        expect(revealFor('a/b/c/x.ts', ['z'])).toEqual(['z', 'a', 'a/b', 'a/b/c']);
    });

    it('a file at the root opens nothing; no file opens nothing', () => {
        expect(revealFor('README.md', [])).toEqual([]);
        expect(revealFor(null, ['z'])).toEqual(['z']);
    });

    it('an ancestor already open is not added twice', () => {
        expect(revealFor('a/b/x.ts', ['a'])).toEqual(['a', 'a/b']);
    });
});
