import { existsSync } from 'node:fs';
import { open, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approvalFor, parseWorktreeList, suggestedCleanup, type StorageReport } from '../src/core/workspace-storage.js';
import { sizeOf } from '../src/main/dir-size.js';
import { runCommand } from './helpers/command-report.js';
import { WorkspaceStorage, retryTransient, type ChatFile } from '../src/main/workspace-storage-host.js';

/**
 * A WORKSPACE'S DISK, AND ITS CLUTTER (Tynn #697). The owner: "genie needs to track disk usage by workspace including trash
 * files like worktrees, ci artifacts and files shared in chat and provide a clean way to empty those into the .trash and also
 * an ability to purge that trash folder with user approval."
 *
 * Real directories, real git (a bare remote, worktrees inside and outside the workspace). What is pinned:
 *  - categorisation: repos, worktrees (never the main checkout), CI/test artifacts by name (never inside node_modules, .git
 *    or .trash), files shared in chat, and .trash's own size;
 *  - the refusals: a worktree with uncommitted changes, with commits not on any remote, locked, or outside the workspace, and
 *    any id the window invents, are never moved;
 *  - measuring never follows a symlink, and never leaves the workspace;
 *  - Move to .trash records each item's origin, so it can be restored; a worktree is moved and git forgets it (Tynn #947), Restore registers it again;
 *  - Empty trash deletes ONLY what is in .trash, only with an approval naming exactly what is there and how much.
 */
// A failing command says its exit code, signal, timeout, stdout and stderr (genie#1992: this fixture's git failed on Windows with only "Command failed").
const run = (file: string, args: readonly string[]) => runCommand(file, args, { timeoutMs: 90_000 });
const git = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args]);
const NOW = 1_763_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const slash = (p: string) => p.split('\\').join('/');

