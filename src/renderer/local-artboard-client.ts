import type { DisplayPost, ResolvedBoard } from '../core/artboard.js';
import { ARTBOARD_CALL_BYTES, type ArtboardBlob, type ArtboardContentEnvelope, type ArtboardMetadata, type LocalArtboardMethod } from '../core/local-artboard.js';
import type { BlobClient } from '../core/local-blobs.js';
import { LOCAL_UPLOAD_MAX_BYTES, type LocalUploadClient, type PageClient } from '../core/local-content.js';
import type { GenieBridge } from './bridge.js';
import { encodeLocalBase64 } from './local-base64.js';
import { unlimited, type HeldLimit } from './local-content-client.js';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const text = (value: unknown) => typeof value === 'string' ? value : null;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml', 'image/webp']);
async function sha(bytes: Uint8Array<ArrayBuffer>): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join(''); }

export function localArtboardClient(port: { read<T>(method: LocalArtboardMethod, ...args: unknown[]): Promise<T>; release(ref: string): Promise<unknown>; blobs: BlobClient; uploads: LocalUploadClient; pages: PageClient; limit?: HeldLimit }): NonNullable<GenieBridge['artboard']> {
    const limit = port.limit ?? unlimited;
    const asset = async (value: ArtboardBlob, expectedType?: string): Promise<Uint8Array> => {
        if (!value || typeof value.ref !== 'string' || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0 || (value.sha256 !== null && (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sha256))) || typeof value.type !== 'string' || (expectedType !== undefined && value.type !== expectedType)) throw new Error('invalid ArtBoard content metadata');
        const bytes = await port.blobs.readAll('artboard-post', value.ref);
        // readAll always verifies the complete bytes against blob.open's streamed hash. A file's list hash is deferred.
        if (bytes.length !== value.size || (value.sha256 !== null && await sha(bytes as Uint8Array<ArrayBuffer>) !== value.sha256.toLowerCase())) throw new Error('ArtBoard content metadata size or hash differs');
        return bytes;
    };
    const decode = async (value: unknown): Promise<ResolvedBoard> => {
        if (!value || typeof value !== 'object' || !('artboardContent' in value)) {
            if (value && typeof value === 'object' && Array.isArray((value as ResolvedBoard).posts) && (value as ResolvedBoard).posts.length === 0) return value as ResolvedBoard;
            throw new Error('the ArtBoard response has no metadata reference');
        }
        const body = (value as ArtboardContentEnvelope).artboardContent;
        if (!body || typeof body.ref !== 'string') throw new Error('invalid ArtBoard response reference');
        try {
            if (typeof body.list !== 'string' || !Number.isSafeInteger(body.count) || body.count < 0 || (body.error !== undefined && typeof body.error !== 'string')) throw new Error('invalid ArtBoard list reference');
            const items = await port.pages.readAll('artboard-posts', body.list) as ArtboardMetadata[];
            if (items.length !== body.count) throw new Error('the ArtBoard list omitted posts');
            const posts: DisplayPost[] = [];
            for (const [index, item] of items.entries()) {
                if (item.id !== String(index) || typeof item.postId !== 'string' || !item.postId || typeof item.title !== 'string' || !item.title || (item.kind !== 'html' && item.kind !== 'image') || typeof item.createdAt !== 'string' || typeof item.askVerdict !== 'boolean' || (item.note !== undefined && typeof item.note !== 'string')) throw new Error('invalid ArtBoard post metadata or order');
                const post: DisplayPost = { id: item.postId, title: item.title, kind: item.kind, createdAt: item.createdAt, askVerdict: item.askVerdict, ...(item.note === undefined ? {} : { note: item.note }) };
                if (item.artifact?.error !== undefined) {
                    if (typeof item.artifact.ref !== 'string' || typeof item.artifact.type !== 'string' || typeof item.artifact.error !== 'string' || !item.artifact.error || item.artifact.sha256 !== null || (item.artifact.size !== null && (!Number.isSafeInteger(item.artifact.size) || item.artifact.size < 0))) throw new Error('invalid ArtBoard artifact failure metadata');
                    post.contentError = item.artifact.error;
                } else {
                    const bytes = await asset(item.artifact, item.kind === 'html' ? 'text/html' : undefined);
                    if (item.kind === 'image' && !imageTypes.has(item.artifact.type)) throw new Error('unsupported ArtBoard image type');
                    if (item.kind === 'html') post.html = new TextDecoder().decode(bytes);
                    else post.src = 'data:' + item.artifact.type + ';base64,' + encodeLocalBase64(bytes);
                }
                if (item.review) {
                    const review = item.review;
                    if ((review.verdict !== 'approved' && review.verdict !== 'rejected') || typeof review.at !== 'string') throw new Error('invalid ArtBoard review metadata');
                    let comment: unknown;
                    if (review.comment !== undefined) { comment = JSON.parse(new TextDecoder().decode(await asset(review.comment, 'application/json'))); if (typeof comment !== 'string') throw new Error('invalid ArtBoard review comment'); }
                    post.review = { verdict: review.verdict, at: review.at, ...(comment === undefined ? {} : { comment: comment as string }) };
                }
                posts.push(post);
            }
            return { posts, ...(body.error === undefined ? {} : { error: body.error }) };
        } finally { try { await port.release(body.ref); } catch { console.warn('[genie] an ArtBoard response could not be released'); } }
    };
    return {
        read: async workspaceId => {
            const args = [text(workspaceId)]; if (encode(args).byteLength > ARTBOARD_CALL_BYTES) throw new Error('the ArtBoard workspace identifier is too large for a bounded call');
            return limit(async () => decode(await port.read('artboard.read', ...args)));
        },
        review: async (workspaceId, postId, verdict, comment) => {
            // Native ignores nonstring comments before serialization, including BigInt and cyclic objects.
            const args = [text(workspaceId), text(postId), text(verdict), typeof comment === 'string' ? comment : undefined];
            if (encode(args).byteLength <= ARTBOARD_CALL_BYTES) return port.read('artboard.review', ...args);
            if (encode([...args.slice(0, 3), { staged: '' }]).byteLength > ARTBOARD_CALL_BYTES) throw new Error('these ArtBoard identifiers are too large for a bounded call');
            const bytes = encode(args[3]);
            if (bytes.byteLength > LOCAL_UPLOAD_MAX_BYTES) throw new Error('An ArtBoard comment can be at most 100 MiB.');
            const upload = await port.uploads.stage({ purpose: 'board-image', subtype: 'comment' }, bytes);
            try {
                const call = [...args.slice(0, 3), { staged: upload.id }];
                if (encode(call).byteLength > ARTBOARD_CALL_BYTES) throw new Error('these ArtBoard arguments are too large for a bounded call');
                return await port.read('artboard.review', ...call);
            }
            finally { try { await port.uploads.abort(upload.id); } catch { console.warn('[genie] an ArtBoard stage could not be released'); } }
        },
    };
}
