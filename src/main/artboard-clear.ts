import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BOARD_DIR, BOARD_HISTORY, BOARD_INDEX, clearedMessage, clearSelection, postStatus, restoredMessage, type BoardPost, type ClearScope } from '../core/artboard.js';
import type { ReviewDeps } from './artboard-host.js';
import { artboardPayloadPosts, boardIndexPosts, postFiles } from './artboard-trash.js';
import { TRASH_ID, TRASH_PAYLOAD, TRASH_RECORD, trashFolder } from './trash-entry.js';
import { WorkspaceStorage, readTrashRecord } from './workspace-storage-host.js';

/*
 * CLEARING THE ARTBOARD (genie#847), kept apart from artboard-host.ts on purpose: artboard-host is read by Flows (through
 * mcp-tools -> question-visuals), and Undo goes through the Storage tab's Restore, which brings git and the toolchain with it.
 * Only the panel host (official-panels-host.ts) imports this file, so the Flows dependency set stays what it was.
 */

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
    const board = await boardIndexPosts(join(rootReal, BOARD_DIR));
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