let root: string;
let outside: string;
let sessions: string;
let storage: WorkspaceStorage;
let chat: ChatFile[];

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie-storage-ws-'));
    outside = await mkdtemp(join(tmpdir(), 'genie-storage-out-'));
    sessions = await mkdtemp(join(tmpdir(), 'genie-storage-sessions-'));
    // A repo with a bare remote, its main pushed.
    const remote = join(outside, 'remote.git');
    await run('git', ['init', '--bare', '--quiet', remote]);
    const app = join(root, 'repos', 'app');
    await mkdir(app, { recursive: true });
    await git(app, 'init', '--quiet');
    await writeFile(join(app, 'README.md'), 'hello\n');
    await git(app, 'add', '.');
    await git(app, 'commit', '--quiet', '-m', 'first');
    await git(app, 'remote', 'add', 'origin', remote);
    await git(app, 'push', '--quiet', 'origin', 'main');
    // CI/test artifacts, and one that must not count (inside node_modules).
    await mkdir(join(app, 'ci-out'), { recursive: true });
    await writeFile(join(app, 'ci-out', 'run.log'), Buffer.alloc(1000));
    await mkdir(join(app, 'coverage'), { recursive: true });
    await writeFile(join(app, 'coverage', 'lcov.info'), Buffer.alloc(500));
    await mkdir(join(app, 'node_modules', 'pkg', 'coverage'), { recursive: true });
    await writeFile(join(app, 'node_modules', 'pkg', 'coverage', 'x'), Buffer.alloc(7));
    // A symlink inside an artifact, to something big OUTSIDE the workspace: never followed, never counted.
    await writeFile(join(outside, 'big.bin'), Buffer.alloc(50_000));
    await mkdir(join(outside, 'big'));
    await writeFile(join(outside, 'big', 'data.bin'), Buffer.alloc(50_000));
    // A junction, not a file symlink: Windows lets a normal user make one (a file symlink is EPERM without the privilege), and it is what Windows tools leave behind.
    await symlink(join(outside, 'big'), join(app, 'ci-out', 'link-to-big'), 'junction');
    // Worktrees: clean (its HEAD is on the remote), dirty, ahead (a commit no remote has), and one outside the workspace.
    await git(app, 'worktree', 'add', '--quiet', '-b', 'wt-clean', join(root, 'wt', 'clean'));
    await git(app, 'worktree', 'add', '--quiet', '-b', 'wt-dirty', join(root, 'wt', 'dirty'));
    await writeFile(join(root, 'wt', 'dirty', 'scratch.txt'), 'not committed\n');
    await git(app, 'worktree', 'add', '--quiet', '-b', 'wt-ahead', join(root, 'wt', 'ahead'));
    await writeFile(join(root, 'wt', 'ahead', 'new.txt'), 'x\n');
    await git(join(root, 'wt', 'ahead'), 'add', '.');
    await git(join(root, 'wt', 'ahead'), 'commit', '--quiet', '-m', 'unpushed');
    await git(app, 'worktree', 'add', '--quiet', '-b', 'wt-out', join(outside, 'wt-out'));
    // Clean and pushed to a branch of its own, which is not the line: not merged yet.
    await git(app, 'worktree', 'add', '--quiet', '-b', 'wt-unmerged', join(root, 'wt', 'unmerged'));
    await writeFile(join(root, 'wt', 'unmerged', 'feature.txt'), 'x\n');
    await git(join(root, 'wt', 'unmerged'), 'add', '.');
    await git(join(root, 'wt', 'unmerged'), 'commit', '--quiet', '-m', 'feature');
    await git(join(root, 'wt', 'unmerged'), 'push', '--quiet', 'origin', 'wt-unmerged');
    // The envelope's downloaded test results: one queue item, two days old.
    await mkdir(join(root, '.ai', 'sandbox', 'azure', 'queue', '1114-130339-aaaaaa'), { recursive: true });
    await writeFile(join(root, '.ai', 'sandbox', 'azure', 'queue', '1114-130339-aaaaaa', 'item.log'), Buffer.alloc(2000));
    const old = new Date(NOW - 2 * DAY);
    for (const f of [join(root, '.ai', 'sandbox', 'azure', 'queue', '1114-130339-aaaaaa', 'item.log'), join(app, 'coverage', 'lcov.info')]) await utimes(f, old, old);
    // One image shared in chat, where the thread store keeps it.
    const ledger = join(sessions, 'abc123');
    await mkdir(ledger, { recursive: true });
    await writeFile(join(ledger, 'att-img1.png'), Buffer.alloc(300));
    chat = [{ agentId: 'kai', agentName: 'kai', attachmentId: 'img1', path: join(ledger, 'att-img1.png'), bytes: 300 }];
    storage = new WorkspaceStorage({ now: () => NOW });
});

afterEach(async () => {
    for (const dir of [root, outside, sessions]) await rm(dir, { recursive: true, force: true });
});

const items = (r: StorageReport, category: string) => r.items.filter((i) => i.category === category);
const byRel = (r: StorageReport, rel: string) => r.items.find((i) => i.rel === rel);

