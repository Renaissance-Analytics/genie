import type { WireAttachment } from '../core/engine-protocol.js';
import type { Attachment } from '../core/prompt-content.js';

/** STUB (Tynn #829 RED): today's wire, which drops `saved`. */
export function toWireAttachment(a: Attachment): WireAttachment {
    return { name: a.name, type: a.type, b64: Buffer.from(a.bytes).toString('base64') };
}

/** STUB (Tynn #829 RED). */
export function fromWireAttachment(w: unknown): Attachment | null {
    const a = w as WireAttachment;
    return { name: a.name, type: a.type, bytes: new Uint8Array(Buffer.from(a.b64, 'base64')) };
}
