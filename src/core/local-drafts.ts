import type { MetadataItem } from './local-content.js';

export const LOCAL_DRAFT_METHODS = ['chatDrafts.load', 'chatDrafts.save', 'chatDrafts.putFile', 'chatDrafts.readFile', 'chatDrafts.release'] as const;
export type LocalDraftMethod = typeof LOCAL_DRAFT_METHODS[number];
export const DRAFT_INLINE_BYTES = 256 * 1024;
export const DRAFT_CALL_BYTES = 512 * 1024;
export interface DraftMetadata extends MetadataItem {
    name: string; size: number; type: 'application/json'; sha256: string; ref: string; offset: number; length: number;
}
export interface DraftContentEnvelope { draftsContent: { ref: string; blob: string; list?: string; count?: number } }
export function isLocalDraftMethod(method: string): method is LocalDraftMethod { return (LOCAL_DRAFT_METHODS as readonly string[]).includes(method); }

/** The producer checks every range before publishing the snapshot; consumers check their slice too. */
export function validateDraftRanges(entries: readonly { id: string; offset: number; length: number }[], size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid draft snapshot size');
    for (const entry of entries) {
        if (!Number.isSafeInteger(entry.offset) || !Number.isSafeInteger(entry.length) || entry.offset < 0 || entry.length < 0 || entry.offset > size || entry.length > size - entry.offset)
            throw new Error(`draft ${entry.id} range ${entry.offset}/${entry.length} is outside snapshot size ${size}`);
    }
}