describe('measuring a workspace: categories', () => {
    it('repos, CI artifacts (not in node_modules), worktrees (never the main checkout), chat files, .trash', async () => {
        const r = await storage.measure(root, { chatFiles: chat });
        expect(items(r, 'repos').map((i) => i.rel)).toEqual(['repos/app']);
        expect(items(r, 'repos')[0]!.reclaimable).toBe(false);
        expect(items(r, 'ci-artifacts').map((i) => i.rel).sort()).toEqual(['.ai/sandbox/azure/queue/1114-130339-aaaaaa', 'repos/app/ci-out', 'repos/app/coverage']);
        const outReal = slash(await realpath(join(outside, 'wt-out')));
        expect(items(r, 'worktrees').map((i) => i.rel).sort()).toEqual([outReal, 'wt/ahead', 'wt/clean', 'wt/dirty', 'wt/unmerged'].sort());
        expect(items(r, 'chat-files').map((i) => i.label)).toEqual(['kai: img1 (att-img1.png)']);
        expect(r.totals['chat-files']).toBe(300);
        expect(r.totals.trash).toBe(0);
        expect(r.measuredAt).toBe(NOW);
    });

    it('never follows a symlink: the artifact holding a junction to 50 kB outside counts its own 1000 bytes', async () => {
        const r = await storage.measure(root, { chatFiles: [] });
        expect(byRel(r, 'repos/app/ci-out')!.bytes).toBe(1000);
        expect(r.totals['ci-artifacts']).toBe(1500 + 2000);
    });

    it('a clean, pushed worktree is reclaimable; the others say why not, in words', async () => {
        const r = await storage.measure(root, { chatFiles: [] });
        expect(byRel(r, 'wt/clean')).toMatchObject({ reclaimable: true, refusal: null });
        expect(byRel(r, 'wt/dirty')).toMatchObject({ reclaimable: false, refusal: expect.stringContaining('uncommitted') });
        expect(byRel(r, 'wt/ahead')).toMatchObject({ reclaimable: false, refusal: expect.stringContaining('1 commit no remote has') });
        expect(r.reclaimableBytes).toBe(r.items.filter((i) => i.reclaimable).reduce((n, i) => n + i.bytes, 0));
        expect(byRel(r, 'wt/dirty')!.bytes).toBeGreaterThan(0);
    });

    it('worktree states: clean and merged, clean and not merged yet, dirty, unpushed', async () => {
        const r = await storage.measure(root, { chatFiles: [] });
        expect(byRel(r, 'wt/clean')!.state).toBe('merged');
        expect(byRel(r, 'wt/unmerged')!.state).toBe('unmerged');
        expect(byRel(r, 'wt/dirty')!.state).toBe('dirty');
        expect(byRel(r, 'wt/ahead')!.state).toBe('unpushed');
        // the unmerged one is pushed, so it may be moved; it just is not suggested.
        expect(byRel(r, 'wt/unmerged')).toMatchObject({ reclaimable: true, refusal: null });
    });

    it('a worktree an agent made OUTSIDE the workspace is listed, marked external, sized; only its own repo’s git is asked', async () => {
        const r = await storage.measure(root, { chatFiles: [] });
        const out = r.items.find((i) => i.category === 'worktrees' && i.external === true)!;
        expect(out.rel).toBe(slash(await realpath(join(outside, 'wt-out'))));
        expect(out).toMatchObject({ state: 'merged', reclaimable: true, bytes: expect.any(Number) });
        expect(out.bytes).toBeGreaterThan(0);
        // Nothing else from outside: the 50 kB file and the bare remote are not in any category.
        expect(r.items.some((i) => i.rel.includes('remote.git') || i.rel.includes('big.bin'))).toBe(false);
    });

    it('artifacts carry their newest file’s time; a queue item is an artifact by where it is', async () => {
        const r = await storage.measure(root, { chatFiles: [] });
        expect(byRel(r, '.ai/sandbox/azure/queue/1114-130339-aaaaaa')!.newest).toBeLessThan(NOW - DAY);
        expect(byRel(r, 'repos/app/ci-out')!.newest).toBeGreaterThan(NOW - 365 * DAY);
    });
});

