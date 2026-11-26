import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATEGORY_LABEL, STORAGE_CATEGORIES, suggestedCleanup, type StorageReport } from '../src/core/workspace-storage.js';
import { WorkspaceStorage } from '../src/main/workspace-storage-host.js';

/**
 * THE WORKSPACE'S `.ai/_dirty/` ON THE STORAGE TAB (Tynn #819, the owner 2026-11-17; #697's rules). `.ai/_dirty/` is where
 * files dropped into a workspace land (Genie 1), and every envelope has one (#818). The Storage tab shows each of its
 * entries with its size and offers Move to .trash, under the rules #697 keeps for everything else:
 *  - the window sends an id (`dirty:<name>`), re-validated on the host: one name directly in `.ai/_dirty/`, never `..`,
 *    never a deeper path, never `.gitkeep`;
 *  - nothing is measured or moved THROUGH a link: an entry that is a link is not listed, and a `.ai/_dirty` (or a `.ai`)
 *    that is a link is not used at all; a Restore whose folder became a link meanwhile is refused;
 *  - nothing is deleted: Move to .trash records the origin, Restore puts it back, only an approved Empty trash deletes;
 *  - the one-click clean-up never preselects these: they are the person's files, as files shared in chat are.
 * Real directories; a junction stands for a link (a normal Windows user can make one; on Linux it is a symlink).
 */
const NOW = 1_763_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

let root: string;
let outside: string;
let storage: WorkspaceStorage;
const dirty = () => join(root, '.ai', '_dirty');

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie-dirty-ws-'));
    outside = await mkdtemp(join(tmpdir(), 'genie-dirty-out-'));
    await mkdir(join(dirty(), 'drop'), { recursive: true });
    await writeFile(join(dirty(), '.gitkeep'), '');
    await writeFile(join(dirty(), 'upload.png'), Buffer.alloc(300));
    await writeFile(join(dirty(), 'drop', 'a.txt'), Buffer.alloc(200));
    // A folder named like a CI artifact inside .ai/_dirty: it is the person's, counted once, under .ai/_dirty.
    await mkdir(join(dirty(), 'ci-out'));
    await writeFile(join(dirty(), 'ci-out', 'x.log'), Buffer.alloc(100));
    // Something big outside the workspace, and links to it from inside .ai/_dirty: never listed, never followed.
    await mkdir(join(outside, 'big'));
    await writeFile(join(outside, 'big', 'data.bin'), Buffer.alloc(50_000));
    await symlink(join(outside, 'big'), join(dirty(), 'escape'), 'junction');
    await symlink(join(outside, 'big'), join(dirty(), 'drop', 'inner-link'), 'junction');
    // A real CI artifact elsewhere in the workspace, two days old: the positive control for the artifact walk and the suggestion.
    await mkdir(join(root, 'repos', 'app', 'ci-out'), { recursive: true });
    await writeFile(join(root, 'repos', 'app', 'ci-out', 'run.log'), Buffer.alloc(1000));
    const old = new Date(NOW - 2 * DAY);
    for (const f of [join(root, 'repos', 'app', 'ci-out', 'run.log'), join(dirty(), 'upload.png'), join(dirty(), 'drop', 'a.txt'), join(dirty(), 'ci-out', 'x.log')]) await utimes(f, old, old);
    storage = new WorkspaceStorage({ now: () => NOW });
});

afterEach(async () => {
    for (const dir of [root, outside]) await rm(dir, { recursive: true, force: true });
});

const items = (r: StorageReport, category: string) => r.items.filter((i) => i.category === category);
const dirtyIds = (r: StorageReport) => items(r, 'dirty').map((i) => i.id).sort();
/** Swap `.ai/_dirty` (or `.ai`) for a junction to a folder outside the workspace that holds a file of its own. */
async function linkOut(rel: '.ai' | '.ai/_dirty'): Promise<string> {
    const at = join(root, ...rel.split('/'));
    const target = join(outside, 'elsewhere');
    await mkdir(join(target, '_dirty'), { recursive: true });
    await writeFile(join(target, 'secret.txt'), Buffer.alloc(4000));
    await writeFile(join(target, '_dirty', 'secret.txt'), Buffer.alloc(4000));
    await rename(at, join(outside, `moved-${rel.replace(/[/.]/g, '_')}`));
    await symlink(target, at, 'junction');
    return target;
}

