import type { DisplayPost, PostKind } from './artboard.js';

/**
 * FORCETHEQUESTION CARRIES VISUALS (the owner, beta.65; Tynn #835). An agent attaches what it MADE to the question the person
 * decides on — ArtBoard posts, images and HTML mockups — on the question ("look at these") or on an option ("pick a mockup").
 *
 * EVERY VISUAL IS AN ARTBOARD POST of the asking agent's workspace. An id names a post already on its board; a file named
 * by path (an image, an HTML page) is POSTED to the board when the question is asked (main/question-visuals.ts). So one
 * renderer draws them (the ArtBoard tab's `ArtifactPreview`), one reader serves them to a remote driver (the board, as the
 * ArtBoard tab reads it), and the decision lands where the person's other decisions about that work live: on each post's
 * trail. A question stores only the reference — the post, and the version it showed — never the bytes.
 *
 * This half is pure: what an agent may write, how a page is made safe, and how a reference finds its post.
 */

/**
 * The caps. Six on a question is a gallery the window can lay out in two rows; twelve on one ask is three questions'
 * worth. An image is copied whole into the board and crosses IPC as a data: URL — 4 MB is a large screenshot. A mockup is
 * a page, not an app — 512 KB of markup is generous.
 */
export const QUESTION_VISUAL_LIMITS = { perQuestion: 6, perAsk: 12, imageBytes: 4 * 1024 * 1024, htmlBytes: 512 * 1024, title: 80 } as const;

/** What the board can draw as an image (core/artboard.ts MIME), and what a mockup file is. */
export const VISUAL_IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
export const VISUAL_HTML_EXT = /\.html?$/i;

/** One visual as the agent names it: an ArtBoard post id, or a workspace file to post. */
export type QuestionVisualInput = { kind: 'artboard' | 'image' | 'html'; ref: string; title?: string };

/** A visual as a question stores it: an ArtBoard post of the asking agent's workspace, at the version it showed. */
export interface QuestionVisual {
    readonly postId: string;
    readonly version: number;
    readonly title: string;
    readonly kind: PostKind;
}

const KINDS = ['artboard', 'image', 'html'] as const;

/** Parse one visual from the tool's arguments: exactly one of artboard / image / html, a non-empty string. */
export function parseVisualInput(raw: unknown): { ok: true; input: QuestionVisualInput } | { ok: false; reason: string } {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'a visual is an object: { artboard: "<post id>" }, { image: "<path>" } or { html: "<path>" }' };
    const r = raw as Record<string, unknown>;
    const named = KINDS.filter((k) => r[k] !== undefined);
    if (named.length !== 1) return { ok: false, reason: 'a visual names exactly one of artboard, image or html' };
    const kind = named[0]!;
    const ref = r[kind];
    if (typeof ref !== 'string' || !ref.trim()) return { ok: false, reason: `${kind} must be a non-empty string` };
    if (kind === 'image' && !VISUAL_IMAGE_EXT.test(ref)) return { ok: false, reason: `${ref}: an image is .png, .jpg, .gif, .webp or .svg (that extension is not one)` };
    if (kind === 'html' && !VISUAL_HTML_EXT.test(ref)) return { ok: false, reason: `${ref}: a mockup is an .html file (that extension is not one)` };
    if (r.title !== undefined && typeof r.title !== 'string') return { ok: false, reason: 'title must be a string' };
    const title = typeof r.title === 'string' ? r.title.trim().slice(0, QUESTION_VISUAL_LIMITS.title) : '';
    return { ok: true, input: { kind, ref: ref.trim(), ...(title ? { title } : {}) } };
}

/** A stored visual is well-formed: what validateQuestions checks on everything a question carries. */
export function isQuestionVisual(v: unknown): v is QuestionVisual {
    if (typeof v !== 'object' || v === null) return false;
    const r = v as Record<string, unknown>;
    return typeof r.postId === 'string' && r.postId.length > 0 && typeof r.version === 'number' && Number.isInteger(r.version) && r.version >= 1
        && typeof r.title === 'string' && (r.kind === 'html' || r.kind === 'image' || r.kind === 'markdown' || r.kind === 'pdf');
}

/** Every visual a question shows: its own, then its options', in order (an option's is counted once). */
export function visualsOfQuestion(q: { readonly visuals?: readonly QuestionVisual[] | undefined; readonly options: readonly { readonly visual?: QuestionVisual | undefined }[] }): QuestionVisual[] {
    return [...(q.visuals ?? []), ...q.options.flatMap((o) => (o.visual ? [o.visual] : []))];
}

