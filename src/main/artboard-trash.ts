import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BOARD_DIR, BOARD_INDEX, parseBoard, versionsOf, type BoardPost } from '../core/artboard.js';

/**
 * ARTBOARD ITEMS IN .trash (genie#847). A Clear moves items off the board into ONE .trash entry (main/trash-entry.ts): its
 * `item` folder holds an `index.json` of just those posts, every field kept (verdicts, trail, pins, versions), beside every
 * version's file. This file reads that payload and puts it back; the Storage tab's Restore and the panel's Undo both come here.
 */

const isPresent = async (p: string): Promise<boolean> => { try { await lstat(p); return true; } catch { return false; } };

/** The posts on a board index, `[]` when there is none. */
export async function boardIndexPosts(boardDir: string): Promise<BoardPost[]> {
    try { return parseBoard(await readFile(join(boardDir, BOARD_INDEX), 'utf8')); } catch { return []; }
}

/** Every distinct file an item's versions name (bare names: parseBoard refuses any other). */
export function postFiles(post: BoardPost): string[] {
    return [...new Set(versionsOf(post).map((v) => v.file))];
}

/** The posts a cleared payload holds. */
export async function artboardPayloadPosts(payload: string): Promise<BoardPost[]> {
    return boardIndexPosts(payload);
}

/**
 * Put a cleared payload back on the workspace's board: its files back into `.artboard/`, its posts back into the index with
 * everything they had. Never over what is there now: an item on the board again (re-posted since) or a file of the same name
 * refuses the whole restore, and the entry stays in .trash. Never through a link: `.artboard` must be the workspace's own folder.
 */
export async function restoreArtboardPayload(rootReal: string, payload: string): Promise<{ ok: true; posts: BoardPost[] } | { ok: false; reason: string }> {
    const posts = await artboardPayloadPosts(payload);
    if (posts.length === 0) return { ok: false, reason: 'That .trash entry holds no ArtBoard items Genie can put back.' };
    const dir = join(rootReal, BOARD_DIR);
    try {
        const s = await lstat(dir);
        if (s.isSymbolicLink() || !s.isDirectory()) return { ok: false, reason: 'This workspace’s .artboard is not a folder: Genie will not restore into it.' };
    } catch {
        await mkdir(dir);
    }
    const board = await boardIndexPosts(dir);
    const again = posts.find((p) => board.some((b) => b.id === p.id));
    if (again) return { ok: false, reason: `"${again.title}" (${again.id}) is already on the board again: delete it there first, then restore.` };
    const files: string[] = [];
    for (const p of posts) for (const f of postFiles(p)) if (await isPresent(join(payload, f))) files.push(f);
    for (const f of files) if (await isPresent(join(dir, f))) return { ok: false, reason: `Something is already at .artboard/${f}: move it away first.` };
    const moved: string[] = [];
    try {
        for (const f of files) { await rename(join(payload, f), join(dir, f)); moved.push(f); }
        await writeFile(join(dir, BOARD_INDEX), JSON.stringify({ posts: [...board, ...posts] }, null, 2));
    } catch (error) {
        for (const f of moved) await rename(join(dir, f), join(payload, f)).catch(() => undefined);
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, posts };
}
