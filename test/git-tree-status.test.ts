import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitTreeStatus } from '../src/main/git-ports.js';

/**
 * GIT'S STATE OF EVERY CHANGED FILE, FOR THE TREE (beta.33 item 15; Genie 1 FileTree coloured rows by `files.gitStatus`).
 * One `git status` for the workspace, against a REAL git: paths relative to the WORKSPACE (which may sit inside a larger
 * repository), modified / added / deleted / untracked. A folder that is not a repository is an empty map — "nothing to show".
 */

const run = promisify(execFile);
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-git-tree-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const commitAll = async (repo: string) => {
    await run('git', ['-C', repo, 'add', '-A']);
    await run('git', ['-C', repo, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'c']);
};

describe('gitTreeStatus', () => {
    it('names each changed file by its state, relative to the workspace', async () => {
        await run('git', ['init', '--quiet', '--initial-branch=main', dir]);
        await mkdir(join(dir, 'src'), { recursive: true });
        await writeFile(join(dir, 'src', 'a.ts'), 'a\n');
        await writeFile(join(dir, 'gone.ts'), 'g\n');
        await writeFile(join(dir, 'same.ts'), 's\n');
        await commitAll(dir);
        await writeFile(join(dir, 'src', 'a.ts'), 'a2\n');
        await unlink(join(dir, 'gone.ts'));
        await writeFile(join(dir, 'new file.ts'), 'n\n');
        await writeFile(join(dir, 'staged.ts'), 'st\n');
        await run('git', ['-C', dir, 'add', 'staged.ts']);
        expect(await gitTreeStatus(dir)).toEqual({ 'src/a.ts': 'modified', 'gone.ts': 'deleted', 'new file.ts': 'untracked', 'staged.ts': 'added' });
    });

    it('a workspace INSIDE a repository: its own files, relative to itself; the rest of the repo is not its business', async () => {
        await run('git', ['init', '--quiet', '--initial-branch=main', dir]);
        await mkdir(join(dir, 'ws', 'src'), { recursive: true });
        await writeFile(join(dir, 'ws', 'src', 'x.ts'), 'x\n');
        await writeFile(join(dir, 'outside.ts'), 'o\n');
        await commitAll(dir);
        await writeFile(join(dir, 'ws', 'src', 'x.ts'), 'x2\n');
        await writeFile(join(dir, 'outside.ts'), 'o2\n');
        expect(await gitTreeStatus(join(dir, 'ws'))).toEqual({ 'src/x.ts': 'modified' });
    });

    it('not a repository: an empty map, not an error', async () => {
        await writeFile(join(dir, 'a.ts'), 'a\n');
        expect(await gitTreeStatus(dir)).toEqual({});
    });
});