describe('the one-click clean-up suggestion preselects only what is safe', () => {
    it('merged quiet worktrees and test results older than a day; never unmerged, dirty, unpushed, a chat file or a fresh result', async () => {
        const r = await storage.measure(root, { chatFiles: chat });
        // The worktrees were just made, so "now" for the suggestion is a day and a half later: they are quiet by then.
        const later = Date.now() + 36 * 60 * 60 * 1000;
        const ids = suggestedCleanup(r.items, later);
        const outId = r.items.find((i) => i.external === true)!.id;
        expect(ids.sort()).toEqual([outId, 'worktrees:wt/clean', 'ci-artifacts:.ai/sandbox/azure/queue/1114-130339-aaaaaa', 'ci-artifacts:repos/app/ci-out', 'ci-artifacts:repos/app/coverage'].sort());
        for (const never of ['worktrees:wt/unmerged', 'worktrees:wt/dirty', 'worktrees:wt/ahead', 'chat-files:kai/img1', 'repos:repos/app']) expect(ids).not.toContain(never);
    });

    it('CONTROL: right after they were touched, nothing recent is suggested (an agent may be using it)', async () => {
        const r = await storage.measure(root, { chatFiles: chat });
        const ids = suggestedCleanup(r.items, Date.now());
        expect(ids).toEqual(expect.arrayContaining(['ci-artifacts:.ai/sandbox/azure/queue/1114-130339-aaaaaa', 'ci-artifacts:repos/app/coverage']));
        expect(ids).not.toContain('ci-artifacts:repos/app/ci-out');
        expect(ids).not.toContain('worktrees:wt/clean');
    });

    it('cleanUp moves only what a FRESH measure still suggests: a dirty worktree, an unmerged one and a chat file in the list are skipped', async () => {
        const fresh = new WorkspaceStorage({ now: () => Date.now() + 36 * 60 * 60 * 1000 });
        const asked = ['worktrees:wt/clean', 'worktrees:wt/dirty', 'worktrees:wt/unmerged', 'chat-files:kai/img1', 'ci-artifacts:.ai/sandbox/azure/queue/1114-130339-aaaaaa', 'nonsense'];
        const done = await fresh.cleanUp(root, asked, { chatFiles: chat });
        expect(done.moved.sort()).toEqual(['ci-artifacts:.ai/sandbox/azure/queue/1114-130339-aaaaaa', 'worktrees:wt/clean']);
        expect(done.skipped.sort()).toEqual(['chat-files:kai/img1', 'nonsense', 'worktrees:wt/dirty', 'worktrees:wt/unmerged']);
        expect(done.failed).toEqual([]);
        expect(existsSync(join(root, 'wt', 'dirty', 'scratch.txt'))).toBe(true);
        expect(existsSync(join(root, 'wt', 'unmerged'))).toBe(true);
        expect(existsSync(chat[0]!.path)).toBe(true);
        expect(existsSync(join(root, 'wt', 'clean'))).toBe(false);
    });
});

