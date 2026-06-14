import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
    createFile,
    createFolder,
    deletePath,
    duplicatePath,
    listTree,
    readFile,
    renamePath,
    writeFile,
    type TreeNodeData,
} from '../ipc';
import { cleanupTmpRoot, makeTmpDir } from '../../../test/helpers';

afterAll(() => cleanupTmpRoot());

/** Flatten a tree's ids for easy membership assertions. */
function ids(nodes: TreeNodeData[]): string[] {
    const out: string[] = [];
    const walk = (ns: TreeNodeData[]) => {
        for (const n of ns) {
            out.push(n.id);
            if (n.children) walk(n.children);
        }
    };
    walk(nodes);
    return out;
}

const NUL = String.fromCharCode(0);

describe('files:list-tree', () => {
    it('skips ignored + regenerable dirs and lists folders before files', async () => {
        const dir = makeTmpDir('ft-ignore');
        fs.mkdirSync(path.join(dir, 'src'));
        fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export {}');
        fs.writeFileSync(path.join(dir, 'README.md'), '# hi');
        // These must NOT appear (SKIP_NAMES / REGENERABLE_NAMES).
        fs.mkdirSync(path.join(dir, 'node_modules'));
        fs.writeFileSync(path.join(dir, 'node_modules', 'pkg.js'), '');
        fs.mkdirSync(path.join(dir, '.git'));
        fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: x');
        fs.mkdirSync(path.join(dir, 'dist'));

        const tree = await listTree(dir);
        const all = ids(tree);

        expect(all).toContain('src');
        expect(all).toContain('src/index.ts');
        expect(all).toContain('README.md');
        expect(all.some((i) => i.includes('node_modules'))).toBe(false);
        expect(all.some((i) => i.includes('.git'))).toBe(false);
        expect(all).not.toContain('dist');

        // Folders sort before files at the top level.
        expect(tree[0].type).toBe('folder');
        expect(tree[tree.length - 1].type).toBe('file');
    });

    it('honours the depth cap', async () => {
        const dir = makeTmpDir('ft-depth');
        // Build a/b/c/d/e/f/g — deeper than the maxDepth we pass.
        let p = dir;
        for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
            p = path.join(p, name);
            fs.mkdirSync(p);
        }
        const tree = await listTree(dir, { maxDepth: 2 });
        const all = ids(tree);
        // depth 0 lists 'a', depth1 'a/b', depth2 'a/b/c'; 'a/b/c/d' is beyond.
        expect(all).toContain('a/b/c');
        expect(all).not.toContain('a/b/c/d');
    });

    it('honours the entry cap', async () => {
        const dir = makeTmpDir('ft-entries');
        for (let i = 0; i < 50; i++) {
            fs.writeFileSync(path.join(dir, `f${i}.txt`), '');
        }
        const tree = await listTree(dir, { maxEntries: 10 });
        expect(ids(tree).length).toBe(10);
    });
});

describe('files:read path-guard', () => {
    it('reads a file inside the workspace', async () => {
        const dir = makeTmpDir('fr-ok');
        fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
        const r = await readFile(dir, 'a.txt');
        expect(r.content).toBe('hello');
        expect(r.truncated).toBe(false);
    });

    it('rejects a `..` traversal out of the workspace', async () => {
        const dir = makeTmpDir('fr-dotdot');
        const sibling = makeTmpDir('fr-secret');
        fs.writeFileSync(path.join(sibling, 'secret.txt'), 'nope');
        const rel = path.relative(dir, path.join(sibling, 'secret.txt'));
        await expect(readFile(dir, rel)).rejects.toThrow(/escapes workspace/);
    });

    it('rejects an absolute path', async () => {
        const dir = makeTmpDir('fr-abs');
        const other = makeTmpDir('fr-abs-target');
        const abs = path.join(other, 'x.txt');
        fs.writeFileSync(abs, 'x');
        await expect(readFile(dir, abs)).rejects.toThrow(/escapes workspace/);
    });

    it('rejects a binary (NUL-containing) file', async () => {
        const dir = makeTmpDir('fr-bin');
        fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([0x41, 0x00, 0x42]));
        await expect(readFile(dir, 'b.bin')).rejects.toThrow(/Binary/);
    });
});

