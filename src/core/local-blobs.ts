/** Connection resources for local content reads; families adopt them separately. */
export const BLOB_METHODS = ['blob.open', 'blob.read', 'blob.close'] as const;
export const BLOB_KINDS = ['draft-file', 'artboard-post', 'workspace-file'] as const;
export type BlobKind = typeof BLOB_KINDS[number];
export const BLOB_READ_BYTES = 512 * 1024;
export const MAX_OPEN_BLOBS = 8;

export interface BlobInfo { readonly id: string; readonly size: number; readonly sha256: string }
export interface BlobChunk { readonly base64: string }
/** Host-resolved snapshot. A ref is a host-minted handle, never a renderer path. */
export interface BlobSource {
    readonly size: number;
    readonly sha256: string;
    read(offset: number, length: number): Promise<Uint8Array>;
    close(): Promise<void>;
}
export type BlobOpener = (kind: BlobKind, ref: string) => Promise<BlobSource>;
export interface BlobCalls {
    open(kind: BlobKind, ref: string): Promise<BlobInfo>;
    read(id: string, offset: number, length: number): Promise<BlobChunk>;
    close(id: string): Promise<{ closed: boolean }>;
}
export interface BlobClient extends BlobCalls {
    readAll(kind: BlobKind, ref: string): Promise<Uint8Array>;
}