describe('Move to .trash', () => {
    const trashDirs = async () => (await readdir(join(root, '.trash')).catch(() => [])).filter((n) => n.startsWith('genie-'));

    it('an artifact: gone from where it was, in .trash with its origin recorded, and listed there with its size', async () => {
        const moved = await storage.moveToTrash(root, 'ci-artifacts:repos/app/ci-out', { chatFiles: [] });
        expect(moved).toMatchObject({ ok: true });
        expect(existsSync(join(root, 'repos', 'app', 'ci-out'))).toBe(false);
        const [dir] = await trashDirs();
        const record = JSON.parse(await readFile(join(root, '.trash', dir!, 'genie-trash.json'), 'utf8'));
        expect(record).toEqual({ version: 1, movedAt: NOW, origin: { kind: 'path', category: 'ci-artifacts', rel: 'repos/app/ci-out' } });
        const r = await storage.measure(root, { chatFiles: [] });
        expect(r.trash).toEqual([{ id: dir, origin: record.origin, movedAt: NOW, bytes: 1000 }]);
        expect(r.totals.trash).toBe(1000);
    });

    it('a worktree: moved into .trash and FORGOTTEN by git (Tynn #947: no pointer left into .trash), origin with repo and branch', async () => {
        expect(await storage.moveToTrash(root, 'worktrees:wt/clean', { chatFiles: [] })).toMatchObject({ ok: true });
        expect(existsSync(join(root, 'wt', 'clean'))).toBe(false);
        const list = parseWorktreeList((await git(join(root, 'repos', 'app'), 'worktree', 'list', '--porcelain')).stdout);
        expect(list.some((w) => w.branch === 'wt-clean')).toBe(false);
        expect(list.some((w) => resolve(w.path).startsWith(resolve(root, '.trash')))).toBe(false);
        const [dir] = await trashDirs();
        const record = JSON.parse(await readFile(join(root, '.trash', dir!, 'genie-trash.json'), 'utf8'));
        expect(record.origin).toEqual({ kind: 'worktree', repoRel: 'repos/app', rel: 'wt/clean', branch: 'wt-clean', head: expect.stringMatching(/^[0-9a-f]{40}$/), external: false, pruned: true });
    });

    it('an external worktree goes into this workspace’s .trash through git, and Restore puts it back at its own absolute place', async () => {
        const r = await storage.measure(root, { chatFiles: [] });
        const out = r.items.find((i) => i.external === true)!;
        const place = join(outside, 'wt-out');
        expect(await storage.moveToTrash(root, out.id, { chatFiles: [] })).toMatchObject({ ok: true });
        expect(existsSync(place)).toBe(false);
        const [dir] = await trashDirs();
        const record = JSON.parse(await readFile(join(root, '.trash', dir!, 'genie-trash.json'), 'utf8'));
        expect(record.origin).toMatchObject({ kind: 'worktree', branch: 'wt-out', external: true, rel: out.rel });
        expect(await storage.restore(root, dir!)).toMatchObject({ ok: true });
        expect(existsSync(join(place, 'README.md'))).toBe(true);
    });

    it('Restore puts a worktree back where it was, unlocked, as git’s worktree again', async () => {
        await storage.moveToTrash(root, 'worktrees:wt/clean', { chatFiles: [] });
        const [dir] = await trashDirs();
        expect(await storage.restore(root, dir!)).toMatchObject({ ok: true });
        const list = parseWorktreeList((await git(join(root, 'repos', 'app'), 'worktree', 'list', '--porcelain')).stdout);
        const back = list.find((w) => w.branch === 'wt-clean')!;
        expect(resolve(back.path)).toBe(resolve(root, 'wt', 'clean'));
        expect(back.locked).toBe(false);
        expect(await trashDirs()).toEqual([]);
    });

    it('Restore puts an artifact back; a chat file goes to .trash and back to the thread’s folder', async () => {
        await storage.moveToTrash(root, 'ci-artifacts:repos/app/coverage', { chatFiles: [] });
        let [dir] = await trashDirs();
        expect(await storage.restore(root, dir!)).toMatchObject({ ok: true });
        expect(existsSync(join(root, 'repos', 'app', 'coverage', 'lcov.info'))).toBe(true);
        expect(await storage.moveToTrash(root, 'chat-files:kai/img1', { chatFiles: chat })).toMatchObject({ ok: true });
        expect(existsSync(chat[0]!.path)).toBe(false);
        [dir] = await trashDirs();
        const record = JSON.parse(await readFile(join(root, '.trash', dir!, 'genie-trash.json'), 'utf8'));
        expect(record.origin).toEqual({ kind: 'chat-file', agentId: 'kai', attachmentId: 'img1', path: chat[0]!.path });
        expect(await storage.restore(root, dir!)).toMatchObject({ ok: true });
        expect(existsSync(chat[0]!.path)).toBe(true);
    });

    it('Restore refuses when something is already where the item came from: nothing is overwritten', async () => {
        await storage.moveToTrash(root, 'ci-artifacts:repos/app/coverage', { chatFiles: [] });
        await mkdir(join(root, 'repos', 'app', 'coverage'));
        const [dir] = await trashDirs();
        expect(await storage.restore(root, dir!)).toEqual({ ok: false, reason: 'Something is already at repos/app/coverage: move it away first.' });
        expect(await trashDirs()).toEqual([dir]);
    });

    it('REFUSED: uncommitted changes, unpushed commits, the main checkout, outside the workspace, ids the window invents', async () => {
        const refused = async (id: string) => {
            const r = await storage.moveToTrash(root, id, { chatFiles: chat });
            expect(r.ok, id).toBe(false);
            return r.ok ? '' : r.reason;
        };
        expect(await refused('worktrees:wt/dirty')).toContain('uncommitted');
        expect(await refused('worktrees:wt/ahead')).toContain('commit no remote has');
        expect(await refused('worktrees:repos/app')).toContain('not a worktree Genie may move');
        // A path that git does not list for this workspace's repos is never moved, inside or outside.
        expect(await refused(`worktrees:${slash(outside)}`)).toContain('not a worktree Genie may move');
        expect(await refused(`worktrees:${slash(join(outside, 'remote.git'))}`)).toContain('not a worktree Genie may move');
        expect(await refused('ci-artifacts:repos/app/README.md')).toContain('not a CI or test artifact');
        expect(await refused('ci-artifacts:../escape/ci-out')).toContain('not a CI or test artifact');
        expect(await refused('ci-artifacts:repos/app/node_modules/pkg/coverage')).toContain('not a CI or test artifact');
        expect(await refused('chat-files:kai/nope')).toContain('not a file shared in this workspace’s chat');
        expect(await refused('repos:repos/app')).toContain('cannot be moved');
        // Nothing moved by any of them.
        expect(await trashDirs()).toEqual([]);
        expect(existsSync(join(root, 'wt', 'dirty', 'scratch.txt'))).toBe(true);
    });

    it('REFUSED: a .trash that is a symlink (it would leave the workspace)', async () => {
        await symlink(outside, join(root, '.trash'), 'junction');
        const r = await storage.moveToTrash(root, 'ci-artifacts:repos/app/ci-out', { chatFiles: [] });
        expect(r).toEqual({ ok: false, reason: 'This workspace’s .trash is a link, not a folder: Genie will not use it.' });
        expect(existsSync(join(root, 'repos', 'app', 'ci-out'))).toBe(true);
    });
});

