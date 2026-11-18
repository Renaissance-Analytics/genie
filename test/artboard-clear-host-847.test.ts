import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOARD_DIR, BOARD_HISTORY, BOARD_INDEX, parseBoard, type BoardPost } from '../src/core/artboard.js';
import { clearArtBoard, restoreArtBoard, type ReviewDeps } from '../src/main/artboard-host.js';
import { artboardReview } from '../src/main/official-panels-host.js';
import { WorkspaceStorage } from '../src/main/workspace-storage-host.js';

/**
 * CLEARING THE BOARD, ON THE HOST (genie#847). Real folders. What is pinned:
 *  - a Clear (or one Delete) takes the items off `.artboard/index.json` and MOVES them — their index records with the whole
 *    trail, and every version's file — into ONE entry of the workspace's .trash, recorded the way #697 records its entries
 *    (`genie-trash.json`, origin kind `artboard`), so the Storage tab lists and restores it like any other;
 *  - nothing is deleted: the files are in .trash, and `.artboard/history.jsonl` keeps a line per item with its status and trail;
 *  - each WAITING item cleared is closed "without a verdict" and its agent is told in its AgentInbox (the same delivery as a
 *    rejection); an item that asked for nothing, or was decided, tells nobody;
 *  - Undo (restore) puts the items and their files back and tells those agents they are waiting again; it never lands over
 *    an item that is on the board again, and never restores something that is not an ArtBoard entry;
 *  - the panel's one call (`artboard.review`) carries clear-decided / clear-all / clear-everything / delete / restore.
 */
const TRASH_ID = /^genie-\d+-[0-9a-f]{6}$/;
const at = (n: number) => `2026-11-17T10:${String(n).padStart(2, '0')}:00.000Z`;
const post = (id: string, over: Partial<BoardPost> = {}): BoardPost => ({ id, title: `Title ${id}`, kind: 'html', file: `${id}.html`, createdAt: at(1), askVerdict: true, ...over });

// 7 items: w1 (agent a1), w2 (agent a2, two versions), s1 (asked for nothing, a1), d1 (approved with a trail, a1), d2 (rejected),
// dp (decided and pinned), wp (waiting and pinned, agent a3).
const BOARD: BoardPost[] = [
    post('w1', { agentId: 'a1' }),
    post('w2', { agentId: 'a2', file: 'w2.v2.html', versions: [
        { n: 1, file: 'w2.html', kind: 'html', title: 'Title w2', createdAt: at(1) },
        { n: 2, file: 'w2.v2.html', kind: 'html', title: 'Title w2', createdAt: at(2) },
    ] }),
    post('s1', { agentId: 'a1', askVerdict: false }),
    post('d1', { agentId: 'a1', review: { verdict: 'approved', at: at(3), comment: 'ship it' }, trail: [{ type: 'verdict', version: 1, verdict: 'approved', comment: 'ship it', at: at(3), by: 'person' }] }),
    post('d2', { review: { verdict: 'rejected', at: at(4) } }),
    post('dp', { agentId: 'a1', review: { verdict: 'approved', at: at(5) }, pinned: true }),
    post('wp', { agentId: 'a3', pinned: true }),
];
const FILES = ['w1.html', 'w2.html', 'w2.v2.html', 's1.html', 'd1.html', 'd2.html', 'dp.html', 'wp.html'];

let root: string;
let sent: { agentId: string; text: string }[];
let deps: ReviewDeps;

beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'genie-artboard-clear-')));
    await mkdir(join(root, BOARD_DIR));
    await writeFile(join(root, BOARD_DIR, BOARD_INDEX), JSON.stringify({ posts: BOARD }, null, 2));
    for (const f of FILES) await writeFile(join(root, BOARD_DIR, f), `<p>${f}</p>`);
    sent = [];
    deps = { send: async (agentId, text) => { sent.push({ agentId, text }); }, now: () => at(30) };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const onBoard = async () => parseBoard(await readFile(join(root, BOARD_DIR, BOARD_INDEX), 'utf8')).map((p) => p.id).sort();
