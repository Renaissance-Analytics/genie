import { isDraftRef, readChatDraft } from '../core/chat-drafts.js';
import type { ChatDraftsPort } from '../core/chat-draft-keeper.js';
import type { BlobClient } from '../core/local-blobs.js';
import { LOCAL_UPLOAD_MAX_BYTES, type LocalUploadClient, type PageClient } from '../core/local-content.js';
import { DRAFT_CALL_BYTES, DRAFT_INLINE_BYTES, validateDraftRanges, type DraftContentEnvelope, type DraftMetadata, type LocalDraftMethod } from '../core/local-drafts.js';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
async function sha(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function localDraftsClient(port: { read<T>(method: LocalDraftMethod, ...args: unknown[]): Promise<T>; release(ref: string): Promise<unknown>; blobs: BlobClient; uploads: LocalUploadClient; pages: PageClient }): ChatDraftsPort {
    const decode = async (value: unknown, list: boolean): Promise<unknown> => {
        if (!value || typeof value !== 'object' || !('draftsContent' in value)) return value;
        const body = (value as DraftContentEnvelope).draftsContent;
        if (!body || typeof body.ref !== 'string') throw new Error('invalid draft response reference');
        try {
            if (typeof body.blob !== 'string') throw new Error('invalid draft blob reference');
            if (!list) return await port.blobs.readAll('draft-file', body.blob);
            if (typeof body.list !== 'string' || !Number.isSafeInteger(body.count) || body.count! < 0) throw new Error('invalid draft list reference');
            const items = await port.pages.readAll('chat-drafts', body.list) as DraftMetadata[];
            if (items.length !== body.count) throw new Error('the draft list omitted entries');
            // One aggregate read for N entries; every slice still has its own checked range and hash.
            const bytes = await port.blobs.readAll('draft-file', body.blob);
            validateDraftRanges(items, bytes.byteLength);
            const entries: Array<[string, unknown]> = []; let offset = 0;
            for (const [index, item] of items.entries()) {
                if (item.id !== String(index) || typeof item.name !== 'string' || item.type !== 'application/json' || item.ref !== body.blob || item.offset !== offset || item.size !== item.length || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(item.sha256)) throw new Error('invalid draft entry metadata or range');
                const slice = bytes.subarray(item.offset, item.offset + item.length);
                if (await sha(slice as Uint8Array<ArrayBuffer>) !== item.sha256.toLowerCase()) throw new Error(`draft ${item.id} entry hash does not match its content`);
                const draft: unknown = JSON.parse(new TextDecoder().decode(slice));
                if (!readChatDraft(draft)) throw new Error(`draft ${item.id} is not a supported kept draft`);
                entries.push([item.name, draft]); offset += item.length;
            }
            if (offset !== bytes.byteLength || new Set(entries.map(([name]) => name)).size !== entries.length) throw new Error('the draft snapshot has missing or duplicate entries');
            return Object.fromEntries(entries);
        } finally { try { await port.release(body.ref); } catch { console.warn('[genie] a draft response could not be released'); } }
    };
    const staged = async <T>(method: 'chatDrafts.save' | 'chatDrafts.putFile', args: unknown[], subtype: 'text' | 'attachment', bytes: Uint8Array): Promise<T> => {
        const upload = await port.uploads.stage({ purpose: 'draft-file', subtype }, bytes);
        try { return await port.read<T>(method, ...args, { staged: upload.id }); }
        finally { try { await port.uploads.abort(upload.id); } catch { console.warn('[genie] a draft stage could not be released'); } }
    };
    return {
        load: async () => decode(await port.read('chatDrafts.load'), true),
        save: async (agentId, raw) => {
            if (typeof agentId !== 'string') return;
            const draft = raw === null ? null : readChatDraft(raw); if (raw !== null && !draft) return;
            const bytes = encode(draft);
            if (bytes.byteLength > DRAFT_INLINE_BYTES) {
                if (encode([agentId, { staged: '' }]).byteLength > DRAFT_CALL_BYTES) throw new Error('this draft identifier is too large for a bounded call');
                await staged('chatDrafts.save', [agentId], 'text', bytes); return;
            }
            if (encode([agentId, draft]).byteLength > DRAFT_CALL_BYTES) throw new Error('these draft arguments are too large for a bounded call');
            await port.read('chatDrafts.save', agentId, draft);
        },
        putFile: bytes => !(bytes instanceof Uint8Array) || bytes.byteLength > LOCAL_UPLOAD_MAX_BYTES ? Promise.resolve(null) : staged('chatDrafts.putFile', [], 'attachment', bytes),
        readFile: async ref => !isDraftRef(ref) ? null : await decode(await port.read('chatDrafts.readFile', ref), false) as Uint8Array | null,
        release: async refs => {
            const ours = Array.isArray(refs) ? refs.filter(isDraftRef) : [];
            for (let at = 0; at < ours.length; at += 128) await port.read('chatDrafts.release', ours.slice(at, at + 128));
        },
    };
}
