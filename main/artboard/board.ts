/**
 * ArtBoard — the contract between the agent that POSTS and the panel that SHOWS.
 *
 * The problem: an agent that has MADE something has no way to show it. It can
 * describe the thing in words through ForceTheQuestion, which is exactly what a
 * visual review surface exists to avoid — you cannot review a mockup from a
 * paragraph about the mockup.
 *
 * A plugin worker is FILESYSTEM-ONLY (it holds no UI authority and cannot draw),
 * so the shape follows from the platform: the agent writes a post into the
 * workspace, and a Genie-authored panel reads and renders it. This module is the
 * index those two halves agree on.
 *
 * UNTRUSTED AT PARSE TIME. This file is written by a plugin worker and rendered
 * in Genie's UI, so a malformed entry is DROPPED rather than allowed to fail the
 * board: one bad post must not cost the others. Nothing here throws.
 */

/** The board's directory, at the workspace root. Self-describing, and a single
 *  place to gitignore or delete. */
export const BOARD_DIR = '.artboard';

/** The index inside it. */
export const BOARD_INDEX = 'index.json';

/**
 * What a post IS. The `kind` selects the panel's renderer, so it is a CLOSED set
 * — an unknown kind is a post nothing can draw, and listing it would put a
 * permanently broken card on the board.
 *
 * Two kinds, both chosen deliberately: a rendered HTML mockup (the case this
 * exists for) and an image the agent generated. `video` is RESERVED for when the
 * Remotion GApp can produce one — Remotion is then a consumer of this board for
 * storyboarding, not a second review surface. Adding it is a new entry here plus
 * a renderer in the panel; nothing else in the format changes.
 */
export const POST_KINDS = ['html', 'image'] as const;
export type PostKind = (typeof POST_KINDS)[number];

export interface BoardPost {
    /** Stable per THING, not per posting — re-posting a revision replaces it. */
    id: string;
    title: string;
    kind: PostKind;
    /**
     * The payload's BARE FILENAME inside {@link BOARD_DIR} (or, for `url`, the
     * address). Never a path: the panel loads whatever this names, so a post
     * naming `../../.ssh/id_rsa` would turn the board into a file-disclosure
     * surface.
     */
    file: string;
    createdAt: string;
    /** Optional one-line note from the agent — what it wants looked at. */
    note?: string;
    /**
     * The terminal that posted this, so a verdict can be delivered back to the
     * agent waiting on it. Stamped HOST-SIDE — `worker-host` passes `terminalId`
     * into every plugin tool call — never claimed by the agent, so a post cannot
     * ask for someone else's verdict to be routed to it.
     *
     * Absent for a post nothing is waiting on (hand-written, or imported).
     */
    terminalId?: string;
    /** The human's decision, once made. Absent means "not reviewed yet", which
     *  is what the panel shows as awaiting review. */
    review?: Review;
}

/**
 * A decision on one post.
 *
 * The comment is OPTIONAL by design: an approval usually needs no words, and
 * requiring one would make the cheap case expensive and push reviewers toward
 * empty strings.
 */
export interface Review {
    verdict: 'approved' | 'rejected';
    comment?: string;
    at: string;
}

/** How many posts a board keeps. A looping agent must not be able to grow this
 *  without bound, and the NEWEST are the ones worth keeping — an agent posting
 *  repeatedly should push out its own old drafts. */
const MAX_POSTS = 100;

/** A literal backslash, named so codegen and heredocs cannot mangle it. */
const BACKSLASH = String.fromCharCode(92);

function isPostKind(v: unknown): v is PostKind {
    return typeof v === 'string' && (POST_KINDS as readonly string[]).includes(v);
}

/**
 * A bare filename, and nothing that can climb out of the board directory.
 * Rejects separators of BOTH kinds (a Windows path is not safe just because it
 * contains no forward slash), drive letters, and any `..` segment.
 */
function isBareFilename(v: unknown): v is string {
    if (typeof v !== 'string' || v.length === 0) return false;
    if (v.includes('/') || v.includes(BACKSLASH)) return false;
    if (v.includes('..')) return false;
    if (/^[a-zA-Z]:/.test(v)) return false;
    return true;
}

function toPost(raw: unknown): BoardPost | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id) return null;
    if (typeof r.title !== 'string' || !r.title) return null;
    if (!isPostKind(r.kind)) return null;
    if (typeof r.createdAt !== 'string' || !r.createdAt) return null;
    if (!isBareFilename(r.file)) return null;
    const post: BoardPost = {
        id: r.id,
        title: r.title,
        kind: r.kind,
        file: r.file as string,
        createdAt: r.createdAt,
    };
    if (typeof r.note === 'string' && r.note) post.note = r.note;
    if (typeof r.terminalId === 'string' && r.terminalId) post.terminalId = r.terminalId;
    const rev = r.review;
    if (typeof rev === 'object' && rev !== null) {
        const v = (rev as Record<string, unknown>).verdict;
        const at = (rev as Record<string, unknown>).at;
        if ((v === 'approved' || v === 'rejected') && typeof at === 'string' && at) {
            const review: Review = { verdict: v, at };
            const c = (rev as Record<string, unknown>).comment;
            if (typeof c === 'string' && c) review.comment = c;
            post.review = review;
        }
    }
    return post;
}

/** PURE. Read the index. Never throws — junk, an absent file read as '', or a
 *  half-written array all resolve to "no posts" rather than a broken panel. */
export function parseBoard(raw: string): BoardPost[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (typeof parsed !== 'object' || parsed === null) return [];
    const posts = (parsed as { posts?: unknown }).posts;
    if (!Array.isArray(posts)) return [];
    return posts
        .map(toPost)
        .filter((p): p is BoardPost => p !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** PURE. Add or REPLACE a post, newest first, capped. */
export function addPost(board: BoardPost[], post: BoardPost): BoardPost[] {
    const rest = board.filter((p) => p.id !== post.id);
    return [post, ...rest].slice(0, MAX_POSTS);
}

/**
 * PURE. Record a decision on one post.
 *
 * REPLACES any earlier verdict rather than appending: the board answers "what
 * was decided", and two verdicts on one post cannot answer it. A reviewer who
 * changes their mind is the normal case, not an edge one.
 *
 * A verdict for a post that is not on the board is a no-op — it is what a stale
 * panel or a deleted post produces, and inventing a post to hang it on would be
 * worse than dropping it.
 */
export function applyVerdict(board: BoardPost[], id: string, review: Review): BoardPost[] {
    return board.map((p) => (p.id === id ? { ...p, review } : p));
}

/**
 * What the AGENT is told. Delivered as a message so the agent hears the decision
 * without polling the board it cannot see.
 *
 * Always names the post, because an agent may have several in flight and
 * "approved" on its own is unactionable. A REJECTION says what to do next: an
 * agent reading only "rejected" either guesses at the fix or interrupts to ask,
 * and preventing exactly that is why the board exists.
 */
export function verdictMessage(post: BoardPost, review: Review): string {
    const head = `ArtBoard — "${post.title}" was ${review.verdict}.`;
    const comment = review.comment ? ` Comment: ${review.comment}` : ' No comment was left.';
    if (review.verdict === 'rejected') {
        return `${head}${comment} Revise it and post again with the SAME id (\`${post.id}\`) so the board replaces this entry rather than stacking a second card beside it.`;
    }
    return `${head}${comment}`;
}
