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

export interface ReviewOutcome {
    ok: boolean;
    /** Whether the posting agent was actually told. Separate from `ok` because a
     *  recorded-but-undelivered verdict is a success with a caveat. */
    delivered: boolean;
    error?: string;
}

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
