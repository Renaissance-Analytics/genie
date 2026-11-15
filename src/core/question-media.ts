/**
 * WHAT THE QUESTION'S FILE DRAWER DRAWS (Tynn #726): a file a question names that is not text. An image is drawn from a
 * `data:` URL (an SVG too — through <img>, so a script in it never runs), a PDF and any other binary are named with their
 * size and opened in Genie's Files panel.
 */
export type QuestionMedia =
    | { readonly kind: 'image'; readonly src: string; readonly size: number }
    | { readonly kind: 'pdf' | 'binary'; readonly size: number };

const IMAGE = /\.(png|apng|jpe?g|jfif|gif|webp|avif|bmp|ico|svg)$/i;

/** What a path's extension says it is; text is decided by the bytes, not here. */
export function questionMediaKind(path: string): 'image' | 'pdf' | null {
    if (IMAGE.test(path)) return 'image';
    return /\.pdf$/i.test(path) ? 'pdf' : null;
}

/** `512 B` / `1.5 KB` / `3.0 MB`. */
export function sizeLabel(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}
