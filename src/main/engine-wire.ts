import type { WireAttachment } from '../core/engine-protocol.js';
import { UPLOADS_DIR } from '../core/chat-uploads.js';
import type { Attachment, SavedUpload } from '../core/prompt-content.js';

/**
 * A MESSAGE'S FILE ON THE ENGINE LINK (`engine.promptWith`): its bytes as base64, and — for one the host saved into the
 * workspace (Tynn #829) — `saved`, its path. The session engine is another process; dropped on the way, a saved file
 * would arrive as an empty file and the message would be refused.
 */
export function toWireAttachment(a: Attachment): WireAttachment {
    return { name: a.name, type: a.type, b64: Buffer.from(a.bytes.buffer, a.bytes.byteOffset, a.bytes.byteLength).toString('base64'), ...(a.saved ? { saved: { path: a.saved.path, type: a.saved.type, size: a.saved.size } } : {}) };
}

/** Only a path the host's save makes: under the uploads folder, no `..`, no backslash. */
function savedOf(raw: unknown): SavedUpload | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const { path, type, size } = raw as { path?: unknown; type?: unknown; size?: unknown };
    if (typeof path !== 'string' || typeof type !== 'string' || typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null;
    if (!path.startsWith(`${UPLOADS_DIR}/`) || path.includes('\\') || path.split('/').some((p) => p === '..' || p === '.' || p === '')) return null;
    return { path, type, size };
}

/** The attachment back, or `null` when anything is malformed — never sent with a made-up path. */
export function fromWireAttachment(w: unknown): Attachment | null {
    if (typeof w !== 'object' || w === null) return null;
    const { name, type, b64, saved } = w as { name?: unknown; type?: unknown; b64?: unknown; saved?: unknown };
    if (typeof name !== 'string' || typeof b64 !== 'string') return null;
    const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    const base = { name, type: typeof type === 'string' ? type : '', bytes };
    if (saved === undefined) return base;
    const s = savedOf(saved);
    return s ? { ...base, saved: s } : null;
}
