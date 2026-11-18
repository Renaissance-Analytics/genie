import type { DisplayPost, PostKind } from './artboard.js';

/** STUB (RED): inert. */
export const QUESTION_VISUAL_LIMITS = { perQuestion: 0, perAsk: 0, imageBytes: 0, htmlBytes: 0, title: 0 } as const;

export type QuestionVisualInput = { kind: 'artboard' | 'image' | 'html'; ref: string; title?: string };

/** A visual as a question stores it: an ArtBoard post of the asking agent's workspace, at the version it showed. */
export interface QuestionVisual {
    readonly postId: string;
    readonly version: number;
    readonly title: string;
    readonly kind: PostKind;
}

/** STUB (RED): inert. */
export function parseVisualInput(_raw: unknown): { ok: true; input: QuestionVisualInput } | { ok: false; reason: string } {
    return { ok: false, reason: 'not yet' };
}

/** STUB (RED): inert. */
export function sanitizeMockupHtml(html: string): string {
    return html;
}

/** STUB (RED): inert. */
export function selectVisualPosts(_posts: readonly DisplayPost[], _refs: readonly QuestionVisual[]): DisplayPost[] {
    return [];
}
