import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BOARD_DIR, BOARD_HISTORY, BOARD_INDEX, applyVerdict, clearedMessage, clearSelection, isTextKind, parseBoard, postStatus, resolveBoard, restoredMessage, setPinned, verdictMessage, versionsOf, wantsVerdict, type BoardPost, type ClearScope, type ResolvedBoard, type Review } from '../core/artboard.js';
import { artboardPayloadPosts, postFiles } from './artboard-trash.js';
import { TRASH_ID, TRASH_PAYLOAD, TRASH_RECORD, trashFolder } from './trash-entry.js';
import { WorkspaceStorage, readTrashRecord } from './workspace-storage-host.js';
import { beginArtboardBuildTiming } from './artboard-build-timing.js';

/**
 * THE ARTBOARD, HOST SIDE (beta.33 item 14, Tynn #784; Genie 1 main/artboard/wire.ts + host.ts). The panel asks for the
 * workspace's board resolved for display (each artifact read from `.artboard/` — HTML as text, an image as a data URL), and
 * sends the person's verdict back. The verdict is written onto the post and DELIVERED to the agent that posted it, as an
 * AgentInbox message — only ever that agent (the post recorded who, from the caller): a post with nobody behind it has
 * nobody to tell, and guessing would drop someone else's decision into an unrelated agent's turn.
 */

const MIME_OK = /\.(png|jpe?g|gif|svg|webp)$/i;

async function boardPosts(root: string) {
    try { return parseBoard(await readFile(join(root, BOARD_DIR, BOARD_INDEX), 'utf8')); } catch { return []; }
}

export async function readArtBoard(root: string): Promise<ResolvedBoard> {
    const finish = beginArtboardBuildTiming('native-build', 'async');
    try { return await readResolvedArtBoard(root); } finally { finish(); }
}

async function readResolvedArtBoard(root: string): Promise<ResolvedBoard> {
    const posts = await boardPosts(root);
    // resolveBoard is synchronous over its reads; the artifacts are read first (bare names only — parseBoard refuses any other).
    const texts = new Map<string, string | null>();
    const images = new Map<string, string | null>();
    for (const p of posts) for (const v of versionsOf(p)) {
        const full = join(root, BOARD_DIR, v.file);
        if (isTextKind(v.kind)) texts.set(v.file, await readFile(full, 'utf8').catch(() => null));
        else if (v.kind === 'pdf' || MIME_OK.test(v.file)) images.set(v.file, await readFile(full).then((b) => b.toString('base64'), () => null));
    }
    const finish = beginArtboardBuildTiming('resolve-board', 'sync');
    try { return resolveBoard(posts, { readText: (f) => texts.get(f) ?? null, readBase64: (f) => images.get(f) ?? null }); } finally { finish(); }
}

export interface ReviewDeps {
    /** Deliver to the agent, as an AgentInbox message from the person. */
    readonly send: (agentId: string, text: string) => Promise<void>;
    readonly now: () => string;
}

export type ReviewResult = { ok: true; delivered: boolean; cleared?: number; trashId?: string | null } | { ok: false; error: string };

export async function reviewArtBoardPost(root: string, postId: string, review: { verdict: Review['verdict']; comment?: string | undefined }, deps: ReviewDeps): Promise<ReviewResult> {
    const board = await boardPosts(root);
    const post = board.find((p) => p.id === postId);
    if (!post) return { ok: false, error: 'That post is no longer on the board.' };
    // Its card offers no verdict; one arriving anyway (a stale panel, a hand-made call) would message an agent that
    // never asked for one (genie#1275).
    if (!wantsVerdict(post)) return { ok: false, error: 'That post did not ask for a verdict.' };
    const comment = review.comment?.trim();
    const full: Review = { verdict: review.verdict, at: deps.now(), ...(comment ? { comment } : {}) };
    await writeFile(join(root, BOARD_DIR, BOARD_INDEX), JSON.stringify({ posts: applyVerdict(board, postId, full) }, null, 2));
    if (!post.agentId) return { ok: true, delivered: false };
    await deps.send(post.agentId, verdictMessage(post, full));
    return { ok: true, delivered: true };
}

/**
 * Keep an item in the default view after its verdict, or let it hide again (Tynn #739). Written to the workspace's index, so
 * the pin survives a restart; it tells nobody — it is the person's own view of the board.
 */
export async function pinArtBoardPost(root: string, postId: string, pinned: boolean): Promise<ReviewResult> {
    const board = await boardPosts(root);
    if (!board.some((p) => p.id === postId)) return { ok: false, error: 'That post is no longer on the board.' };
    await writeFile(join(root, BOARD_DIR, BOARD_INDEX), JSON.stringify({ posts: setPinned(board, postId, pinned) }, null, 2));
    return { ok: true, delivered: false };
}

/** A clear, a delete or a restore: how many items it moved and the .trash entry that holds them (genie#847). */
export type ClearResult = { ok: true; delivered: boolean; cleared: number; trashId: string | null } | { ok: false; error: string };

const CLEAR_NAME: Record<ClearScope, string> = { decided: 'Clear decided', all: 'Clear all', everything: 'Clear all, pinned too' };
const itemCount = (n: number) => `${n} item${n === 1 ? '' : 's'}`;

/** What became of an item, for the log: a waiting item is closed without a verdict. */
const closedAs = (post: BoardPost): string => (postStatus(post) === 'waiting' ? 'cleared-without-verdict' : postStatus(post));

