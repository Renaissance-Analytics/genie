import type { BoardPost } from './board';

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

export interface DisplayPost {
    id: string;
    title: string;
    kind: 'html' | 'image';
    createdAt: string;
    note?: string;
    review?: BoardPost['review'];
    html?: string;
    src?: string;
}

export interface ResolveDeps {
    /** Read a post's file as text. Throws / returns null when it is gone. */
    readText: (file: string) => string | null;
    /** Read it as base64, for an image. */
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

function mimeFor(file: string): string | null {
    const dot = file.lastIndexOf('.');
    if (dot <= 0) return null;
    return MIME[file.slice(dot).toLowerCase()] ?? null;
}

export interface ResolvedBoard {
    posts: DisplayPost[];
    error?: string;
}

/**
 * Resolve every post that can be resolved, and REPORT the ones that could not.
 *
 * A post whose file has been deleted is dropped rather than rendered as an empty
 * card — an empty card claims the agent posted nothing, which is a different and
 * wrong statement. The count is surfaced instead, because silently showing four
 * of five posts is how a reviewer approves the wrong thing.
 */
export function resolveBoard(posts: BoardPost[], deps: ResolveDeps): ResolvedBoard {
    const out: DisplayPost[] = [];
    let missing = 0;

    for (const post of posts) {
        const base: DisplayPost = {
            id: post.id,
            title: post.title,
            kind: post.kind,
            createdAt: post.createdAt,
            ...(post.note ? { note: post.note } : {}),
            ...(post.review ? { review: post.review } : {}),
        };

        if (post.kind === 'html') {
            const html = safely(() => deps.readText(post.file));
            if (html === null) {
                missing++;
                continue;
            }
            out.push({ ...base, html });
            continue;
        }

        const mime = mimeFor(post.file);
        const b64 = mime ? safely(() => deps.readBase64(post.file)) : null;
        if (!mime || b64 === null) {
            missing++;
            continue;
        }
        out.push({ ...base, src: `data:${mime};base64,${b64}` });
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
