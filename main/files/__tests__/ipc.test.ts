import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listTree, readFile, writeFile, type TreeNodeData } from '../ipc';
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
