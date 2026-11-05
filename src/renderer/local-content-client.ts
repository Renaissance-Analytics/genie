import { bytesToBase64 } from '../core/mobile.js';
import { LOCAL_UPLOAD_CHUNK_BYTES, PAGE_MAX_BYTES, PAGE_MAX_ITEMS, type LocalUploadCalls, type LocalUploadClient, type MetadataItem, type MetadataPage, type PageCalls, type PageClient } from '../core/local-content.js';

function checkCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('the local content operation was cancelled'); }

/** Upload helpers share the existing client's call map and transport. No consumer is wired here. */
export function localUploadClient(port: LocalUploadCalls): LocalUploadClient {
    return { ...port, stage: async (target, bytes, options = {}) => {
        checkCancelled(options.signal);
        const opened = await port.begin({ ...target, size: bytes.byteLength });
        let complete = false;
        try {
            if (!opened || typeof opened.id !== 'string' || opened.size !== bytes.byteLength) throw new Error('invalid local upload metadata');
            for (let at = 0, index = 0; at < bytes.length; at += LOCAL_UPLOAD_CHUNK_BYTES, index++) {
                checkCancelled(options.signal);
                const end = Math.min(bytes.length, at + LOCAL_UPLOAD_CHUNK_BYTES);
                const r = await port.chunk(opened.id, index, bytesToBase64(bytes.subarray(at, end)));
                if (r.received !== end) throw new Error('the local upload did not receive its exact chunk');
            }
            checkCancelled(options.signal); complete = true; return opened;
        } finally {
            if (!complete && opened && typeof opened.id === 'string') {
                try { await port.abort(opened.id); } catch { console.warn('[genie] a failed local upload could not be aborted'); }
            }
        }
    } };
}

export function localPageClient(port: PageCalls): PageClient {
    return { ...port, readAll: async (kind, ref, options = {}) => {
        checkCancelled(options.signal);
        let cursor: string | null = null, failed = false;
        const items: MetadataItem[] = [];
        try {
            let page = await port.open(kind, ref);
            while (true) {
                // Remember a returned cursor before validation/cancellation so failure still releases it.
                if (page && typeof page.cursor === 'string') cursor = page.cursor;
                checkCancelled(options.signal); validatePage(page);
                cursor = page.cursor; items.push(...page.items);
                if (cursor === null) return items;
                page = await port.next(cursor);
            }
        } catch (error) { failed = true; throw error; }
        finally {
            if (cursor !== null) {
                try { await port.close(cursor); }
                catch (error) { if (!failed) throw error; console.warn('[genie] a failed local list could not be closed'); }
            }
        }
    } };
}

function validatePage(page: MetadataPage): void {
    if (!page || !Array.isArray(page.items) || page.items.length > PAGE_MAX_ITEMS || (page.cursor !== null && (typeof page.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(page.cursor))) || (page.cursor !== null && page.items.length === 0) || new TextEncoder().encode(JSON.stringify(page)).byteLength > PAGE_MAX_BYTES)
        throw new Error('invalid bounded metadata page');
    for (const item of page.items) if (!item || typeof item !== 'object' || typeof item.id !== 'string') throw new Error('invalid list item');
}
