import type { MetadataItem } from './local-content.js';

export const LOCAL_ARTBOARD_METHODS = ['artboard.read', 'artboard.review'] as const;
export type LocalArtboardMethod = typeof LOCAL_ARTBOARD_METHODS[number];
export const ARTBOARD_CALL_BYTES = 512 * 1024;
export interface ArtboardBlob { ref: string; size: number | null; sha256: string | null; type: string; error?: string }
export interface ArtboardMetadata extends MetadataItem {
    postId: string; title: string; kind: 'html' | 'image'; createdAt: string; askVerdict: boolean; note?: string;
    artifact: ArtboardBlob;
    review?: { verdict: 'approved' | 'rejected'; at: string; comment?: ArtboardBlob };
}
export interface ArtboardContentEnvelope { artboardContent: { ref: string; list: string; count: number; error?: string } }
export function isLocalArtboardMethod(method: string): method is LocalArtboardMethod { return (LOCAL_ARTBOARD_METHODS as readonly string[]).includes(method); }