describe('Empty trash — permanent, only with approval, only inside .trash', () => {
    async function fill() {
        // Both moves must succeed, and say why if not: a Windows failure once showed only "deleted 1, expected 2".
        expect(await storage.moveToTrash(root, 'ci-artifacts:repos/app/ci-out', { chatFiles: [] })).toMatchObject({ ok: true });
        expect(await storage.moveToTrash(root, 'worktrees:wt/clean', { chatFiles: [] })).toMatchObject({ ok: true });
        return (await storage.measure(root, { chatFiles: [] })).trash;
    }

    it('no approval, or an approval for a different trash: refused, nothing deleted', async () => {
        const trash = await fill();
        const stale = { ids: trash.map((t) => t.id), bytes: approvalFor(trash).bytes + 1 };
        expect(await storage.emptyTrash(root, null)).toEqual({ ok: false, reason: 'Emptying the trash needs your approval of what is in it.' });
        expect(await storage.emptyTrash(root, stale)).toEqual({ ok: false, reason: 'The trash changed since you approved it: look again and approve what is there now.' });
        expect(await storage.emptyTrash(root, { ...approvalFor(trash), ids: [trash[0]!.id] })).toMatchObject({ ok: false });
        expect((await readdir(join(root, '.trash'))).length).toBe(2);
    });

    it('approved: everything in .trash is gone, .trash stays, a worktree is gone from git too; what a link pointed at survives', async () => {
        const trash = await fill();
        expect(await storage.emptyTrash(root, approvalFor(trash))).toEqual({ ok: true, deleted: 2, bytes: approvalFor(trash).bytes, failed: [] });
        expect(await readdir(join(root, '.trash'))).toEqual([]);
        expect((await lstat(join(root, '.trash'))).isDirectory()).toBe(true);
        expect(existsSync(join(outside, 'big.bin'))).toBe(true);
        const list = parseWorktreeList((await git(join(root, 'repos', 'app'), 'worktree', 'list', '--porcelain')).stdout);
        expect(list.some((w) => w.branch === 'wt-clean')).toBe(false);
        // Nothing outside .trash was touched.
        expect(existsSync(join(root, 'repos', 'app', 'README.md'))).toBe(true);
        expect(existsSync(join(root, 'wt', 'dirty', 'scratch.txt'))).toBe(true);
    });

    it('something the person put in .trash themselves is listed, counted, and emptied with the rest', async () => {
        await mkdir(join(root, '.trash'), { recursive: true });
        await writeFile(join(root, '.trash', 'old-notes.txt'), Buffer.alloc(40));
        const trash = (await storage.measure(root, { chatFiles: [] })).trash;
        expect(trash).toEqual([{ id: 'old-notes.txt', origin: { kind: 'unknown', name: 'old-notes.txt' }, movedAt: null, bytes: 40 }]);
        expect(await storage.emptyTrash(root, approvalFor(trash))).toEqual({ ok: true, deleted: 1, bytes: 40, failed: [] });
    });
});

