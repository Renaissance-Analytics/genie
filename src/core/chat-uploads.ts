import type { SavedUpload } from './prompt-content.js';

/**
 * A FILE IN A CHAT MESSAGE THAT IS NOT AN IMAGE OR TEXT (Tynn #829; the owner, beta.64: a .docx letterhead was refused
 * at Send, "neither an image nor a text file"). The host saves it into the agent's workspace at
 * `.ai/_dirty/uploads/<local date>/<safe name>` — the scratch folder that is never committed (#818/#820) — and the
 * message tells the agent where, so it opens the file with its own tools. Every provider takes that, so no provider's
 * native document block is used: one road for a docx, an xlsx, a pdf and a zip alike. The writing is
 * main/chat-uploads.ts; these are its pure rules.
 */

export const UPLOADS_DIR = '.ai/_dirty/uploads';

const MAX_NAME = 150;

/** Windows will not make a file with these base names, whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * The name a saved file gets: the base name of what the device gave (no folder, so no `..` and nothing that leaves the
 * day's folder), without control characters or the ones Windows refuses, no leading dots (never `..`, never hidden),
 * no trailing dots or spaces (Windows drops them), never a reserved device name, at most 150 characters with its
 * extension kept, and never empty.
 */
export function safeUploadName(given: string): string {
    const base = given.split(/[\\/]/).pop() ?? '';
    // eslint-disable-next-line no-control-regex
    let name = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '');
    name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
    if (name === '') return 'file';
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    if (RESERVED.test(stem.trim())) name = `_${name}`;
    if (name.length > MAX_NAME) {
        const ext = dot > 0 && name.length - name.lastIndexOf('.') <= 16 ? name.slice(name.lastIndexOf('.')) : '';
        name = `${name.slice(0, MAX_NAME - ext.length).replace(/[.\s]+$/, '')}${ext}`;
    }
    return name;
}

/** `name (n).ext`: the n-th copy's name, when `name` is taken. */
export function numberedName(name: string, n: number): string {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** The day's folder, by the host's LOCAL date: what the person calls today. */
export function uploadsDirFor(now: Date): string {
    return `${UPLOADS_DIR}/${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const TYPES: Readonly<Record<string, string>> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    odp: 'application/vnd.oasis.opendocument.presentation',
    rtf: 'application/rtf',
    zip: 'application/zip',
    gz: 'application/gzip',
    tar: 'application/x-tar',
    '7z': 'application/x-7z-compressed',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    svg: 'image/svg+xml',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
};

/** The type to tell the agent: what the picker said, else what the extension names, else `application/octet-stream`. */
export function uploadTypeOf(name: string, pickerType: string): string {
    if (pickerType !== '' && pickerType !== 'application/octet-stream') return pickerType;
    const dot = name.lastIndexOf('.');
    return (dot > 0 ? TYPES[name.slice(dot + 1).toLowerCase()] : undefined) ?? 'application/octet-stream';
}

const KB = 1024;
const MB = 1024 * KB;

function sizeWords(bytes: number): string {
    if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
    if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
    return `${bytes} bytes`;
}

/** What the agent reads for a saved file, after your text. */
export function savedFileNote(name: string, saved: SavedUpload): string {
    return `Attached file ${name}: saved in this workspace at ${saved.path} (${saved.type}, ${sizeWords(saved.size)}). Open it from there with your own tools.`;
}
