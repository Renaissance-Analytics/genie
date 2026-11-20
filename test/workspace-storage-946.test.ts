import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { suggestedCleanup } from '../src/core/workspace-storage.js';
import { runCommand } from './helpers/command-report.js';
import { WorkspaceStorage } from '../src/main/workspace-storage-host.js';

/**
 * CLEAN UP'S LIST SAYS WHAT EACH ITEM IS, LISTS IT ONCE, AND NEVER OFFERS A WORKTREE IN USE (Tynn #946). The owner, afraid to
 * press anything: "why would repos be in this list?" — `repos/genie2-vm · 11.5 MB` twice. It was a clean, detached
 * worktree of another repository that happened to sit in `repos/`: Genie took it for a repository (its `.git` is a file),
 * asked git there for "its" worktrees, and git, asked from inside a linked worktree, lists the whole family including that
 * worktree itself. So it was listed once per repository. Pinned here, on real git:
 *  - a linked worktree inside `repos/` is never a repository, and is listed ONCE, as a worktree of the repository it
 *    belongs to, with that repository, its branch and its commit;
 *  - no two items share a path;
 *  - a worktree a terminal, a process or an agent is working in, or one git is working in (its index.lock), is never
 *    offered: it says so, and Move to .trash and the one-click clean-up refuse it.
 */
const run = (file: string, args: readonly string[]) => runCommand(file, args, { timeoutMs: 90_000 });
const git = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args]);
const LATER = Date.now() + 3 * 24 * 60 * 60 * 1000;

let root: string;
let outside: string;
let app: string;
let storage: WorkspaceStorage;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie-946-ws-'));
    outside = await mkdtemp(join(tmpdir(), 'genie-946-out-'));
    const remote = join(outside, 'remote.git');
    await run('git', ['init', '--bare', '--quiet', remote]);
    app = join(root, 'repos', 'app');
    await mkdir(app, { recursive: true });
    await git(app, 'init', '--quiet');
    await writeFile(join(app, 'README.md'), 'hello\n');
    await git(app, 'add', '.');
    await git(app, 'commit', '--quiet', '-m', 'first');
    await git(app, 'remote', 'add', 'origin', remote);
    await git(app, 'push', '--quiet', 'origin', 'main');
    // The owner's repos/genie2-vm: a clean, detached worktree of a repository, sitting in repos/.
    await git(app, 'worktree', 'add', '--quiet', '--detach', join(root, 'repos', 'app-vm'));
    // Two more, outside repos/: one a terminal is working in, one git is working in.
    await git(app, 'worktree', 'add', '--quiet', '-b', 'wt-term', join(root, 'wt', 'term'));
    await git(app, 'worktree', 'add', '--quiet', '-b', 'wt-git', join(root, 'wt', 'git'));
    storage = new WorkspaceStorage({ now: () => LATER });
});

afterEach(async () => {
    for (const dir of [root, outside]) await rm(dir, { recursive: true, force: true });
});

describe('a worktree inside repos/ (the owner’s repos/genie2-vm)', () => {
    it('is never a repository; it is listed once, as a worktree of repos/app, detached at its commit', async () => {
        const r = await storage.measure(root, { chatFiles: [] });
        expect(r.items.filter((i) => i.category === 'repos').map((i) => i.rel)).toEqual(['repos/app']);
        const vm = r.items.filter((i) => i.rel === 'repos/app-vm');
        expect(vm).toHaveLength(1);
        expect(vm[0]).toMatchObject({ category: 'worktrees', repo: 'repos/app', branch: null, head: expect.stringMatching(/^[0-9a-f]{40}$/), state: 'merged', reclaimable: true });
    });

    it('no two items share a path or an id', async () => {
        const r = await storage.measure(root, { chatFiles: [] });
        const ids = r.items.map((i) => i.id);
        expect(new Set(ids).size).toBe(ids.length);
        const rels = r.items.map((i) => i.rel);
        expect(new Set(rels).size).toBe(rels.length);
    });

    it('a worktree row names its repository and branch', async () => {
        const r = await storage.measure(root, { chatFiles: [] });
        expect(r.items.find((i) => i.rel === 'wt/term')).toMatchObject({ repo: 'repos/app', branch: 'wt-term' });
    });
});

describe('a worktree in use is never offered', () => {
    const inUse = () => [{ path: join(root, 'wt', 'term', 'src'), by: 'a terminal (pwsh)' }];

    it('a terminal working in it: not reclaimable, the reason says who; Move and the one-click clean-up refuse it', async () => {
        const r = await storage.measure(root, { chatFiles: [], inUse: inUse() });
        const term = r.items.find((i) => i.rel === 'wt/term')!;
        expect(term).toMatchObject({ reclaimable: false, refusal: 'In use: a terminal (pwsh) is working in it.' });
        expect(suggestedCleanup(r.items, LATER)).not.toContain(term.id);
        expect(await storage.moveToTrash(root, term.id, { chatFiles: [], inUse: inUse() })).toEqual({ ok: false, reason: 'In use: a terminal (pwsh) is working in it.' });
        const done = await storage.cleanUp(root, [term.id], { chatFiles: [], inUse: inUse() });
        expect(done.moved).toEqual([]);
        expect(done.problems).toEqual([{ id: term.id, label: 'wt/term', reason: 'In use: a terminal (pwsh) is working in it.' }]);
        expect(existsSync(join(root, 'wt', 'term', 'README.md'))).toBe(true);
    });

    it('CONTROL: with nobody in it, the same worktree is offered and moves', async () => {
        const r = await storage.measure(root, { chatFiles: [] });
        expect(r.items.find((i) => i.rel === 'wt/term')).toMatchObject({ reclaimable: true, refusal: null });
        expect(await storage.moveToTrash(root, 'worktrees:wt/term', { chatFiles: [] })).toMatchObject({ ok: true });
    });

    it('git working in it (its index.lock): not offered, and said', async () => {
        const lock = (await git(join(root, 'wt', 'git'), 'rev-parse', '--git-path', 'index.lock')).stdout.trim();
        await writeFile(isAbsolute(lock) ? lock : join(root, 'wt', 'git', lock), '');
        const r = await storage.measure(root, { chatFiles: [] });
        expect(r.items.find((i) => i.rel === 'wt/git')).toMatchObject({ reclaimable: false, refusal: 'In use: git is working in it right now.' });
        expect(await storage.moveToTrash(root, 'worktrees:wt/git', { chatFiles: [] })).toEqual({ ok: false, reason: 'In use: git is working in it right now.' });
    });
});
