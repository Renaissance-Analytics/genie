/**
 * A MEDIA TAB'S READ (the owner, 2026-10-21: an image opened in Files showed a broken image). A media file is read as
 * BYTES and shown from a `data:` URL: the text read decodes it as UTF-8, which is not the image, and the viewer can draw
 * only an http, data or blob URL — never the workspace-relative path it used to get.
 *
 * Which files are media is fancy-code's call (`resolveFileKind`), made in the panel; this types the bytes so the browser
 * draws them (an SVG served as octet-stream is not drawn).
 */

const MIME: Readonly<Record<string, string>> = {
    png: 'image/png', apng: 'image/apng', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', pjpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', cur: 'image/x-icon',
    svg: 'image/svg+xml', svgz: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif',
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', ogm: 'video/ogg', mov: 'video/quicktime',
    mkv: 'video/x-matroska', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', flv: 'video/x-flv', '3gp': 'video/3gpp',
    '3g2': 'video/3gpp2', mpg: 'video/mpeg', mpeg: 'video/mpeg',
    mp3: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4',
    m4b: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/opus', weba: 'audio/webm', mid: 'audio/midi',
    midi: 'audio/midi', aiff: 'audio/aiff',
    pdf: 'application/pdf',
};

/** The type a media file's bytes are served as, by its extension; `application/octet-stream` for one not listed. */
export function mediaMimeOf(path: string): string {
    const name = path.split('/').pop() ?? path;
    const dot = name.lastIndexOf('.');
    return (dot > 0 ? MIME[name.slice(dot + 1).toLowerCase()] : undefined) ?? 'application/octet-stream';
}

export type MediaRead = { ok: true; path: string; base64: string; sha: string } | { ok: false; path: string; error: string };
export type MediaOpen = { ok: true; path: string; text: string; sha: string; src: string } | { ok: false; path: string; error: string };

/** The bytes read as an open tab: no text, and a `src` the viewer draws. A refusal stays one, in its own words. */
export function mediaOpen(read: MediaRead, path: string): MediaOpen {
    if (!read.ok) return { ok: false, path: read.path || path, error: read.error };
    return { ok: true, path: read.path, text: '', sha: read.sha, src: `data:${mediaMimeOf(read.path)};base64,${read.base64}` };
}
