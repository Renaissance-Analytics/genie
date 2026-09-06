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

/**
 * What became of the verdict on its way to the agent — genie#462.
 *
 * This used to be one boolean, and the panel turned that single bit into a
 * confident, specific cause ("the agent that posted it is no longer running")
 * that nothing had checked. Three unrelated situations reach the same failure,
 * and they ask different things of the reader:
 *
 *  - `no-agent`    — the terminal has no agent identity any more. The verdict is
 *                    safely on the board; nobody is coming back for it.
 *  - `refused`     — the broker declined the message. The agent may well be alive
 *                    and still waiting, which is a different problem entirely.
 *  - `no-terminal` — the post recorded no terminal to deliver to. After genie#456
 *                    that should be impossible, so it is a REGRESSION to name out
 *                    loud rather than dress up as a dead agent — hiding it behind
 *                    that sentence is exactly what cost the owner the first time.
 */
export type ReviewDelivery = 'delivered' | 'no-terminal' | 'no-agent' | 'refused';

/** What a delivery ATTEMPT can come back as. `no-terminal` is not here: it is
 *  decided before there is anything to attempt. */
export type DeliveryAttempt = Exclude<ReviewDelivery, 'no-terminal'>;

export interface ReviewDeps {
    readBoard: (workspaceId: string) => BoardPost[];
    writeBoard: (workspaceId: string, board: BoardPost[]) => void;
    /** Deliver to the posting agent, saying WHY when it does not land. */
    deliver: (terminalId: string, text: string) => DeliveryAttempt;
    now: () => string;
}

/**
 * A discriminated union rather than a flat record, so the delivery outcome
 * cannot be read off a refusal that never attempted one — and so a caller that
 * wants to explain the outcome has to look at `ok` first.
 */
export type ReviewResult =
    | { ok: false; error: string }
    | {
          ok: true;
          /** Whether the AGENT was actually told, and when not, WHY. Distinct
           *  from `ok` on purpose: a recorded-but-undelivered verdict is a
           *  success with a caveat, and reporting it as a clean success would
           *  imply the agent is acting on it. */
          delivery: ReviewDelivery;
      };

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
        return { ok: false, error: 'That post is no longer on the board.' };
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
    const delivery: ReviewDelivery = post.terminalId
        ? deps.deliver(post.terminalId, verdictMessage(post, full))
        : 'no-terminal';

    return { ok: true, delivery };
}