/**
 * The page's own policy: nothing it draws reaches the network — no fonts, no images, no styles from anywhere but itself.
 * The frame is already sandboxed with no script and no same origin (ArtBoardPanel's ArtifactPreview); this keeps a mockup
 * from telling anyone it was opened.
 */
export const MOCKUP_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`;

/**
 * SANITISE A MOCKUP before it is posted and drawn. The frame it is drawn in runs no script, so this is the second wall,
 * not the first: script, nested frames and plugins are removed, every `on…` handler and every `javascript:` URL goes, a
 * refresh and an external stylesheet go, and the page gets {@link MOCKUP_CSP}. What it LOOKS like stays: markup, classes,
 * inline styles and `<style>` blocks.
 */
export function sanitizeMockupHtml(html: string): string {
    let s = html;
    // Elements removed with their content.
    s = s.replace(/<(script|iframe|object|embed|frameset|frame|applet|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '');
    // ...and any left unclosed or self-closing.
    s = s.replace(/<\/?(script|iframe|object|embed|frameset|frame|applet|noscript|template|base|link)\b[^>]*>/gi, '');
    // A refresh (or any http-equiv of the page's own) goes; ours is added below.
    s = s.replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '');
    // Every inline handler: on…="…", on…='…', on…=bare.
    s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    // javascript:, vbscript: and data:text/html in any attribute.
    s = s.replace(/\s+([a-z:-]+)\s*=\s*("|')\s*(?:javascript|vbscript|data:text\/html)[^"']*\2/gi, '');
    s = s.replace(/\s+([a-z:-]+)\s*=\s*(?:javascript|vbscript):[^\s>]*/gi, '');
    // A remote source: it would load (and report) the moment the page is drawn — the CSP blocks it too; it is said, not kept.
    s = s.replace(/\s+(src|srcset|href|action|formaction|poster|background)\s*=\s*("|')\s*(?:https?:)?\/\/[^"']*\2/gi, '');
    return /<head\b[^>]*>/i.test(s) ? s.replace(/<head\b[^>]*>/i, (m) => `${m}${MOCKUP_CSP}`) : `${MOCKUP_CSP}${s}`;
}

/**
 * Each reference, as the board shows it: the post laid over the version the question named (a later revision does not
 * change what was asked about). A post no longer on the board is still listed, saying so — a gallery that silently shows
 * three of four mockups is how a person picks the wrong one.
 */
export function selectVisualPosts(posts: readonly DisplayPost[], refs: readonly QuestionVisual[]): DisplayPost[] {
    const byId = new Map(posts.map((p) => [p.id, p]));
    return refs.map((ref): DisplayPost => {
        const post = byId.get(ref.postId);
        if (!post) return { id: ref.postId, title: ref.title, kind: ref.kind, createdAt: '', askVerdict: false, contentError: `“${ref.title}” is no longer on the ArtBoard.` };
        const version = post.versions?.find((v) => v.n === ref.version);
        if (!version) {
            const { versions: _v, ...rest } = post;
            return rest;
        }
        const { versions: _v, html: _h, src: _s, text: _t, contentError: _e, ...rest } = post;
        return {
            ...rest,
            kind: version.kind,
            ...(version.html !== undefined ? { html: version.html } : {}),
            ...(version.src !== undefined ? { src: version.src } : {}),
            ...(version.text !== undefined ? { text: version.text } : {}),
            ...(version.contentError !== undefined ? { contentError: version.contentError } : {}),
        };
    });
}

/** The line an answer's mail carries for a chosen option that IS a visual: which post, which version. */
export function chosenVisualLine(v: QuestionVisual): string {
    return `Visual chosen: "${v.title}" (ArtBoard post ${v.postId}, version ${v.version})`;
}

/** Every visual a question asks with, across all its questions, each post-and-version once, in order. */
export function visualRefsOf(questions: readonly { readonly visuals?: readonly QuestionVisual[] | undefined; readonly options: readonly { readonly visual?: QuestionVisual | undefined }[] }[]): QuestionVisual[] {
    const seen = new Set<string>();
    return questions.flatMap(visualsOfQuestion).filter((v) => {
        const k = `${v.postId}@${v.version}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}
