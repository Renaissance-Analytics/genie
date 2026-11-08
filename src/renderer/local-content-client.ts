import { encodeLocalBase64 } from './local-base64.js';
import { LOCAL_UPLOAD_CHUNK_BYTES, MAX_OPEN_PAGES, PAGE_MAX_BYTES, PAGE_MAX_ITEMS, type LocalUploadCalls, type LocalUploadClient, type MetadataItem, type MetadataPage, type PageCalls, type PageClient } from '../core/local-content.js';

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
                const r = await port.chunk(opened.id, index, encodeLocalBase64(bytes.subarray(at, end)));
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

/** Runs a call that may leave a held response on the connection, for as long as it holds it. */
export type HeldLimit = <T>(run: () => Promise<T>) => Promise<T>;
export const unlimited: HeldLimit = run => run();

/**
 * ONE PER CONNECTION (Tynn #547): the host holds at most MAX_OPEN_PAGES responses or lists per connection, so the window
 * never runs more calls that can leave one held than that, less one. Extra calls wait their turn instead of failing.
 */
export function heldLimiter(max = MAX_OPEN_PAGES - 1): HeldLimit {
    let running = 0;
    const waiting: Array<() => void> = [];
    const acquire = (): Promise<void> => { if (running < max) { running++; return Promise.resolve(); } return new Promise<void>(resolve => { waiting.push(resolve); }); };
    // The slot passes straight to the next waiter, so a late caller cannot overtake the queue.
    const release = (): void => { const next = waiting.shift(); if (next) next(); else running--; };
    return async <T>(run: () => Promise<T>): Promise<T> => { await acquire(); try { return await run(); } finally { release(); } };
}

/**
 * Same read, same key (Tynn #547): a caller arriving while a read runs joins the ONE read queued behind it, which starts
 * when the running one ends, so every caller gets an answer at least as new as its ask, and reads never stack.
 */
export function readCoalescer(): <T>(key: string, read: () => Promise<T>) => Promise<T> {
    interface Lane { done: Promise<void>; queued: Promise<unknown> | null }
    const lanes = new Map<string, Lane>();
    const start = <T>(key: string, lane: Lane | null, read: () => Promise<T>): Promise<T> => {
        let p: Promise<T>;
        try { p = read(); } catch (error) { p = Promise.reject(error); }
        const settled = p.then(() => {}, () => {}), current: Lane = lane ?? { done: settled, queued: null };
        current.done = settled; lanes.set(key, current);
        void settled.then(() => { if (lanes.get(key) === current && current.done === settled && current.queued === null) lanes.delete(key); });
        return p;
    };
    return <T>(key: string, read: () => Promise<T>): Promise<T> => {
        const lane = lanes.get(key);
        if (!lane) return start(key, null, read);
        if (lane.queued) return lane.queued as Promise<T>;
        const queued = lane.done.then(() => { lane.queued = null; return start(key, lane, read); });
        lane.queued = queued;
        return queued;
    };
}