describe('Empty trash and symlinks', () => {
    it('a junction or symlink INSIDE .trash is removed as a link: what it points at survives', async () => {
        await mkdir(join(root, '.trash'), { recursive: true });
        await symlink(outside, join(root, '.trash', 'link-out'), 'junction');
        const trash = (await storage.measure(root, { chatFiles: [] })).trash;
        expect(trash.map((t) => t.id)).toEqual(['link-out']);
        expect(trash[0]!.bytes).toBe(0);
        expect(await storage.emptyTrash(root, approvalFor(trash))).toMatchObject({ ok: true, deleted: 1 });
        expect(existsSync(join(outside, 'big.bin'))).toBe(true);
    });
});

describe('a handle another process still holds (Windows: git cannot rename the folder for a moment)', () => {
    it('retryTransient: tries again after a permission failure, gives up on a final one, stops at the limit', async () => {
        const waits: number[] = [];
        const wait = async (ms: number) => { waits.push(ms); };
        let n = 0;
        const flaky = async () => (++n < 3 ? { ok: false as const, error: "fatal: failed to move 'a' to 'b': Permission denied" } : { ok: true as const });
        expect(await retryTransient(flaky, 8, wait)).toEqual({ ok: true });
        expect(n).toBe(3);
        expect(waits).toEqual([250, 500]);
        // CONTROL: a final failure is not retried; a transient one that never clears stops at the attempt limit.
        let final = 0;
        expect(await retryTransient(async () => { final += 1; return { ok: false as const, error: "fatal: cannot move a locked working tree" }; }, 8, wait)).toMatchObject({ ok: false });
        expect(final).toBe(1);
        let stuck = 0;
        await retryTransient(async () => { stuck += 1; return { ok: false as const, error: 'Access is denied.' }; }, 4, wait);
        expect(stuck).toBe(4);
    });

    it('Move to .trash of a worktree succeeds although a file inside it is held open for a moment, and Empty trash then removes it', async () => {
        // On Windows an open handle makes the folder rename fail until it is closed; elsewhere the rename never fails and this passes too.
        const held = await open(join(root, 'wt', 'clean', 'README.md'), 'r');
        const release = setTimeout(() => { void held.close(); }, 600);
        try {
            expect(await storage.moveToTrash(root, 'worktrees:wt/clean', { chatFiles: [] })).toMatchObject({ ok: true });
        } finally { clearTimeout(release); await held.close().catch(() => undefined); }
        const trash = (await storage.measure(root, { chatFiles: [] })).trash;
        expect(await storage.emptyTrash(root, approvalFor(trash))).toMatchObject({ ok: true, deleted: 1 });
        expect(existsSync(join(root, 'wt', 'clean'))).toBe(false);
    });
});

describe('the size walk (off the main thread)', () => {
    it('runs in a worker, never follows a link, and says when it stopped early', async () => {
        let started = 0;
        const a = await sizeOf(join(root, 'repos', 'app', 'ci-out'), { startWorker: (source, data) => { started += 1; return new Worker(source, { eval: true, workerData: data }); } });
        expect(started).toBe(1);
        expect(a).toMatchObject({ bytes: 1000, files: 1, truncated: false, newest: expect.any(Number) });
        const capped = await sizeOf(join(root, 'repos', 'app'), { maxEntries: 3 });
        expect(capped.truncated).toBe(true);
    });
});
