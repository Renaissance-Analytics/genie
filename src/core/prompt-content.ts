import { attachmentRefusal, isExecutableName } from './inbox.js';

/**
 * A PROMPT WITH ATTACHMENTS (the composer's `attach`): ACP prompt content blocks, as prism-acp's `prompt()` takes
 * them — the text first, an image as an image block, a text file as a text resource. Anything the agent's provider
 * cannot take refuses the WHOLE message with a reason naming the file: the owner's beta.20 composer showed `attach`
 * and threw the file away, and a message sent without the file it was about is a different message.
 *
 * An image is recognised by its BYTES (the format's signature), never by the name or the type the picker reported —
 * a `.png` that is not a PNG would reach the provider as one and fail there, with nothing on screen saying why.
 */
export type PromptBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; mimeType: string; data: string }
    | { type: 'resource'; resource: { uri: string; mimeType?: string; text: string } };

export interface Attachment {
    readonly name: string;
    /** What the picker reported; a hint only. */
    readonly type: string;
    readonly bytes: Uint8Array;
}

/** What the agent's provider takes beyond text (from its driver's declared capabilities). */
export interface PromptAccepts {
    readonly image: boolean;
    readonly textResource: boolean;
}

export type PromptContent =
    | { ok: true; content: string | PromptBlock[]; names: readonly string[] }
    | { ok: false; reason: string };

const MB = 1024 * 1024;
/** The Claude API's limit for one image; larger ones are refused there, so they are refused here, said first. */
const IMAGE_MAX_BYTES = 5 * MB;

const startsWith = (bytes: Uint8Array, sig: readonly number[], at = 0): boolean => sig.every((b, i) => bytes[at + i] === b);

/** The image format these bytes ARE, by signature — PNG, JPEG, GIF, WebP — or `null`. */
export function imageTypeOf(bytes: Uint8Array): string | null {
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
    if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
    return null;
}

/** The text of a file that IS text: valid UTF-8 with no NUL byte. `null` for anything else. */
function textOf(bytes: Uint8Array): string | null {
    if (bytes.includes(0)) return null;
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
}

export function promptContent(text: string, attachments: readonly Attachment[], accepts: PromptAccepts, toBase64: (bytes: Uint8Array) => string): PromptContent {
    if (attachments.length === 0) return { ok: true, content: text, names: [] };
    const refusal = attachmentRefusal(attachments.map((a) => ({ name: a.name, size: a.bytes.byteLength })));
    if (refusal) return { ok: false, reason: refusal };
    const blocks: PromptBlock[] = text.trim() === '' ? [] : [{ type: 'text', text }];
    for (const a of attachments) {
        if (isExecutableName(a.name)) return { ok: false, reason: `${a.name} is a natively executable file and is refused` };
        const image = imageTypeOf(a.bytes);
        if (image) {
            if (a.bytes.byteLength > IMAGE_MAX_BYTES) return { ok: false, reason: `${a.name} is ${(a.bytes.byteLength / MB).toFixed(1)} MB; an image can be at most 5 MB` };
            if (!accepts.image) return { ok: false, reason: `${a.name}: this agent's provider cannot take an image` };
            blocks.push({ type: 'image', mimeType: image, data: toBase64(a.bytes) });
            continue;
        }
        const body = textOf(a.bytes);
        if (body === null) return { ok: false, reason: `${a.name} is neither an image nor a text file, so it cannot be sent to an agent` };
        if (!accepts.textResource) return { ok: false, reason: `${a.name}: this agent's provider cannot take a text file` };
        blocks.push({ type: 'resource', resource: { uri: `attachment://${encodeURIComponent(a.name)}`, mimeType: 'text/plain', text: body } });
    }
    return { ok: true, content: blocks, names: attachments.map((a) => a.name) };
}

/**
 * The composer's files as they cross IPC — `{ name, type, bytes }`, bytes a `Uint8Array` (or an `ArrayBuffer`) — or
 * `null` when anything is malformed. Absent is no files. One bad entry refuses them all: a message is never sent with
 * some of its files quietly missing.
 */
export function attachmentsFromRenderer(raw: unknown): Attachment[] | null {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > 64) return null;
    const out: Attachment[] = [];
    for (const f of raw as unknown[]) {
        if (typeof f !== 'object' || f === null) return null;
        const { name, type, bytes } = f as { name?: unknown; type?: unknown; bytes?: unknown };
        if (typeof name !== 'string' || name === '' || typeof type !== 'string') return null;
        const data = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null;
        if (!data) return null;
        out.push({ name, type, bytes: data });
    }
    return out;
}
