import type { BlobSource } from './local-blobs.js';

/** Connection controls only; family bridges adopt these in later PRs. */
export const LOCAL_CONTENT_METHODS = ['localUpload.begin', 'localUpload.chunk', 'localUpload.abort', 'page.open', 'page.next', 'page.close', 'content.release'] as const;
export const LOCAL_UPLOAD_CHUNK_BYTES = 256 * 1024;
export const LOCAL_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const MAX_LOCAL_UPLOADS = 3;
export const LOCAL_UPLOAD_TTL_MS = 10 * 60_000;
export type LocalUploadTarget =
    | { purpose: 'draft-file'; subtype: 'attachment' | 'text' }
    | { purpose: 'file-write'; subtype: 'text' | 'bytes' | 'repo-args' }
    | { purpose: 'board-image'; subtype: 'comment' };
export type LocalUploadInput = LocalUploadTarget & { size: number };
export interface LocalUploadInfo { id: string; size: number }
/** Only a trusted host consumer can take a stage, with the expected purpose AND subtype. */
export interface LocalUploadSource extends BlobSource {}
export interface LocalUploadCalls {
    begin(input: LocalUploadInput): Promise<LocalUploadInfo>;
    chunk(id: string, index: number, base64: string): Promise<{ received: number }>;
    abort(id: string): Promise<{ aborted: boolean }>;
}
export interface LocalUploadClient extends LocalUploadCalls {
    stage(target: LocalUploadTarget, bytes: Uint8Array, options?: { signal?: AbortSignal }): Promise<LocalUploadInfo>;
}

export const PAGE_KINDS = ['folder-children', 'workspace-tree', 'chat-drafts', 'artboard-posts', 'artboard-comments'] as const;
export type PageKind = typeof PAGE_KINDS[number];
export const PAGE_MAX_ITEMS = 128;
export const PAGE_MAX_BYTES = 512 * 1024;
export const MAX_OPEN_PAGES = 8;
export interface MetadataItem { readonly id: string; readonly [key: string]: unknown }
export interface MetadataPage { readonly items: readonly MetadataItem[]; readonly cursor: string | null }
/** A host-owned snapshot iterator, already projected to metadata and lazy content refs by its family. */
export interface PageSource { next(): Promise<MetadataItem | null>; close(): Promise<void> }
export type PageOpener = (kind: PageKind, ref: string) => Promise<PageSource>;
export interface PageCalls {
    open(kind: PageKind, ref: string): Promise<MetadataPage>;
    next(cursor: string): Promise<MetadataPage>;
    close(cursor: string): Promise<{ closed: boolean }>;
}
export interface PageClient extends PageCalls {
    readAll(kind: PageKind, ref: string, options?: { signal?: AbortSignal }): Promise<MetadataItem[]>;
}