const inBoardDir = async () => (await readdir(join(root, BOARD_DIR))).filter((f) => f.endsWith('.html')).sort();
const entry = (id: string) => join(root, '.trash', id);
const record = async (id: string) => JSON.parse(await readFile(join(entry(id), 'genie-trash.json'), 'utf8')) as { version: number; origin: { kind: string; ids: string[]; label: string } };
const payloadIds = async (id: string) => parseBoard(await readFile(join(entry(id), 'item', BOARD_INDEX), 'utf8')).map((p) => p.id).sort();
const history = async () => (await readFile(join(root, BOARD_DIR, BOARD_HISTORY), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const trashIdOf = (r: Awaited<ReturnType<typeof clearArtBoard>>) => (r.ok ? r.trashId : null);

describe('Clear decided', () => {
    it('moves the 2 decided items (not the pinned one) into ONE .trash entry, and tells nobody', async () => {
        const r = await clearArtBoard(root, { scope: 'decided' }, deps);
        expect(r).toMatchObject({ ok: true, cleared: 2 });
        const id = trashIdOf(r)!;
        expect(id).toMatch(TRASH_ID);
        expect(await onBoard()).toEqual(['dp', 's1', 'w1', 'w2', 'wp']);
        expect(await payloadIds(id)).toEqual(['d1', 'd2']);
        expect(await inBoardDir()).toEqual(['dp.html', 's1.html', 'w1.html', 'w2.html', 'w2.v2.html', 'wp.html']);
        expect((await readdir(join(entry(id), 'item'))).sort()).toEqual(['d1.html', 'd2.html', BOARD_INDEX].sort());
        expect(sent).toEqual([]);
    });

    it('records the entry as #697 does: origin kind artboard, the ids, a label', async () => {
        const id = trashIdOf(await clearArtBoard(root, { scope: 'decided' }, deps))!;
        const rec = await record(id);
        expect(rec.version).toBe(1);
        expect(rec.origin).toMatchObject({ kind: 'artboard', ids: ['d1', 'd2'] });
        expect(rec.origin.label).toMatch(/2 items/);
    });

    it('keeps the paper trail: the trashed record still has its trail, and history.jsonl has a line per item', async () => {
        const id = trashIdOf(await clearArtBoard(root, { scope: 'decided' }, deps))!;
        const d1 = parseBoard(await readFile(join(entry(id), 'item', BOARD_INDEX), 'utf8')).find((p) => p.id === 'd1')!;
        expect(d1.trail).toHaveLength(1);
        const lines = await history();
        expect(lines.map((l) => l.id)).toEqual(['d1', 'd2']);
        expect(lines[0]).toMatchObject({ action: 'cleared', id: 'd1', title: 'Title d1', status: 'approved', trashId: id, at: at(30) });
        expect((lines[0]!.trail as unknown[])).toHaveLength(1);
    });

    it('with nothing decided, does nothing: no new .trash entry, nothing said', async () => {
        await clearArtBoard(root, { scope: 'decided' }, deps);
        sent = [];
        expect(await clearArtBoard(root, { scope: 'decided' }, deps)).toEqual({ ok: true, delivered: false, cleared: 0, trashId: null });
        expect((await readdir(join(root, '.trash')))).toHaveLength(1);
    });
});

describe('Clear all', () => {
    it('takes the 5 unpinned items, both versions of w2 with them; the pinned 2 stay', async () => {
        const r = await clearArtBoard(root, { scope: 'all' }, deps);
        expect(r).toMatchObject({ ok: true, cleared: 5, delivered: true });
        expect(await onBoard()).toEqual(['dp', 'wp']);
        expect(await inBoardDir()).toEqual(['dp.html', 'wp.html']);
        expect((await readdir(join(entry(trashIdOf(r)!), 'item'))).filter((f) => f.startsWith('w2'))).toHaveLength(2);
    });

    it('each WAITING item is closed without a verdict and its agent told; the shown and decided ones tell nobody', async () => {
        await clearArtBoard(root, { scope: 'all' }, deps);
        expect(sent.map((s) => s.agentId).sort()).toEqual(['a1', 'a2']);
        expect(sent.find((s) => s.agentId === 'a1')!.text).toMatch(/"Title w1".*without a verdict/s);
        const lines = await history();
        expect(lines.find((l) => l.id === 'w1')).toMatchObject({ status: 'cleared-without-verdict' });
        expect(lines.find((l) => l.id === 's1')).toMatchObject({ status: 'shown' });
    });
});

describe('Clear all, pinned too', () => {
    it('empties the board: 7 items, and 3 agents told (w1, w2, and the pinned waiting wp)', async () => {
        expect(await clearArtBoard(root, { scope: 'everything' }, deps)).toMatchObject({ ok: true, cleared: 7 });
        expect(await onBoard()).toEqual([]);
        expect(await inBoardDir()).toEqual([]);
        expect(sent.map((s) => s.agentId).sort()).toEqual(['a1', 'a2', 'a3']);
    });
});

describe('Delete one item', () => {
    it('moves just that item, and tells its agent when it was waiting', async () => {
        const r = await clearArtBoard(root, { postId: 'w1' }, deps);
        expect(r).toMatchObject({ ok: true, cleared: 1 });
        expect(await onBoard()).toEqual(['d1', 'd2', 'dp', 's1', 'w2', 'wp']);
        expect(await payloadIds(trashIdOf(r)!)).toEqual(['w1']);
        expect(sent.map((s) => s.agentId)).toEqual(['a1']);
    });

    it('a pinned item can be deleted on purpose', async () => {
        expect(await clearArtBoard(root, { postId: 'dp' }, deps)).toMatchObject({ ok: true, cleared: 1 });
        expect(await onBoard()).not.toContain('dp');
    });

    it('an id not on the board is refused, in words', async () => {
        expect(await clearArtBoard(root, { postId: 'nope' }, deps)).toMatchObject({ ok: false, error: expect.stringMatching(/no longer on the board/) });
        expect(existsSync(join(root, '.trash'))).toBe(false);
    });
});

describe('Undo: restore an ArtBoard .trash entry', () => {
    it('puts every item and file back, removes the entry, and tells the waiting ones they are back', async () => {
        const id = trashIdOf(await clearArtBoard(root, { scope: 'all' }, deps))!;
        sent = [];
        expect(await restoreArtBoard(root, id, deps)).toMatchObject({ ok: true, cleared: 5, trashId: id });
        expect(await onBoard()).toEqual(['d1', 'd2', 'dp', 's1', 'w1', 'w2', 'wp']);
        expect(await inBoardDir()).toEqual([...FILES].sort());
        expect(existsSync(entry(id))).toBe(false);
        expect(sent.map((s) => s.agentId).sort()).toEqual(['a1', 'a2']);
        expect(sent[0]!.text).toMatch(/back on the board/);
        expect((await history()).filter((l) => l.action === 'restored').map((l) => l.id).sort()).toEqual(['d1', 'd2', 's1', 'w1', 'w2']);
    });

    it('the restored items keep their verdicts and trail', async () => {
        const id = trashIdOf(await clearArtBoard(root, { scope: 'decided' }, deps))!;
        expect(await restoreArtBoard(root, id, deps)).toMatchObject({ ok: true, cleared: 2 });
        const d1 = parseBoard(await readFile(join(root, BOARD_DIR, BOARD_INDEX), 'utf8')).find((p) => p.id === 'd1')!;
        expect(d1.review).toMatchObject({ verdict: 'approved', comment: 'ship it' });
        expect(d1.trail).toHaveLength(1);
    });

    it('never lands over an item that is on the board again: refused, and the entry kept', async () => {
        const id = trashIdOf(await clearArtBoard(root, { postId: 'w1' }, deps))!;
        await writeFile(join(root, BOARD_DIR, BOARD_INDEX), JSON.stringify({ posts: [post('w1', { file: 'w1.v2.html' })] }));
        expect(await restoreArtBoard(root, id, deps)).toMatchObject({ ok: false, error: expect.stringMatching(/w1|already/i) });
        expect(existsSync(entry(id))).toBe(true);
    });

    it('refuses an entry that is not an ArtBoard one (Undo never restores a worktree or a file)', async () => {
        const other = 'genie-1763000000000-abcdef';
        await mkdir(join(entry(other), 'item'), { recursive: true });
        await writeFile(join(entry(other), 'genie-trash.json'), JSON.stringify({ version: 1, movedAt: 1, origin: { kind: 'path', category: 'dirty', rel: '.ai/_dirty/x' } }));
        expect(await restoreArtBoard(root, other, deps)).toMatchObject({ ok: false });
        expect(existsSync(entry(other))).toBe(true);
    });
});

describe('the Storage tab (#697) knows the entry', () => {
    it('lists it with its origin, and its Restore puts the items back on the board', async () => {
        const id = trashIdOf(await clearArtBoard(root, { scope: 'decided' }, deps))!;
        const storage = new WorkspaceStorage();
        const listed = (await storage.listTrash(root)).find((t) => t.id === id);
        expect(listed?.origin).toMatchObject({ kind: 'artboard', ids: ['d1', 'd2'] });
        expect(await storage.restore(root, id)).toMatchObject({ ok: true });
        expect(await onBoard()).toEqual(['d1', 'd2', 'dp', 's1', 'w1', 'w2', 'wp']);
        expect(await inBoardDir()).toEqual([...FILES].sort());
    });
});

describe("the panel's one call carries the clear actions", () => {
    const host = () => ({ workspacePath: (id: string) => (id === 'work' ? root : null), send: deps.send, now: deps.now });

    it('clear-decided, clear-all and clear-everything clear their scope', async () => {
        expect(await artboardReview(host(), 'work', '', 'clear-decided', '')).toMatchObject({ ok: true, cleared: 2 });
        expect(await artboardReview(host(), 'work', '', 'clear-all', '')).toMatchObject({ ok: true, cleared: 3 });
        expect(await artboardReview(host(), 'work', '', 'clear-everything', '')).toMatchObject({ ok: true, cleared: 2 });
        expect(await onBoard()).toEqual([]);
    });

    it('delete takes one item; restore puts an entry back by its .trash id', async () => {
        const r = await artboardReview(host(), 'work', 'w1', 'delete', '');
        expect(r).toMatchObject({ ok: true, cleared: 1 });
        const id = r.ok ? r.trashId : null;
        expect(await artboardReview(host(), 'work', id, 'restore', '')).toMatchObject({ ok: true, cleared: 1 });
        expect(await onBoard()).toContain('w1');
    });

    it('a workspace Genie does not have is refused', async () => {
        expect(await artboardReview(host(), 'elsewhere', '', 'clear-all', '')).toMatchObject({ ok: false });
    });
});
