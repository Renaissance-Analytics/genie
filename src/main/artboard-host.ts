import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BOARD_DIR, BOARD_INDEX, applyVerdict, parseBoard, resolveBoard, verdictMessage, type ResolvedBoard, type Review } from '../core/artboard.js';

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
    const posts = await boardPosts(root);
    // resolveBoard is synchronous over its reads; the artifacts are read first (bare names only — parseBoard refuses any other).
    const texts = new Map<string, string | null>();
    const images = new Map<string, string | null>();
    for (const p of posts) {
        const full = join(root, BOARD_DIR, p.file);
        if (p.kind === 'html') texts.set(p.file, await readFile(full, 'utf8').catch(() => null));
        else if (MIME_OK.test(p.file)) images.set(p.file, await readFile(full).then((b) => b.toString('base64'), () => null));
    }
    return resolveBoard(posts, { readText: (f) => texts.get(f) ?? null, readBase64: (f) => images.get(f) ?? null });
}

export interface ReviewDeps {
    /** Deliver to the agent, as an AgentInbox message from the person. */
    readonly send: (agentId: string, text: string) => Promise<void>;
    readonly now: () => string;
}

export type ReviewResult = { ok: true; delivered: boolean } | { ok: false; error: string };

export async function reviewArtBoardPost(root: string, postId: string, review: { verdict: Review['verdict']; comment?: string | undefined }, deps: ReviewDeps): Promise<ReviewResult> {
    const board = await boardPosts(root);
    const post = board.find((p) => p.id === postId);
    if (!post) return { ok: false, error: 'That post is no longer on the board.' };
    const comment = review.comment?.trim();
    const full: Review = { verdict: review.verdict, at: deps.now(), ...(comment ? { comment } : {}) };
    await writeFile(join(root, BOARD_DIR, BOARD_INDEX), JSON.stringify({ posts: applyVerdict(board, postId, full) }, null, 2));
    if (!post.agentId) return { ok: true, delivered: false };
    await deps.send(post.agentId, verdictMessage(post, full));
    return { ok: true, delivered: true };
}