describe('the category', () => {
    it('.ai/_dirty is a storage category, labelled by its folder, listed before .trash', () => {
        expect(STORAGE_CATEGORIES).toContain('dirty');
        expect(STORAGE_CATEGORIES.indexOf('dirty')).toBeLessThan(STORAGE_CATEGORIES.indexOf('trash'));
        expect(CATEGORY_LABEL.dirty).toBe('.ai/_dirty');
    });
});

describe('measuring .ai/_dirty', () => {
    it('CONTROL: the fixture’s real artifact elsewhere is found by the artifact walk', async () => {
        const r = await storage.measure(root, { chatFiles: [] });
        expect(items(r, 'ci-artifacts').map((i) => i.rel)).toContain('repos/app/ci-out');
    });

    it('each entry directly in .ai/_dirty with its size; not .gitkeep, not a link; the total; all reclaimable', async () => {
        const r = await storage.measure(root, { chatFiles: [] });
        expect(dirtyIds(r)).toEqual(['dirty:ci-out', 'dirty:drop', 'dirty:upload.png']);
        const by = Object.fromEntries(items(r, 'dirty').map((i) => [i.rel, i]));
        expect(by['.ai/_dirty/upload.png']).toMatchObject({ label: '.ai/_dirty/upload.png', bytes: 300, files: 1, reclaimable: true, refusal: null });
        // The junction inside drop/ is not followed: drop/ is its own 200 bytes, not 50 kB more.
        expect(by['.ai/_dirty/drop']).toMatchObject({ bytes: 200, files: 1, reclaimable: true, refusal: null });
        expect(by['.ai/_dirty/ci-out']).toMatchObject({ bytes: 100 });
        expect(r.totals.dirty).toBe(600);
        expect(r.items.some((i) => i.rel.includes('escape'))).toBe(false);
    });

    it('a folder inside .ai/_dirty is never counted twice: not also a CI artifact', async () => {
        const r = await storage.measure(root, { chatFiles: [] });
        expect(items(r, 'dirty').map((i) => i.rel)).toContain('.ai/_dirty/ci-out');
        expect(items(r, 'ci-artifacts').map((i) => i.rel)).toEqual(['repos/app/ci-out']);
    });

    it('a .ai/_dirty that is a link out of the workspace is never measured, listed or moved through', async () => {
        expect(dirtyIds(await storage.measure(root, { chatFiles: [] }))).toHaveLength(3);
        const target = await linkOut('.ai/_dirty');
        const r = await storage.measure(root, { chatFiles: [] });
        expect(items(r, 'dirty')).toEqual([]);
        expect(r.totals.dirty).toBe(0);
        expect(await storage.moveToTrash(root, 'dirty:secret.txt', { chatFiles: [] })).toMatchObject({ ok: false });
        expect(existsSync(join(target, 'secret.txt'))).toBe(true);
    });

    it('nor when .ai itself is a link out of the workspace', async () => {
        expect(dirtyIds(await storage.measure(root, { chatFiles: [] }))).toHaveLength(3);
        const target = await linkOut('.ai');
        const r = await storage.measure(root, { chatFiles: [] });
        expect(items(r, 'dirty')).toEqual([]);
        expect(r.totals.dirty).toBe(0);
        expect(await storage.moveToTrash(root, 'dirty:secret.txt', { chatFiles: [] })).toMatchObject({ ok: false });
        expect(existsSync(join(target, '_dirty', 'secret.txt'))).toBe(true);
    });
});

