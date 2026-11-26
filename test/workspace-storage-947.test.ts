import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approvalFor, parseWorktreeList } from '../src/core/workspace-storage.js';
import { sizeOf } from '../src/main/dir-size.js';
import { runCommand } from './helpers/command-report.js';
import { WorkspaceStorage, type StorageProgressEvent } from '../src/main/workspace-storage-host.js';

/**
 * CLEAN UP'S "MOVE TO .TRASH" AND "EMPTY TRASH" (Tynn #947). The owner clicked Move to .trash for 641 items (11 GB): for
 * twenty minutes nothing showed, items crept into .trash one at a time, and every worktree moved stayed registered with git
 * (`git worktree list` still named `.trash/genie-…/item`). What is pinned here, on real git:
 *  - a worktree moved to .trash is FORGOTTEN by git at once (its pointer goes), and Restore registers it again where it was,
 *    with its files (an ignored .env included) and a clean status;
 *  - an entry from before this change (moved and locked by git) still empties, and git forgets it;
 *  - cleanUp re-checks ONLY the items asked for: it never sizes the repositories (a full measure of the workspace per click
 *    was most of the twenty minutes), and says how far it is (n of m, bytes) after every item;
 *  - every item it does not move is named with the reason in words, never only counted;
 *  - Empty trash says how far it is, and an entry it cannot delete is named with the reason while the rest still go.
 */
const run = (file: string, args: readonly string[]) => runCommand(file, args, { timeoutMs: 90_000 });
const git = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args]);
const DAY = 24 * 60 * 60 * 1000;
const LATER = Date.now() + 3 * DAY;

let root: string;
let outside: string;
let app: string;
let sized: string[];
let storage: WorkspaceStorage;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie-947-ws-'));
    outside = await mkdtemp(join(tmpdir(), 'genie-947-out-'));
    const remote = join(outside, 'remote.git');
    await run('git', ['init', '--bare', '--quiet', remote]);
    app = join(root, 'repos', 'app');
    await mkdir(app, { recursive: true });
    await git(app, 'init', '--quiet');
    await writeFile(join(app, 'README.md'), 'hello\n');
    await writeFile(join(app, '.gitignore'), '.env\n');
    await git(app, 'add', '.');
    await git(app, 'commit', '--quiet', '-m', 'first');
    await git(app, 'remote', 'add', 'origin', remote);
    await git(app, 'push', '--quiet', 'origin', 'main');
    await git(app, 'fetch', '--quiet', 'origin');
    // Two merged worktrees (at main, which origin has), one with an ignored .env a fresh checkout would not bring back.
    await git(app, 'worktree', 'add', '--quiet', '-b', 'wt-a', join(root, 'wt', 'a'));
    await writeFile(join(root, 'wt', 'a', '.env'), 'SECRET=kept\n');
    await git(app, 'worktree', 'add', '--quiet', '-b', 'wt-b', join(root, 'wt', 'b'));
    // A dirty one: never moved.
    await git(app, 'worktree', 'add', '--quiet', '-b', 'wt-dirty', join(root, 'wt', 'dirty'));
    await writeFile(join(root, 'wt', 'dirty', 'scratch.txt'), 'not committed\n');
    // Two old test results.
    for (const name of ['coverage', 'ci-out']) {
        await mkdir(join(app, name), { recursive: true });
        await writeFile(join(app, name, 'out.log'), Buffer.alloc(1000));
    }
    const old = new Date(Date.now() - 2 * DAY);
    for (const p of [join(root, 'wt', 'a'), join(root, 'wt', 'b')]) for (const f of await readdir(p)) await utimes(join(p, f), old, old).catch(() => undefined);
    await utimes(join(app, 'coverage', 'out.log'), old, old);
    await utimes(join(app, 'ci-out', 'out.log'), old, old);
    sized = [];
    storage = new WorkspaceStorage({ now: () => LATER, sizeOf: (p) => { sized.push(resolve(p)); return sizeOf(p); } });
});

afterEach(async () => {
    for (const dir of [root, outside]) await rm(dir, { recursive: true, force: true });
});

const worktrees = async () => parseWorktreeList((await git(app, 'worktree', 'list', '--porcelain')).stdout);
const trashDirs = async () => (await readdir(join(root, '.trash')).catch(() => [])).filter((n) => n.startsWith('genie-'));

