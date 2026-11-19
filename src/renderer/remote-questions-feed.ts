import type { DisplayPost, ResolvedBoard } from '../core/artboard.js';
import type { DeckItem } from '../core/deck.js';
import { selectVisualPosts, visualRefsOf } from '../core/question-visuals.js';

/** One empty list, so a window that drives nothing reports once, not on every render. */
const NONE: readonly DeckItem[] = Object.freeze([]);

/**
 * WHAT THIS WINDOW REPORTS TO ITS MAIN PROCESS'S QUESTION WINDOW (Tynn #726 part 1): driving another machine, that
 * machine and its Deck (main keeps only the live questions, main/remote-questions.ts); otherwise nothing, which takes back
 * what it reported before.
 */
export function remoteQuestionFeed(input: { connected: boolean; host: string | null; items: readonly DeckItem[] | null }): { host: string; items: readonly DeckItem[] } {
    if (!input.connected || !input.host) return { host: input.host ?? '', items: NONE };
    return { host: input.host, items: input.items ?? NONE };
}

/** How an answer the question window sent back came out, for main: ok, or the host's refusal in its own words. */
export async function answerOutcome(act: () => Promise<unknown>): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
        await act();
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * A connected machine's question's VISUALS (Tynn #835), read where they live: that machine's ArtBoard, through this
 * window's board reader (the ArtBoard tab's). Each the version the question named; a read that fails is the reason.
 */
export async function visualsOutcome(item: DeckItem, read: (workspaceId: string) => Promise<ResolvedBoard>): Promise<{ ok: true; posts: DisplayPost[] } | { ok: false; reason: string }> {
    try {
        const refs = visualRefsOf(item.answer.kind === 'form' ? item.answer.questions ?? [] : []);
        if (refs.length === 0) return { ok: true, posts: [] };
        if (!item.workspaceId) return { ok: false, reason: 'that question names no workspace' };
        const board = await read(item.workspaceId);
        return { ok: true, posts: selectVisualPosts(board.posts, refs) };
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
}
