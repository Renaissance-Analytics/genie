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

import { formatRoute, parseRoute } from './route.js';

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
 * Four kinds: a rendered HTML mockup (a component, a page or a site — the case this exists for), an image the agent
 * generated, and two documents, Markdown and PDF (Tynn #739). `video` is RESERVED for when the
 * Remotion GApp can produce one — Remotion is then a consumer of this board for
 * storyboarding, not a second review surface. Adding it is a new entry here plus
 * a renderer in the panel; nothing else in the format changes.
 */
export const POST_KINDS = ['html', 'image', 'markdown', 'pdf'] as const;
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
     * agent waiting on it. Stamped HOST-SIDE — `worker-host` passes `agentId`
     * into every plugin tool call — never claimed by the agent, so a post cannot
     * ask for someone else's verdict to be routed to it.
     *
     * Absent for a post nothing is waiting on (hand-written, or imported).
     */
    agentId?: string;
    /**
     * Whether the poster wants a verdict (genie#1275 — the owner: "They aren't always used for Approval either.").
     * `false`: the card just shows the artifact. ABSENT means a post from before the field existed: Genie 1 and Genie 2
     * until #1275 promised every poster a verdict, so those still ask (read it through {@link wantsVerdict}). The tool
     * always writes it, so absence never comes from a new post.
     */
    askVerdict?: boolean;
    /** The human's decision, once made. Absent means "not reviewed yet", which
     *  is what the panel shows as awaiting review. */
    review?: Review;
    /** Who posted the latest version, by name (stamped host-side with `agentId`). */
    agentName?: string;
    /** The size an HTML item was made for, in CSS pixels: shown at that size, scaled to fit. Absent = fill the panel. */
    width?: number;
    height?: number;
    /**
     * EVERY revision (Tynn #739): re-posting an id appends a version instead of replacing the item. Absent on an item stored
     * before versions existed — read it through {@link versionsOf}, which counts it as version 1.
     */
    versions?: PostVersion[];
    /** The paper trail: every verdict and every agent reply, in the order they happened. Kept for as long as the workspace is. */
    trail?: TrailEntry[];
    /** The person kept this item in the default view after a verdict. Absent = not pinned. */
    pinned?: boolean;
}

/** One revision of an item: its own file, so an earlier version is still there to look at beside the later one. */
export interface PostVersion {
    n: number;
    file: string;
    kind: PostKind;
    title: string;
    createdAt: string;
    note?: string;
    agentId?: string;
    agentName?: string;
    width?: number;
    height?: number;
}

/** A verdict or a reply, against the version it was about. Verdicts are APPENDED — {@link BoardPost.review} is only the latest. */
export type TrailEntry =
    | { type: 'verdict'; version: number; verdict: 'approved' | 'rejected'; comment?: string; at: string; by?: string }
    | { type: 'reply'; version: number; text: string; at: string; agentId?: string; agentName?: string };

export type PostStatus = 'waiting' | 'approved' | 'rejected' | 'shown';
export type BoardFilter = 'waiting' | 'decided' | 'all';

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

/**
 * How many posts a board keeps. A looping agent must not be able to grow this without bound, and the NEWEST are the ones worth
 * keeping — an agent posting repeatedly should push out its own old drafts. But an item with a trail (a verdict, a reply, a
 * second version) or a pin is NEVER pushed out: the paper trail lasts as long as the workspace does (Tynn #739).
 */
const MAX_POSTS = 500;

/** A comment in the trail is cut here; the person's whole comment still went to the agent that was waiting on it. */
export const TRAIL_COMMENT_MAX = 20_000;
const CUT = ' … [cut]';

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

const sizeValue = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10_000 ? v : undefined);
function sizeOf(r: Record<string, unknown>): { width?: number; height?: number } {
    const width = sizeValue(r.width), height = sizeValue(r.height);
    return { ...(width ? { width } : {}), ...(height ? { height } : {}) };
}

function toVersion(raw: unknown): PostVersion | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.n !== 'number' || !Number.isInteger(r.n) || r.n < 1) return null;
    if (!isBareFilename(r.file) || !isPostKind(r.kind)) return null;
    if (typeof r.createdAt !== 'string' || !r.createdAt || typeof r.title !== 'string' || !r.title) return null;
    const v: PostVersion = { n: r.n, file: r.file, kind: r.kind, title: r.title, createdAt: r.createdAt };
    if (typeof r.note === 'string' && r.note) v.note = r.note;
    if (typeof r.agentId === 'string' && r.agentId) v.agentId = r.agentId;
    if (typeof r.agentName === 'string' && r.agentName) v.agentName = r.agentName;
    const size = sizeOf(r);
    if (size.width) v.width = size.width;
    if (size.height) v.height = size.height;
    return v;
}