describe('a worktree moved to .trash: git forgets it, Restore registers it again', () => {
    it('after the move, git no longer lists it anywhere (no pointer into .trash), and its files are in .trash', async () => {
        expect(await storage.moveToTrash(root, 'worktrees:wt/a', { chatFiles: [] })).toMatchObject({ ok: true });
        expect(existsSync(join(root, 'wt', 'a'))).toBe(false);
        const list = await worktrees();
        expect(list.some((w) => w.branch === 'wt-a')).toBe(false);
        expect(list.some((w) => resolve(w.path).startsWith(resolve(root, '.trash')))).toBe(false);
        const [dir] = await trashDirs();
        expect(existsSync(join(root, '.trash', dir!, 'item', 'README.md'))).toBe(true);
        const record = JSON.parse(await readFile(join(root, '.trash', dir!, 'genie-trash.json'), 'utf8'));
        expect(record.origin).toMatchObject({ kind: 'worktree', repoRel: 'repos/app', rel: 'wt/a', branch: 'wt-a', pruned: true });
    });

    it('Restore: git lists it again at its own place, its files are back (the ignored .env too), and it is clean', async () => {
        await storage.moveToTrash(root, 'worktrees:wt/a', { chatFiles: [] });
        const [dir] = await trashDirs();
        expect(await storage.restore(root, dir!)).toMatchObject({ ok: true });
        const back = (await worktrees()).find((w) => w.branch === 'wt-a');
        expect(back && resolve(back.path)).toBe(resolve(root, 'wt', 'a'));
        expect(await readFile(join(root, 'wt', 'a', '.env'), 'utf8')).toBe('SECRET=kept\n');
        expect((await git(join(root, 'wt', 'a'), 'status', '--porcelain')).stdout.trim()).toBe('');
        expect(await trashDirs()).toEqual([]);
    });

    it('an entry from before this change (moved and locked by git) still empties, and git forgets it', async () => {
        const entry = join(root, '.trash', 'genie-1-aaaaaa');
        await mkdir(entry, { recursive: true });
        await git(app, 'worktree', 'move', join(root, 'wt', 'b'), join(entry, 'item'));
        await git(app, 'worktree', 'lock', '--reason', 'In the workspace .trash (Genie)', join(entry, 'item'));
        await writeFile(join(entry, 'genie-trash.json'), JSON.stringify({ version: 1, movedAt: 1, origin: { kind: 'worktree', repoRel: 'repos/app', rel: 'wt/b', branch: 'wt-b', head: null, external: false } }));
        const trash = await storage.listTrash(root);
        expect(await storage.emptyTrash(root, approvalFor(trash))).toMatchObject({ ok: true, deleted: 1, failed: [] });
        expect((await worktrees()).some((w) => w.branch === 'wt-b')).toBe(false);
    });
});

describe('cleanUp: only the asked items are re-checked, with progress, and every item left is named with its reason', () => {
    const asked = ['worktrees:wt/a', 'worktrees:wt/b', 'worktrees:wt/dirty', 'ci-artifacts:repos/app/coverage', 'ci-artifacts:repos/app/ci-out', 'nonsense'];

    it('never sizes the repositories or the worktrees it was not asked about (no full measure per click)', async () => {
        await storage.cleanUp(root, asked, { chatFiles: [] });
        expect(sized).not.toContain(resolve(app));
        expect(sized.every((p) => !p.startsWith(resolve(root, '.trash')))).toBe(true);
    });

    it('says how far it is after every item: n of m, and the bytes moved so far', async () => {
        const events: StorageProgressEvent[] = [];
        const done = await storage.cleanUp(root, asked, { chatFiles: [] }, (e) => { events.push(e); });
        expect(done.moved.sort()).toEqual(['ci-artifacts:repos/app/ci-out', 'ci-artifacts:repos/app/coverage', 'worktrees:wt/a', 'worktrees:wt/b']);
        expect(events.map((e) => e.done)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(events.every((e) => e.total === 6)).toBe(true);
        expect(events.at(-1)!.bytes).toBeGreaterThanOrEqual(2000);
        expect(events.map((e) => e.bytes)).toEqual([...events.map((e) => e.bytes)].sort((a, b) => a - b));
    });

    it('names every item it did not move, with the reason in words', async () => {
        const done = await storage.cleanUp(root, asked, { chatFiles: [] });
        const why = Object.fromEntries(done.problems.map((p) => [p.id, p.reason]));
        expect(Object.keys(why).sort()).toEqual(['nonsense', 'worktrees:wt/dirty']);
        expect(why['worktrees:wt/dirty']).toMatch(/uncommitted changes/);
        expect(why['nonsense']).toMatch(/\w+ \w+/);
        expect(existsSync(join(root, 'wt', 'dirty', 'scratch.txt'))).toBe(true);
    });
});

describe('Empty trash: progress, and an entry it cannot delete is named while the rest still go', () => {
    it('reports each entry as it goes, and a failure by name and reason', async () => {
        await mkdir(join(root, '.trash', 'keep-me'), { recursive: true });
        await writeFile(join(root, '.trash', 'keep-me', 'x'), 'x');
        await writeFile(join(root, '.trash', 'old-notes.txt'), Buffer.alloc(40));
        const failing = new WorkspaceStorage({
            now: () => LATER,
            remove: async (p) => { if (p.endsWith('keep-me')) throw new Error('EBUSY: resource busy or locked'); await rm(p, { recursive: true, force: true }); },
        });
        const trash = await failing.listTrash(root);
        const events: StorageProgressEvent[] = [];
        const r = await failing.emptyTrash(root, approvalFor(trash), (e) => { events.push(e); });
        expect(r).toMatchObject({ ok: true, deleted: 1 });
        expect(r.ok && r.failed).toEqual([{ id: 'keep-me', label: 'keep-me', reason: expect.stringMatching(/busy/) }]);
        expect(events.map((e) => [e.done, e.total])).toEqual([[1, 2], [2, 2]]);
        expect(existsSync(join(root, '.trash', 'old-notes.txt'))).toBe(false);
        expect(existsSync(join(root, '.trash', 'keep-me'))).toBe(true);
    });
});
