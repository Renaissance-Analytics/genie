import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { staticFile } from '../core/mobile.js';

/** What the listener hands back for a GET it serves. */
export interface ServedFile {
    body: Uint8Array;
    contentType: string;
    cache: string;
}

export type PageServer = (urlPath: string) => Promise<ServedFile | null>;

/**
 * THE PHONE'S PAGE FROM DISK (§6.8). `staticFile` decides what a path may mean; this reads it from
 * the built renderer directory and nothing else. A file the allow-list names but the build did not
 * produce is null, the same as a path the list refuses — the listener turns both into a 404.
 */
export function staticServer(root: string): PageServer {
    return async (urlPath) => {
        const file = staticFile(urlPath);
        if (!file) return null;
        try {
            const body = await readFile(join(root, file.relative));
            return { body, contentType: file.contentType, cache: file.cache };
        } catch {
            return null;
        }
    };
}