function toTrailEntry(raw: unknown): TrailEntry | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 1) return null;
    if (typeof r.at !== 'string' || !r.at) return null;
    if (r.type === 'verdict') {
        if (r.verdict !== 'approved' && r.verdict !== 'rejected') return null;
        const e: TrailEntry = { type: 'verdict', version: r.version, verdict: r.verdict, at: r.at };
        if (typeof r.comment === 'string' && r.comment) e.comment = r.comment;
        if (typeof r.by === 'string' && r.by) e.by = r.by;
        return e;
    }
    if (r.type === 'reply') {
        if (typeof r.text !== 'string' || !r.text.trim()) return null;
        const e: TrailEntry = { type: 'reply', version: r.version, text: r.text, at: r.at };
        if (typeof r.agentId === 'string' && r.agentId) e.agentId = r.agentId;
        if (typeof r.agentName === 'string' && r.agentName) e.agentName = r.agentName;
        return e;
    }
    return null;
}

/** The trail entries in a raw value that are well-formed; the rest are dropped (the wire and the index are both untrusted). */
export function trailFrom(raw: unknown): TrailEntry[] {
    return Array.isArray(raw) ? raw.map(toTrailEntry).filter((e): e is TrailEntry => e !== null) : [];
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
    if (typeof r.agentId === 'string' && r.agentId) post.agentId = r.agentId;
    if (typeof r.askVerdict === 'boolean') post.askVerdict = r.askVerdict;
    if (typeof r.agentName === 'string' && r.agentName) post.agentName = r.agentName;
    const size = sizeOf(r);
    if (size.width) post.width = size.width;
    if (size.height) post.height = size.height;
    if (r.pinned === true) post.pinned = true;
    if (Array.isArray(r.versions)) {
        const versions = r.versions.map(toVersion).filter((v): v is PostVersion => v !== null);
        if (versions.length > 0) post.versions = versions;
    }
    if (Array.isArray(r.trail)) {
        const trail = r.trail.map(toTrailEntry).filter((e): e is TrailEntry => e !== null);
        if (trail.length > 0) post.trail = trail;
    }
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

/** Whether a post asks for Approve / Reject. Only an explicit `false` says no; see {@link BoardPost.askVerdict}. */
export function wantsVerdict(post: Pick<BoardPost, 'askVerdict'>): boolean {
    return post.askVerdict !== false;
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

/** An item's versions, oldest first. An item stored before versions existed is one version: itself. */
export function versionsOf(post: BoardPost): PostVersion[] {
    if (post.versions && post.versions.length > 0) return post.versions;
    return [versionFrom(post, 1)];
}

function versionFrom(post: BoardPost, n: number): PostVersion {
    return {
        n, file: post.file, kind: post.kind, title: post.title, createdAt: post.createdAt,
        ...(post.note ? { note: post.note } : {}),
        ...(post.agentId ? { agentId: post.agentId } : {}),
        ...(post.agentName ? { agentName: post.agentName } : {}),
        ...(post.width ? { width: post.width } : {}),
        ...(post.height ? { height: post.height } : {}),
    };
}

const latestVersion = (post: BoardPost): number => versionsOf(post).at(-1)?.n ?? 1;

/** The number the next post of this id will be — what its file is named by, so an earlier version's file is never overwritten. */
export function nextVersionNumber(board: BoardPost[], id: string): number {
    const existing = board.find((p) => p.id === id);
    return existing ? latestVersion(existing) + 1 : 1;
}

/** `id.html` for version 1 (what every earlier board has), `id.v2.html` after — one file per version. */
export function versionFile(id: string, n: number, ext: string): string {
    return n <= 1 ? `${id}${ext}` : `${id}.v${n}${ext}`;
}

/** Items that must outlive the cap: they carry a decision, a conversation, a revision or the person's pin. */
const isKept = (p: BoardPost): boolean => p.pinned === true || p.review !== undefined || (p.trail?.length ?? 0) > 0 || (p.versions?.length ?? 0) > 1;

function capped(board: BoardPost[]): BoardPost[] {
    if (board.length <= MAX_POSTS) return board;
    let room = Math.max(0, MAX_POSTS - board.filter(isKept).length);
    return board.filter((p) => isKept(p) || room-- > 0);
}

/**
 * PURE. Add a post, newest first. A post with an id already on the board is a REVISION: it becomes the item's newest version
 * (the earlier ones stay, each with its own file), the item awaits a verdict again, and its trail and pin carry over
 * (Tynn #739 — it used to replace, which threw the history away).
 */
export function addPost(board: BoardPost[], post: BoardPost): BoardPost[] {
    const existing = board.find((p) => p.id === post.id);
    const rest = board.filter((p) => p.id !== post.id);
    const prior = existing ? versionsOf(existing) : [];
    const next: BoardPost = { ...post, versions: [...prior, versionFrom(post, (prior.at(-1)?.n ?? 0) + 1)] };
    delete next.review;
    delete next.trail;
    delete next.pinned;
    if (existing?.trail) next.trail = existing.trail;
    if (existing?.pinned) next.pinned = true;
    return capped([next, ...rest]);
}

const cut = (text: string): string => (text.length > TRAIL_COMMENT_MAX ? text.slice(0, TRAIL_COMMENT_MAX) + CUT : text);

/**
 * PURE. Record a decision on one post: it becomes the item's `review` (what was decided, latest) AND is appended to its trail
 * (what was decided, ever). A reviewer who changes their mind leaves both verdicts on the record.
 *
 * A verdict for a post that is not on the board is a no-op — it is what a stale panel or a deleted post produces, and
 * inventing a post to hang it on would be worse than dropping it.
 */
export function applyVerdict(board: BoardPost[], id: string, review: Review, by = 'person'): BoardPost[] {
    return board.map((p) => {
        if (p.id !== id) return p;
        const entry: TrailEntry = { type: 'verdict', version: latestVersion(p), verdict: review.verdict, ...(review.comment ? { comment: cut(review.comment) } : {}), at: review.at, by };
        return { ...p, review, trail: [...(p.trail ?? []), entry] };
    });
}

/** PURE. An agent's reply to what the person said, against the version it was written for. Blank is nothing to keep. */
export function addReply(board: BoardPost[], id: string, reply: { text: string; at: string; agentId?: string; agentName?: string }): BoardPost[] {
    const text = reply.text.trim();
    if (!text) return board;
    return board.map((p) => {
        if (p.id !== id) return p;
        const entry: TrailEntry = { type: 'reply', version: latestVersion(p), text: cut(text), at: reply.at, ...(reply.agentId ? { agentId: reply.agentId } : {}), ...(reply.agentName ? { agentName: reply.agentName } : {}) };
        return { ...p, trail: [...(p.trail ?? []), entry] };
    });
}

/** PURE. Keep an item in the default view after its verdict, or let it hide again. */
export function setPinned(board: BoardPost[], id: string, pinned: boolean): BoardPost[] {
    return board.map((p) => {
        if (p.id !== id) return p;
        const { pinned: _was, ...rest } = p;
        return pinned ? { ...rest, pinned: true } : rest;
    });
}

export function postStatus(post: Pick<BoardPost, 'askVerdict' | 'review'>): PostStatus {
    if (post.review) return post.review.verdict;
    return wantsVerdict(post) ? 'waiting' : 'shown';
}

/**
 * PURE. What the board shows. `waiting` (the default) hides what has been decided — unless the person pinned it, or a link
 * points straight at it (`focusId`). `decided` is the decided; `all` is everything. Order is the board's own.
 */
export function visiblePosts<T extends { id: string; review?: unknown; pinned?: boolean | undefined }>(posts: readonly T[], filter: BoardFilter, focusId: string | null = null): T[] {
    if (filter === 'all') return [...posts];
    if (filter === 'decided') return posts.filter((p) => p.review !== undefined);
    return posts.filter((p) => p.review === undefined || p.pinned === true || p.id === focusId);
}

/** The tab's badge: items that asked for a verdict and have none. Pinning a decided item does not make it wait again. */
export function waitingCount(posts: readonly { askVerdict?: boolean | undefined; review?: unknown }[]): number {
    return posts.filter((p) => p.askVerdict !== false && p.review === undefined).length;
}

export type TimelineEvent =
    | { kind: 'version'; version: number; at: string; by?: string; note?: string }
    | { kind: 'verdict'; version: number; at: string; verdict: 'approved' | 'rejected'; comment?: string; by?: string }
    | { kind: 'reply'; version: number; at: string; text: string; by?: string };

/** PURE. Everything that happened to an item, oldest first: each version posted, each verdict, each reply. */
export function timelineOf(versions: readonly { n: number; createdAt: string; by?: string | undefined; note?: string | undefined }[], trail: readonly TrailEntry[]): TimelineEvent[] {
    const events: TimelineEvent[] = [
        ...versions.map((v): TimelineEvent => ({ kind: 'version', version: v.n, at: v.createdAt, ...(v.by ? { by: v.by } : {}), ...(v.note ? { note: v.note } : {}) })),
        ...trail.map((e): TimelineEvent => e.type === 'verdict'
            ? { kind: 'verdict', version: e.version, at: e.at, verdict: e.verdict, ...(e.comment ? { comment: e.comment } : {}), ...(e.by ? { by: e.by } : {}) }
            : { kind: 'reply', version: e.version, at: e.at, text: e.text, ...(e.agentName ? { by: e.agentName } : {}) }),
    ];
    return events.map((e, i) => ({ e, i })).sort((x, y) => x.e.at.localeCompare(y.e.at) || x.i - y.i).map(({ e }) => e);
}

export function trailTimeline(post: BoardPost): TimelineEvent[] {
    return timelineOf(versionsOf(post).map((v) => ({ n: v.n, createdAt: v.createdAt, by: v.agentName, note: v.note })), post.trail ?? []);
}

/** PURE. What an agent is told when it reads an item's trail: its status, the last verdict (with its comment), and the whole history. */
export function trailOf(post: BoardPost) {
    const lastEntry = [...(post.trail ?? [])].reverse().find((e): e is Extract<TrailEntry, { type: 'verdict' }> => e.type === 'verdict');
    const lastVerdict = lastEntry
        ? { verdict: lastEntry.verdict, version: lastEntry.version, at: lastEntry.at, ...(lastEntry.comment ? { comment: lastEntry.comment } : {}) }
        : post.review ? { verdict: post.review.verdict, version: latestVersion(post), at: post.review.at, ...(post.review.comment ? { comment: post.review.comment } : {}) } : null;
    return {
        id: post.id,
        title: post.title,
        kind: post.kind,
        status: postStatus(post),
        askedForVerdict: wantsVerdict(post),
        pinned: post.pinned === true,
        currentVersion: latestVersion(post),
        lastVerdict,
        versions: versionsOf(post).map((v) => ({ version: v.n, title: v.title, postedAt: v.createdAt, ...(v.agentName ? { by: v.agentName } : {}), ...(v.note ? { note: v.note } : {}) })),
        events: trailTimeline(post),
    };
}

/** The link that opens the workspace on its ArtBoard tab, on one item — what a question or notification about a post carries. */
export function artboardItemRoute(workspaceId: string, postId: string): string {
    const base = parseRoute(`genie://workspace/${encodeURIComponent(workspaceId)}`);
    return base.surface === 'workspace' ? formatRoute({ ...base, view: 'artboard', artboardItem: postId }) : `genie://workspace/${encodeURIComponent(workspaceId)}`;
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


/**
 * Turn stored posts into DISPLAYABLE ones.
 *
 * A stored post names a file inside `.artboard/`; the renderer cannot read the
 * filesystem, so the content is resolved here and crosses the IPC boundary as
 * markup or a `data:` URL. That also means the panel never holds a path, so
 * there is nothing for it to be tricked into fetching.
 *
 * PURE — the reads are injected — because this is where a malformed board turns
 * into what a human sees, and that judgement is worth testing without a disk.
 */

/** One revision, resolved for display. `n` is its version number; the content is whichever of html / src / text its kind uses. */
export interface DisplayVersion {
    n: number;
    kind: PostKind;
    createdAt: string;
    note?: string;
    poster?: string;
    html?: string;
    src?: string;
    text?: string;
    contentError?: string;
}

export interface DisplayPost {
    id: string;
    title: string;
    kind: PostKind;
    createdAt: string;
    note?: string;
    /** Resolved: true shows Approve / Reject and the comment box; false shows the artifact only. */
    askVerdict: boolean;
    review?: BoardPost['review'];
    html?: string;
    src?: string;
    /** A Markdown document, to render. */
    text?: string;
    /** A listed artifact that could not be inspected is kept visible with its failure. */
    contentError?: string;
    /** Who posted the latest version. */
    poster?: string;
    /** The size an HTML item was made for (CSS pixels). */
    width?: number;
    height?: number;
    /** The person kept it in the default view after a verdict. */
    pinned?: true;
    /** Every verdict and reply, in order. Absent when there are none. */
    trail?: TrailEntry[];
    /** Every version, oldest first, the latest included. Absent when there is only one: nothing to compare. */
    versions?: DisplayVersion[];
}

export interface ResolveDeps {
    /** Read a post's file as text. Throws / returns null when it is gone. */
    readText: (file: string) => string | null;
    /** Read it as base64, for an image or a PDF. */
    readBase64: (file: string) => string | null;
}

/** `data:` needs a mime type, and a wrong one silently renders nothing. */
const MIME: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
};

/** The content type of a post's file, by kind; an image of a type the board cannot draw has none. */
export function mimeFor(kind: PostKind, file: string): string | null {
    if (kind === 'html') return 'text/html';
    if (kind === 'markdown') return 'text/markdown';
    if (kind === 'pdf') return 'application/pdf';
    const dot = file.lastIndexOf('.');
    if (dot <= 0) return null;
    return MIME[file.slice(dot).toLowerCase()] ?? null;
}

/** Whether a kind is read as text (HTML, Markdown) or as bytes (an image, a PDF). */
export const isTextKind = (kind: PostKind): boolean => kind === 'html' || kind === 'markdown';

export interface ResolvedBoard {
    posts: DisplayPost[];
    error?: string;
}

type Content = { html: string } | { text: string } | { src: string };

function contentOf(kind: PostKind, file: string, deps: ResolveDeps): Content | null {
    if (kind === 'html') {
        const html = safely(() => deps.readText(file));
        return html === null ? null : { html };
    }
    if (kind === 'markdown') {
        const text = safely(() => deps.readText(file));
        return text === null ? null : { text };
    }
    const mime = mimeFor(kind, file);
    const b64 = mime ? safely(() => deps.readBase64(file)) : null;
    return mime && b64 !== null ? { src: `data:${mime};base64,${b64}` } : null;
}

/**
 * Resolve every post that can be resolved, and REPORT the ones that could not.
 *
 * A post whose file has been deleted is dropped rather than rendered as an empty
 * card — an empty card claims the agent posted nothing, which is a different and
 * wrong statement. The count is surfaced instead, because silently showing four
 * of five posts is how a reviewer approves the wrong thing. (An EARLIER version
 * whose file is gone is different: the item is there, so that version says why it
 * cannot be shown.)
 */
export function resolveBoard(posts: BoardPost[], deps: ResolveDeps): ResolvedBoard {
    const out: DisplayPost[] = [];
    let missing = 0;

    for (const post of posts) {
        const latest = contentOf(post.kind, post.file, deps);
        if (latest === null) {
            missing++;
            continue;
        }
        const versions = versionsOf(post);
        const shown: DisplayPost = {
            id: post.id,
            title: post.title,
            kind: post.kind,
            createdAt: post.createdAt,
            askVerdict: wantsVerdict(post),
            ...(post.note ? { note: post.note } : {}),
            ...(post.review ? { review: post.review } : {}),
            ...(post.agentName ? { poster: post.agentName } : {}),
            ...(post.width ? { width: post.width } : {}),
            ...(post.height ? { height: post.height } : {}),
            ...(post.pinned ? { pinned: true as const } : {}),
            ...(post.trail && post.trail.length > 0 ? { trail: post.trail } : {}),
            ...latest,
        };
        if (versions.length > 1) {
            shown.versions = versions.map((v, i): DisplayVersion => {
                const base: DisplayVersion = { n: v.n, kind: v.kind, createdAt: v.createdAt, ...(v.note ? { note: v.note } : {}), ...(v.agentName ? { poster: v.agentName } : {}) };
                const content = i === versions.length - 1 ? latest : contentOf(v.kind, v.file, deps);
                return content ? { ...base, ...content } : { ...base, contentError: 'This version\'s file is missing from the board.' };
            });
        }
        out.push(shown);
    }

    return missing > 0
        ? {
              posts: out,
              error: `${missing} post${missing === 1 ? '' : 's'} could not be shown — the file each one names is missing from the board.`,
          }
        : { posts: out };
}

/** A read that throws is a missing post, not a broken board. */
function safely(read: () => string | null): string | null {
    try {
        return read();
    } catch {
        return null;
    }
}
