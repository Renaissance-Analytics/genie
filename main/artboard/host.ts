import { applyVerdict, verdictMessage, type BoardPost, type Review } from './board';

/**
 * ArtBoard's HOST half: recording a verdict and getting it back to the agent.
 *
 * Recording it on the board is not enough — the agent cannot see the board. A
 * verdict that does not reach the agent leaves ArtBoard a place where work goes
 * to be looked at and nothing happens, which is the situation it exists to end.
 *
 * So both, in one operation, with the DURABLE half first: the board is written
 * even when nobody is listening, because a human made a real judgement and it
 * must not be lost to a closed terminal.
 */

export interface ReviewDeps {
    readBoard: (workspaceId: string) => BoardPost[];
    writeBoard: (workspaceId: string, board: BoardPost[]) => void;
    /** Deliver to the posting agent. False when that terminal has no agent
     *  identity any more (closed, or never registered). */
    deliver: (terminalId: string, text: string) => boolean;
    now: () => string;
}

export interface ReviewResult {
    ok: boolean;
    /** Whether the AGENT was actually told. Distinct from `ok` on purpose: a
     *  recorded-but-undelivered verdict is a success with a caveat, and reporting
     *  it as a clean success would imply the agent is acting on it. */
    delivered: boolean;
    error?: string;
}

export function reviewPost(
    workspaceId: string,
    postId: string,
    review: { verdict: Review['verdict']; comment?: string },
    deps: ReviewDeps,
): ReviewResult {
    const board = deps.readBoard(workspaceId);
    const post = board.find((p) => p.id === postId);
    if (!post) {
        // A stale panel, or a post since dropped by the cap. Inventing a post to
        // hang the verdict on would be worse than refusing it.
        return { ok: false, delivered: false, error: 'That post is no longer on the board.' };
    }

    const full: Review = {
        verdict: review.verdict,
        at: deps.now(),
        ...(review.comment ? { comment: review.comment } : {}),
    };
    deps.writeBoard(workspaceId, applyVerdict(board, postId, full));

    // Only ever to the terminal the POST recorded. A post with none has nobody
    // waiting on it, and guessing would drop someone else's board decision into
    // an unrelated agent's turn.
    const delivered = post.terminalId
        ? deps.deliver(post.terminalId, verdictMessage(post, full))
        : false;

    return { ok: true, delivered };
}
