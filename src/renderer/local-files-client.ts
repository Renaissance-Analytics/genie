import type { BlobClient } from '../core/local-blobs.js';
import type { LocalUploadClient, PageClient } from '../core/local-content.js';
import { bytesToBase64 } from '../core/mobile.js';
import { FILES_INLINE_BYTES, type FilesContentEnvelope, type FilesProjection, type LocalFilesMethod } from '../core/local-files.js';
import type { GenieBridge } from './bridge.js';

export type FilesProtocolKey = 'tree' | 'children' | 'open' | 'readMedia' | 'lastCommitted' | 'state' | 'gitStatus' | 'create' | 'rename' | 'duplicate' | 'trash' | 'readBytes' | 'write' | 'writeBytes';
export type LocalFilesBridge = Pick<GenieBridge['files'], FilesProtocolKey>;

/** Buffer.from(base64)'s legacy acceptance, including unpadded/URL-safe input, for staged editor bytes. */
function decodeBase64(value: string): Uint8Array {
    let clean = value.split('=')[0]!.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
    if (clean.length % 4 === 1) clean = clean.slice(0, -1);
    const decoded = atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, '='));
    return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

export function localFilesClient(port: { read<T>(method: LocalFilesMethod, ...args: unknown[]): Promise<T>; release(ref: string): Promise<unknown>; blobs: BlobClient; uploads: LocalUploadClient; pages: PageClient }): { files: LocalFilesBridge; repo: NonNullable<GenieBridge['repo']> } {
    const decode = async (value: FilesProjection): Promise<unknown> => {
        if (!value || typeof value !== 'object') throw new Error('invalid Files metadata projection');
        switch (value.t) {
            case 'value': return value.value;
            case 'undefined': return undefined;
            case 'blob': { const bytes = await port.blobs.readAll('workspace-file', value.ref); return value.encoding === 'base64' ? bytesToBase64(bytes) : new TextDecoder().decode(bytes); }
            case 'record': { const entries: Array<[string, unknown]> = []; for (const [key, item] of value.entries) entries.push([key, await decode(item)]); return Object.fromEntries(entries); }
            case 'array':
            case 'object': {
                const items = await port.pages.readAll(value.kind, value.ref);
                if (!Number.isSafeInteger(value.count) || items.length !== value.count) throw new Error('the Files metadata page omitted entries');
                const entries: Array<[string, unknown]> = [], array: unknown[] = [];
                for (let i = 0; i < items.length; i++) {
                    const item = items[i]!; if (item.id !== String(i)) throw new Error('the Files metadata page changed its order');
                    const decoded = await decode(item.value as FilesProjection);
                    if (value.t === 'array') array.push(decoded);
                    else { const key = await decode(item.key as FilesProjection); if (typeof key !== 'string') throw new Error('invalid Files metadata key'); entries.push([key, decoded]); }
                }
                return value.t === 'array' ? array : Object.fromEntries(entries);
            }
            default: throw new Error('unknown Files metadata projection');
        }
    };
    const request = async <T>(method: LocalFilesMethod, args: unknown[]): Promise<T> => {
        let staged: string | null = null;
        const sent = [...args];
        try {
            if (method === 'repo.call' && new TextEncoder().encode(JSON.stringify(args)).length > FILES_INLINE_BYTES) {
                const upload = await port.uploads.stage({ purpose: 'file-write', subtype: 'repo-args' }, new TextEncoder().encode(JSON.stringify(args))); staged = upload.id; sent.splice(0, sent.length, { staged });
            } else if (method === 'files.write' || method === 'files.writeBytes') {
                const index = method === 'files.write' ? 2 : 3, content = sent[index];
                if (typeof content === 'string' && new TextEncoder().encode(JSON.stringify(sent)).length > FILES_INLINE_BYTES) {
                    const bytes = method === 'files.writeBytes' ? decodeBase64(content) : new TextEncoder().encode(content);
                    const upload = await port.uploads.stage({ purpose: 'file-write', subtype: method === 'files.writeBytes' ? 'bytes' : 'text' }, bytes); staged = upload.id; sent[index] = { staged };
                }
            }
            if (new TextEncoder().encode(JSON.stringify(sent)).length > FILES_INLINE_BYTES) throw new Error('these Files arguments are too large for one bounded call');
            const result = await port.read<unknown>(method, ...sent);
            if (!result || typeof result !== 'object' || !('filesContent' in result)) return result as T;
            const body = (result as FilesContentEnvelope).filesContent;
            if (!body || typeof body.ref !== 'string') throw new Error('invalid Files response reference');
            try { return await decode(body.value) as T; }
            finally { try { await port.release(body.ref); } catch { console.warn('[genie] a Files response could not be released'); } }
        } finally { if (staged !== null) { try { await port.uploads.abort(staged); } catch { console.warn('[genie] a Files stage could not be released'); } } }
    };
    return {
        files: {
            tree: id => request('files.tree', [id]), children: (id, dir) => request('files.localChildren', [id, dir]),
            open: (id, path) => request('files.localOpen', [id, path]), readMedia: (id, path) => request('files.localReadMedia', [id, path]),
            lastCommitted: (id, path) => request('files.lastCommitted', [id, path]), state: id => request('files.state', [id]), gitStatus: id => request('files.gitStatus', [id]),
            create: (id, path, kind) => request('files.create', [id, path, kind]), rename: (id, from, to) => request('files.rename', [id, from, to]),
            duplicate: (id, path) => request('files.duplicate', [id, path]), trash: (id, path) => request('files.trash', [id, path]),
            readBytes: (id, plugin, path) => request('files.readBytes', [id, plugin, path]), write: (id, path, text, expected) => request('files.write', [id, path, text, expected]),
            writeBytes: (id, plugin, path, base64, expected) => request('files.writeBytes', [id, plugin, path, base64, expected]),
        },
        repo: { call: (op, id, rel, a, b) => request('repo.call', [op, id, rel, a, b]) },
    };
}