describe('Move to .trash and Restore', () => {
    const trashDirs = async () => (await readdir(join(root, '.trash')).catch(() => [])).filter((n) => n.startsWith('genie-'));

    it('an entry: gone from .ai/_dirty, in .trash with its origin and size, and Restore puts it back', async () => {
        const moved = await storage.moveToTrash(root, 'dirty:upload.png', { chatFiles: [] });
        expect(moved).toMatchObject({ ok: true, label: '.ai/_dirty/upload.png' });
        expect(existsSync(join(dirty(), 'upload.png'))).toBe(false);
        const [dir] = await trashDirs();
        const record = JSON.parse(await readFile(join(root, '.trash', dir!, 'genie-trash.json'), 'utf8'));
        expect(record).toEqual({ version: 1, movedAt: NOW, origin: { kind: 'path', category: 'dirty', rel: '.ai/_dirty/upload.png' } });
        const r = await storage.measure(root, { chatFiles: [] });
        expect(r.trash).toEqual([{ id: dir, origin: record.origin, movedAt: NOW, bytes: 300 }]);
        expect(r.totals.dirty).toBe(300);
        expect(await storage.restore(root, dir!)).toMatchObject({ ok: true, label: '.ai/_dirty/upload.png' });
        expect((await readFile(join(dirty(), 'upload.png'))).length).toBe(300);
        expect(await trashDirs()).toEqual([]);
    });

    it('a folder entry moves whole, and the link inside it moves as a link: what it points at is untouched', async () => {
        expect(await storage.moveToTrash(root, 'dirty:drop', { chatFiles: [] })).toMatchObject({ ok: true });
        expect(existsSync(join(dirty(), 'drop'))).toBe(false);
        expect(existsSync(join(outside, 'big', 'data.bin'))).toBe(true);
    });

    it('ids the window invents are refused and nothing moves: .., a deeper path, .gitkeep, a link, empty, unknown', async () => {
        for (const id of ['dirty:../../repos/app/ci-out', 'dirty:..', 'dirty:drop/a.txt', 'dirty:.gitkeep', 'dirty:escape', 'dirty:', 'dirty:nope', 'dirty:.']) {
            expect(await storage.moveToTrash(root, id, { chatFiles: [] }), id).toMatchObject({ ok: false });
        }
        expect(await trashDirs()).toEqual([]);
        for (const f of [join(root, 'repos', 'app', 'ci-out', 'run.log'), join(dirty(), 'drop', 'a.txt'), join(dirty(), '.gitkeep'), join(outside, 'big', 'data.bin')]) expect(existsSync(f), f).toBe(true);
        // Positive control, the same way: a real entry does move.
        expect(await storage.moveToTrash(root, 'dirty:upload.png', { chatFiles: [] })).toMatchObject({ ok: true });
    });

    it('Restore is refused when .ai/_dirty became a link out of the workspace meanwhile; nothing lands outside', async () => {
        expect(await storage.moveToTrash(root, 'dirty:upload.png', { chatFiles: [] })).toMatchObject({ ok: true });
        const [dir] = await trashDirs();
        const target = await linkOut('.ai/_dirty');
        expect(await storage.restore(root, dir!)).toMatchObject({ ok: false });
        expect(existsSync(join(target, 'upload.png'))).toBe(false);
        expect(await trashDirs()).toEqual([dir]);
    });
});

describe('the one-click clean-up', () => {
    it('never preselects a .ai/_dirty entry, however old; the old artifact beside it is (positive control)', async () => {
        const r = await storage.measure(root, { chatFiles: [] });
        expect(dirtyIds(r)).toHaveLength(3);
        const ids = suggestedCleanup(r.items, NOW);
        expect(ids).toContain('ci-artifacts:repos/app/ci-out');
        expect(ids.filter((id) => id.startsWith('dirty:'))).toEqual([]);
        const done = await storage.cleanUp(root, ['dirty:upload.png', 'ci-artifacts:repos/app/ci-out'], { chatFiles: [] });
        // Tynn #947: the item left is named with the reason, and the bytes moved are counted.
        expect(done).toEqual({ moved: ['ci-artifacts:repos/app/ci-out'], skipped: ['dirty:upload.png'], failed: [], bytes: expect.any(Number),
            problems: [{ id: 'dirty:upload.png', label: 'upload.png', reason: 'The one-click clean-up moves only merged worktrees and old test results: move this one by itself.' }] });
        expect(done.bytes).toBeGreaterThan(0);
        expect(existsSync(join(dirty(), 'upload.png'))).toBe(true);
    });
});
