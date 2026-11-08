import type { BlobClient } from '../core/local-blobs.js';
import type { LocalUploadClient, PageClient } from '../core/local-content.js';
import { decodeLocalBase64, encodeLocalBase64 } from './local-base64.js';
import { FILES_INLINE_BYTES, type FilesContentEnvelope, type FilesProjection, type InvalidFilesArgument, type LocalFilesMethod } from '../core/local-files.js';
import type { GenieBridge } from './bridge.js';
import { applyFilesState, isFilesStateSince, projectFilesState, type FilesStateKept } from '../core/files-state-cursor.js';
import type { FilesState } from '../main/files-host.js';
import { readCoalescer, unlimited, type HeldLimit } from './local-content-client.js';

type FilesContentKey = 'tree' | 'children' | 'open' | 'readMedia' | 'lastCommitted' | 'state' | 'gitStatus' | 'create' | 'rename' | 'duplicate' | 'trash' | 'readBytes' | 'write' | 'writeBytes';
export type FilesProtocolKey = FilesContentKey | 'subscribe' | 'onChange';
export type LocalFilesBridge = Pick<GenieBridge['files'], FilesProtocolKey>;

/** Buffer.from(base64)'s legacy acceptance, including unpadded/URL-safe input, for staged editor bytes. */
function decodeBase64(value: string): Uint8Array {
    let clean = value.split('=')[0]!.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
    if (clean.length % 4 === 1) clean = clean.slice(0, -1);
    const decoded = decodeLocalBase64(clean.padEnd(Math.ceil(clean.length / 4) * 4, '='));
    if (decoded === null) throw new Error('invalid base64 file bytes');
    return decoded;
}

const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
const displayedInvalid = (value: unknown): string | InvalidFilesArgument => typeof value === 'string' ? value : { invalidFilesArgument: String(value) };
/** Native guards run before JSON: invalid non-string values never serialize their BigInt/cyclic contents. */
function fileArguments(method: LocalFilesMethod, args: unknown[]): unknown[] {
    if (method === 'repo.call') {
        const [op, id, rel, a, b] = args;
        const flag = b === null || typeof b === 'string' || typeof b === 'number' || typeof b === 'boolean' ? b : null;
        return [displayedInvalid(op), text(id), text(rel), Array.isArray(a) ? a.filter((value): value is string => typeof value === 'string') : text(a), flag];
    }
    const safe: unknown[] = args.map(text);
    if (method === 'files.localOpen' || method === 'files.localReadMedia') safe[1] = displayedInvalid(args[1]);
    return safe;
}

export function filesContentReader(port: { release(ref: string): Promise<unknown>; blobs: BlobClient; pages: PageClient }) {
    const decode = async (value: FilesProjection): Promise<unknown> => {
        if (!value || typeof value !== 'object') throw new Error('invalid Files metadata projection');
        switch (value.t) {
            case 'value': return value.value;
            case 'json': return value.value;
            case 'undefined': return undefined;
            case 'blob': { const bytes = await port.blobs.readAll('workspace-file', value.ref); return value.encoding === 'base64' ? encodeLocalBase64(bytes) : new TextDecoder().decode(bytes); }
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
    return async <T>(result: unknown): Promise<T> => {
        if (!result || typeof result !== 'object' || !('filesContent' in result)) return result as T;
        const body = (result as FilesContentEnvelope).filesContent;
        if (!body || typeof body.ref !== 'string') throw new Error('invalid Files response reference');
        try { return await decode(body.value) as T; }
        finally { try { await port.release(body.ref); } catch { console.warn('[genie] a Files response could not be released'); } }
    };
}

export function localFilesClient(port: { read<T>(method: LocalFilesMethod, ...args: unknown[]): Promise<T>; release(ref: string): Promise<unknown>; blobs: BlobClient; uploads: LocalUploadClient; pages: PageClient; limit?: HeldLimit }): { files: Pick<GenieBridge['files'], FilesContentKey>; repo: NonNullable<GenieBridge['repo']> } {
    const decodeResult = filesContentReader(port), limit = port.limit ?? unlimited, coalesce = readCoalescer();
    /*
     * FILES STATE BY CURSOR (Tynn #522): this window keeps each workspace's state and asks only for what changed since its
     * last read; every view is answered with the whole state, as a full read would say it.
     */
    const kept = new Map<string, FilesStateKept>();
    const state = async (id: string): Promise<FilesState | null> => {
        const mine = typeof id === 'string' ? kept.get(id) : undefined;
        const reply = await request<unknown>('files.state', [id, mine?.cursor ?? null]);
        if (reply === null || reply === undefined) { if (typeof id === 'string') kept.delete(id); return null; }
        // A host that knows no cursors answers in full.
        if (!isFilesStateSince(reply)) return reply as FilesState;
        const next = applyFilesState(kept.get(id), reply);
        kept.set(id, next);
        return projectFilesState(next) as FilesState;
    };
    const request = async <T>(method: LocalFilesMethod, rawArgs: unknown[]): Promise<T> => {
        const args = fileArguments(method, rawArgs);
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
            // From the call until its response is released: that is how long the host can hold it (Tynn #547).
            return await limit(async () => decodeResult<T>(await port.read<unknown>(method, ...sent)));
        } finally { if (staged !== null) { try { await port.uploads.abort(staged); } catch { console.warn('[genie] a Files stage could not be released'); } } }
    };
    /** A READ joins the same read already queued (Tynn #547); writes always run. */
    const read = <T>(method: LocalFilesMethod, rawArgs: unknown[]): Promise<T> => coalesce(method + JSON.stringify(fileArguments(method, rawArgs)), () => request<T>(method, rawArgs));
    return {
        files: {
            tree: id => read('files.tree', [id]), children: (id, dir) => read('files.localChildren', [id, dir]),
            open: (id, path) => read('files.localOpen', [id, path]), readMedia: (id, path) => read('files.localReadMedia', [id, path]),
            lastCommitted: (id, path) => read('files.lastCommitted', [id, path]), state: id => coalesce('files.state' + JSON.stringify([typeof id === 'string' ? id : null]), () => state(id)), gitStatus: id => read('files.gitStatus', [id]),
            create: (id, path, kind) => request('files.create', [id, path, kind]), rename: (id, from, to) => request('files.rename', [id, from, to]),
            duplicate: (id, path) => request('files.duplicate', [id, path]), trash: (id, path) => request('files.trash', [id, path]),
            readBytes: (id, plugin, path) => read('files.readBytes', [id, plugin, path]), write: (id, path, text, expected) => request('files.write', [id, path, text, expected]),
            writeBytes: (id, plugin, path, base64, expected) => request('files.writeBytes', [id, plugin, path, base64, expected]),
        },
        repo: { call: (op, id, rel, a, b) => request('repo.call', [op, id, rel, a, b]) },
    };
}