/** One JSON line per item onto `.artboard/history.jsonl`: the board's log, which a clear never takes away. */
async function logHistory(rootReal: string, lines: readonly Record<string, unknown>[]): Promise<void> {
    if (lines.length === 0) return;
    await appendFile(join(rootReal, BOARD_DIR, BOARD_HISTORY), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

/**
 * Tell each waiting item's agent, in its AgentInbox, the way a verdict is delivered. One agent's failed delivery does not undo
 * the board's change or stop the others; it is logged, and `delivered` says whether any was told.
 */
async function tellWaiting(posts: readonly BoardPost[], message: (post: BoardPost) => string, deps: ReviewDeps): Promise<boolean> {
    let delivered = false;
    for (const p of posts) {
        if (postStatus(p) !== 'waiting' || !p.agentId) continue;
        try { await deps.send(p.agentId, message(p)); delivered = true; } catch (error) { console.warn(`[genie] the ArtBoard could not tell ${p.agentId} about "${p.id}": ${error instanceof Error ? error.message : String(error)}`); }
    }
    return delivered;
}

/**
 * CLEAR THE BOARD (genie#847). Takes the items of a scope (core clearSelection: pinned ones stay unless `everything`), or one
 * item, off the board and MOVES them into ONE entry of the workspace's .trash, in #697's format (main/trash-entry.ts): the
 * entry's `item` holds an index of just those posts, every field kept, beside every version's file; its record's origin is
 * `artboard`, so the Storage tab lists it and its Restore puts the items back. Nothing is deleted.
 *
 * Each item gets a line in `.artboard/history.jsonl`. Each WAITING item is closed "without a verdict" and the agent that posted
 * it is told, so no agent waits forever on a card that is gone. A clear with nothing to take changes nothing.
 */
export async function clearArtBoard(root: string, pick: { scope: ClearScope } | { postId: string }, deps: ReviewDeps): Promise<ClearResult> {
    const rootReal = await realpath(root);
    const board = await boardPosts(rootReal);
    const taken = 'scope' in pick ? clearSelection(board, pick.scope) : board.filter((p) => p.id === pick.postId);
    if (!('scope' in pick) && taken.length === 0) return { ok: false, error: 'That post is no longer on the board.' };
    if (taken.length === 0) return { ok: true, delivered: false, cleared: 0, trashId: null };

    const t = await trashFolder(rootReal, true);
    if (!t.ok) return { ok: false, error: t.reason };
    const movedAt = Date.parse(deps.now()) || Date.now();
    const trashId = `genie-${movedAt}-${randomBytes(3).toString('hex')}`;
    const entry = join(t.dir!, trashId);
    const payload = join(entry, TRASH_PAYLOAD);
    const boardDir = join(rootReal, BOARD_DIR);
    const moved: string[] = [];
    try {
        await mkdir(payload, { recursive: true });
        await writeFile(join(payload, BOARD_INDEX), JSON.stringify({ posts: taken }, null, 2));
        for (const p of taken) for (const f of postFiles(p)) {
            try { await rename(join(boardDir, f), join(payload, f)); moved.push(f); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        const label = 'scope' in pick ? `${itemCount(taken.length)} (${CLEAR_NAME[pick.scope]})` : `1 item: "${taken[0]!.title}"`;
        await writeFile(join(entry, TRASH_RECORD), JSON.stringify({ version: 1, movedAt, origin: { kind: 'artboard', ids: taken.map((p) => p.id), label } }), 'utf8');
        const gone = new Set(taken.map((p) => p.id));
        await writeFile(join(boardDir, BOARD_INDEX), JSON.stringify({ posts: board.filter((p) => !gone.has(p.id)) }, null, 2));
    } catch (error) {
        // Nothing half-done: the files go back where they were and the entry goes.
        for (const f of moved) await rename(join(payload, f), join(boardDir, f)).catch(() => undefined);
        await rm(entry, { recursive: true, force: true }).catch(() => undefined);
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const at = deps.now();
    await logHistory(rootReal, taken.map((p) => ({ at, action: 'cleared', trashId, id: p.id, title: p.title, status: closedAs(p), ...(p.agentId ? { agentId: p.agentId } : {}), ...(p.review ? { review: p.review } : {}), trail: p.trail ?? [] })));
    const delivered = await tellWaiting(taken, clearedMessage, deps);
    return { ok: true, delivered, cleared: taken.length, trashId };
}

/**
 * UNDO A CLEAR (genie#847): put an ArtBoard .trash entry back, through the Storage tab's own Restore (#697) so the two are one
 * path. Only an ArtBoard entry: Undo never restores a worktree or a file. Each waiting item's agent is told it is back.
 */
export async function restoreArtBoard(root: string, trashId: string, deps: ReviewDeps): Promise<ClearResult> {
    const rootReal = await realpath(root);
    const t = await trashFolder(rootReal, false);
    if (!t.ok) return { ok: false, error: t.reason };
    const notOurs = { ok: false as const, error: 'That .trash entry is not ArtBoard items.' };
    if (t.dir === null || !TRASH_ID.test(trashId)) return notOurs;
    const entry = join(t.dir, trashId);
    const record = await readTrashRecord(entry);
    if (record?.origin.kind !== 'artboard') return notOurs;
    const posts = await artboardPayloadPosts(join(entry, TRASH_PAYLOAD));
    const back = await new WorkspaceStorage().restore(rootReal, trashId);
    if (!back.ok) return { ok: false, error: back.reason };
    const at = deps.now();
    await logHistory(rootReal, posts.map((p) => ({ at, action: 'restored', trashId, id: p.id, title: p.title })));
    const delivered = await tellWaiting(posts, restoredMessage, deps);
    return { ok: true, delivered, cleared: posts.length, trashId };
}