describe('files:write path-guard', () => {
    it('writes a file inside the workspace', async () => {
        const dir = makeTmpDir('fw-ok');
        const r = await writeFile(dir, 'out.txt', 'written');
        expect(r.ok).toBe(true);
        expect(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('written');
    });

    it('rejects writing outside the workspace via `..`', async () => {
        const dir = makeTmpDir('fw-dotdot');
        const sibling = makeTmpDir('fw-target');
        const rel = path.relative(dir, path.join(sibling, 'pwned.txt'));
        await expect(writeFile(dir, rel, 'x')).rejects.toThrow(/escapes workspace/);
        expect(fs.existsSync(path.join(sibling, 'pwned.txt'))).toBe(false);
    });

    it('rejects an absolute write target', async () => {
        const dir = makeTmpDir('fw-abs');
        const other = makeTmpDir('fw-abs-target');
        const abs = path.join(other, 'evil.txt');
        await expect(writeFile(dir, abs, 'x')).rejects.toThrow(/escapes workspace/);
    });

    it('rejects content containing NUL bytes (binary guard)', async () => {
        const dir = makeTmpDir('fw-nul');
        await expect(
            writeFile(dir, 'b.txt', `ok${NUL}bad`),
        ).rejects.toThrow(/binary/i);
    });
});

describe('files:list-tree locked root', () => {
    it('roots the walk at a workspace-relative subfolder, keeping ids workspace-relative', async () => {
        const dir = makeTmpDir('lt-root');
        fs.mkdirSync(path.join(dir, 'repos', 'genie', 'src'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'repos', 'genie', 'src', 'a.ts'), 'export {}');
        fs.writeFileSync(path.join(dir, 'top.txt'), 'top');

        const tree = await listTree(dir, { root: 'repos/genie' });
        const all = ids(tree);
        // Ids stay relative to the WORKSPACE root, not the subroot.
        expect(all).toContain('repos/genie/src');
        expect(all).toContain('repos/genie/src/a.ts');
        // Anything outside the locked root is not walked.
        expect(all).not.toContain('top.txt');
    });

    it('rejects a locked root that escapes the workspace', async () => {
        const dir = makeTmpDir('lt-escape');
        await expect(listTree(dir, { root: '../..' })).rejects.toThrow(
            /escapes workspace/,
        );
    });
});

describe('files:create-file path-guard', () => {
    it('creates an empty file inside the workspace', async () => {
        const dir = makeTmpDir('cf-ok');
        const r = await createFile(dir, 'src/new.ts');
        expect(r.ok).toBe(true);
        expect(fs.existsSync(path.join(dir, 'src', 'new.ts'))).toBe(true);
        expect(fs.readFileSync(path.join(dir, 'src', 'new.ts'), 'utf8')).toBe('');
    });

    it('fails if the file already exists', async () => {
        const dir = makeTmpDir('cf-exists');
        fs.writeFileSync(path.join(dir, 'there.txt'), 'x');
        await expect(createFile(dir, 'there.txt')).rejects.toThrow(/already exists/i);
    });

    it('rejects a `..` traversal out of the workspace', async () => {
        const dir = makeTmpDir('cf-dotdot');
        const sibling = makeTmpDir('cf-target');
        const rel = path.relative(dir, path.join(sibling, 'pwned.txt'));
        await expect(createFile(dir, rel)).rejects.toThrow(/escapes workspace/);
        expect(fs.existsSync(path.join(sibling, 'pwned.txt'))).toBe(false);
    });

    it('rejects an absolute create target', async () => {
        const dir = makeTmpDir('cf-abs');
        const other = makeTmpDir('cf-abs-target');
        const abs = path.join(other, 'evil.txt');
        await expect(createFile(dir, abs)).rejects.toThrow(/escapes workspace/);
        expect(fs.existsSync(abs)).toBe(false);
    });

    it('refuses to create the workspace root itself', async () => {
        const dir = makeTmpDir('cf-root');
        await expect(createFile(dir, '.')).rejects.toThrow(/Invalid path/);
    });
});

describe('files:create-folder path-guard', () => {
    it('creates a folder (recursively) inside the workspace', async () => {
        const dir = makeTmpDir('cd-ok');
        const r = await createFolder(dir, 'a/b/c');
        expect(r.ok).toBe(true);
        expect(fs.statSync(path.join(dir, 'a', 'b', 'c')).isDirectory()).toBe(true);
    });

    it('rejects a `..` traversal out of the workspace', async () => {
        const dir = makeTmpDir('cd-dotdot');
        const sibling = makeTmpDir('cd-target');
        const rel = path.relative(dir, path.join(sibling, 'pwned'));
        await expect(createFolder(dir, rel)).rejects.toThrow(/escapes workspace/);
        expect(fs.existsSync(path.join(sibling, 'pwned'))).toBe(false);
    });
});

describe('files:rename path-guard', () => {
    it('renames a file inside the workspace', async () => {
        const dir = makeTmpDir('rn-ok');
        fs.writeFileSync(path.join(dir, 'old.txt'), 'data');
        const r = await renamePath(dir, 'old.txt', 'sub/new.txt');
        expect(r.ok).toBe(true);
        expect(fs.existsSync(path.join(dir, 'old.txt'))).toBe(false);
        expect(fs.readFileSync(path.join(dir, 'sub', 'new.txt'), 'utf8')).toBe('data');
    });

    it('refuses to clobber an existing destination', async () => {
        const dir = makeTmpDir('rn-clobber');
        fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
        fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
        await expect(renamePath(dir, 'a.txt', 'b.txt')).rejects.toThrow(
            /already exists/i,
        );
        // Both untouched.
        expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('a');
        expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('b');
    });

    it('rejects a destination that escapes the workspace', async () => {
        const dir = makeTmpDir('rn-escape');
        const sibling = makeTmpDir('rn-target');
        fs.writeFileSync(path.join(dir, 'src.txt'), 'x');
        const rel = path.relative(dir, path.join(sibling, 'out.txt'));
        await expect(renamePath(dir, 'src.txt', rel)).rejects.toThrow(
            /escapes workspace/,
        );
        expect(fs.existsSync(path.join(sibling, 'out.txt'))).toBe(false);
    });

    it('rejects a source that escapes the workspace', async () => {
        const dir = makeTmpDir('rn-escape-src');
        const sibling = makeTmpDir('rn-src-target');
        fs.writeFileSync(path.join(sibling, 'secret.txt'), 'no');
        const rel = path.relative(dir, path.join(sibling, 'secret.txt'));
        await expect(renamePath(dir, rel, 'here.txt')).rejects.toThrow(
            /escapes workspace/,
        );
    });
});

describe('files:delete path-guard', () => {
    it('deletes a file inside the workspace', async () => {
        const dir = makeTmpDir('dl-file');
        fs.writeFileSync(path.join(dir, 'gone.txt'), 'x');
        const r = await deletePath(dir, 'gone.txt');
        expect(r.ok).toBe(true);
        expect(fs.existsSync(path.join(dir, 'gone.txt'))).toBe(false);
    });

    it('deletes a folder recursively', async () => {
        const dir = makeTmpDir('dl-folder');
        fs.mkdirSync(path.join(dir, 'pkg', 'nested'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'pkg', 'a.txt'), 'a');
        fs.writeFileSync(path.join(dir, 'pkg', 'nested', 'b.txt'), 'b');
        const r = await deletePath(dir, 'pkg');
        expect(r.ok).toBe(true);
        expect(fs.existsSync(path.join(dir, 'pkg'))).toBe(false);
    });

    it('rejects a `..` traversal out of the workspace', async () => {
        const dir = makeTmpDir('dl-dotdot');
        const sibling = makeTmpDir('dl-target');
        fs.writeFileSync(path.join(sibling, 'keep.txt'), 'keep');
        const rel = path.relative(dir, path.join(sibling, 'keep.txt'));
        await expect(deletePath(dir, rel)).rejects.toThrow(/escapes workspace/);
        expect(fs.existsSync(path.join(sibling, 'keep.txt'))).toBe(true);
    });

    it('refuses to delete the workspace root itself', async () => {
        const dir = makeTmpDir('dl-root');
        await expect(deletePath(dir, '.')).rejects.toThrow(/Invalid path/);
        expect(fs.existsSync(dir)).toBe(true);
    });
});

describe('files:duplicate', () => {
    it('copies a file to a -copy sibling and returns the new path', async () => {
        const dir = makeTmpDir('dup-basic');
        fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
        const r = await duplicatePath(dir, 'notes.txt');
        expect(r.ok).toBe(true);
        expect(r.relPath).toBe('notes-copy.txt');
        expect(fs.readFileSync(path.join(dir, 'notes-copy.txt'), 'utf8')).toBe('hello');
        // Original is untouched.
        expect(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8')).toBe('hello');
    });

    it('inserts -copy before the extension and keeps the folder', async () => {
        const dir = makeTmpDir('dup-sub');
        fs.mkdirSync(path.join(dir, 'src'));
        fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'x');
        const r = await duplicatePath(dir, 'src/index.ts');
        expect(r.relPath).toBe('src/index-copy.ts');
        expect(fs.existsSync(path.join(dir, 'src', 'index-copy.ts'))).toBe(true);
    });

    it('disambiguates with -copy-N when a copy already exists', async () => {
        const dir = makeTmpDir('dup-collide');
        fs.writeFileSync(path.join(dir, 'a.txt'), '1');
        fs.writeFileSync(path.join(dir, 'a-copy.txt'), 'existing');
        const r = await duplicatePath(dir, 'a.txt');
        expect(r.relPath).toBe('a-copy-2.txt');
        // The pre-existing copy is never clobbered.
        expect(fs.readFileSync(path.join(dir, 'a-copy.txt'), 'utf8')).toBe('existing');
    });

    it('appends -copy when the file has no extension', async () => {
        const dir = makeTmpDir('dup-noext');
        fs.writeFileSync(path.join(dir, 'Makefile'), 'all:');
        const r = await duplicatePath(dir, 'Makefile');
        expect(r.relPath).toBe('Makefile-copy');
    });

    it('refuses to duplicate a folder', async () => {
        const dir = makeTmpDir('dup-folder');
        fs.mkdirSync(path.join(dir, 'pkg'));
        await expect(duplicatePath(dir, 'pkg')).rejects.toThrow(/Not a file/);
    });

    it('rejects a source that escapes the workspace', async () => {
        const dir = makeTmpDir('dup-dotdot');
        const sibling = makeTmpDir('dup-target');
        fs.writeFileSync(path.join(sibling, 'secret.txt'), 's');
        const rel = path.relative(dir, path.join(sibling, 'secret.txt'));
        await expect(duplicatePath(dir, rel)).rejects.toThrow(/escapes workspace/);
    });

    it('refuses to duplicate the workspace root', async () => {
        const dir = makeTmpDir('dup-root');
        await expect(duplicatePath(dir, '.')).rejects.toThrow(/Invalid path/);
    });
});
