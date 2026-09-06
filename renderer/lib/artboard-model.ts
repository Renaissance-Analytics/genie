/**
 * ArtBoard, as the PANEL sees it.
 *
 * Deliberately not the same shape the board stores on disk. A stored post names
 * a FILE; the renderer cannot read the filesystem, so main resolves each post
 * into something displayable before it crosses the IPC boundary — inline markup
 * for an html post, a `data:` URL for an image.
 *
 * Resolving host-side is also what keeps the panel from ever holding a path: it
 * receives content, so there is nothing for it to be tricked into fetching.
 */

import type { ReviewDelivery, ReviewResult } from '../../main/artboard/host';

export type { ReviewDelivery };

export interface BoardReview {
    verdict: 'approved' | 'rejected';
    comment?: string;
    at: string;
}

export interface BoardPost {
    id: string;
    title: string;
    kind: 'html' | 'image';
    createdAt: string;
    note?: string;
    review?: BoardReview;
    /** kind `html`: the markup, rendered in a sandboxed frame. */
    html?: string;
    /** kind `image`: a `data:` URL. */
    src?: string;
}

export interface BoardRead {
    posts: BoardPost[];
    /** Set when the board could not be read in full — a post whose file is gone,
     *  an unreadable index. The posts that DID resolve are still returned, so one
     *  bad entry never blanks the board. */
    error?: string;
}

/**
 * What `artboard:review` answers with. The TYPE is main's (`main/artboard/host`)
 * — imported rather than re-declared so the panel cannot drift from the host it
 * reads, which is how the panel ended up asserting three facts about one bit.
 */
export type ReviewOutcome = ReviewResult;

/**
 * What the panel SAYS after a verdict — one sentence per delivery outcome.
 *
 * genie#462: the panel had a single boolean and reported a specific cause for
 * it — "the agent that posted it is no longer running, so nothing was
 * delivered". It had never checked that. Until genie#456 no post recorded a
 * terminal at all, so EVERY verdict was undelivered and every one of them blamed
 * an agent that was alive and waiting; the owner went hunting an agent-lifecycle
 * problem that did not exist while the real fault — a post with nowhere to
 * deliver to — hid behind the story.
 *
 * The rule here is narrow and absolute: say only what the host established. Each
 * outcome gets its own sentence, and `no-terminal` is named as the regression it
 * would be rather than folded back into "your agent died".
 */
export function reviewNotice(
    title: string,
    verdict: 'approved' | 'rejected',
    delivery: ReviewDelivery,
): string {
    const recorded = `“${title}” ${verdict}`;
    switch (delivery) {
        case 'delivered':
            return `${recorded}. The agent has been told.`;
        case 'no-agent':
            return `${recorded}, and recorded on the board — but the agent that posted it is no longer running, so nothing was delivered.`;
        case 'refused':
            return `${recorded}, and recorded on the board — but Genie refused to hand it to the agent, so it has not been told. The agent may still be waiting.`;
        case 'no-terminal':
            return `${recorded}, and recorded on the board — but the post named no terminal, so there was nobody to deliver it to. Every post has recorded its terminal since genie#456, so that is a regression in posting, not a closed agent.`;
    }
}

/**
 * Which post the REVIEW CARD shows. Falling back to the newest post is right
 * here: the card is the panel's content, and a board with posts on it should
 * never show an empty card.
 */
export function resolveActiveBoardPost(
    posts: readonly BoardPost[],
    requestedId?: string | null,
): BoardPost | null {
    if (requestedId) {
        const requested = posts.find((post) => post.id === requestedId);
        if (requested) return requested;
    }
    return posts[0] ?? null;
}

/**
 * Which post the CANVAS is zoomed into — a different question, and deliberately
 * WITHOUT the fallback above.
 *
 * fancy-artboard is controlled for focus, so whatever this returns is what the
 * canvas shows on the next render. Falling back to the newest post would mean a
 * board with any post on it is permanently in focus mode: dismissing it calls
 * `onFocusChange(null)`, and the fallback would hand the same post straight back
 * (genie#457). Null is a state the canvas must be able to reach and stay in.
 *
 * A focus naming a post that has since left the board resolves to null rather
 * than to a different post — the reviewer asked to look at THAT artifact, and
 * silently zooming a neighbour would answer a question they did not ask.
 */
export function resolveBoardFocus(
    posts: readonly BoardPost[],
    focusedId: string | null,
): string | null {
    if (!focusedId) return null;
    return posts.some((post) => post.id === focusedId) ? focusedId : null;
}
