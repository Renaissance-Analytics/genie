import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renameOver } from '../core/atomic-rename.js';

/**
 * AN APP'S ISOLATED STORE (GApps v2, V5, Tynn #570; spec .ai/plans/specs/gapps-v2.md section 3, decision 5). One folder per
 * app (a preview has its own, GAppBook.storageDir). Each key is one file named by the key's hash, so no key can name a path;
 * the file holds the key and its value, so `list` can give the key back.
 *
 * The quota is measured from the files at each set, so it is true after a crash; a set that does not fit is refused in
 * words and writes nothing, and a set that fits arrives whole (temporary file, then the shared atomic rename).
 */
export const GAPP_STORAGE_QUOTA = 50 * 1024 * 1024;

const MAX_KEY_BYTES = 1024;
const ENTRY = /^[0-9a-f]{64}\.json$/;

export type StoreAnswer<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Why this is not a usable key, or null. */
export function storeKeyProblem(key: unknown): string | null {
    if (typeof key !== 'string' || key === '') return 'storage needs a key: a non-empty string';
    return Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES ? 'a storage key is at most 1,024 bytes' : null;
}

function megabytes(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    return bytes >= 1024 * 1024 ? `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB` : `${bytes} bytes`;
}

export class GAppStore {
    readonly #dir: string;
    readonly #name: string;
    readonly #quota: number;
    #queue: Promise<unknown> = Promise.resolve();
    #temporary = 0;

    constructor(input: { dir: string; name: string; quotaBytes: number }) {
        this.#dir = input.dir;
        this.#name = input.name;
        this.#quota = input.quotaBytes;
    }

    #fileName(key: string): string {
        return `${createHash('sha256').update(key, 'utf8').digest('hex')}.json`;
    }

    async get(key: string): Promise<unknown> {
        try {
            return (JSON.parse(await readFile(join(this.#dir, this.#fileName(key)), 'utf8')) as { value: unknown }).value;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
    }

    set(key: string, value: unknown): Promise<StoreAnswer<true>> {
        return this.#serial(async () => {
            const body = JSON.stringify({ key, value });
            const name = this.#fileName(key);
            await mkdir(this.#dir, { recursive: true });
            const used = await this.#usedWithout(name);
            if (used + Buffer.byteLength(body, 'utf8') > this.#quota) {
                return { ok: false as const, reason: `${this.#name}'s storage is full: an app keeps at most ${megabytes(this.#quota)}. Nothing was saved.` };
            }
            const file = join(this.#dir, name);
            const tmp = `${file}.${process.pid}.${this.#temporary++}.tmp`;
            try {
                await writeFile(tmp, body, 'utf8');
                await renameOver(tmp, file);
            } catch (error) {
                await rm(tmp, { force: true });
                throw error;
            }
            return { ok: true as const, value: true as const };
        });
    }

    /** `true` if the key was there. */
    delete(key: string): Promise<boolean> {
        return this.#serial(async () => {
            const file = join(this.#dir, this.#fileName(key));
            try {
                await stat(file);
            } catch {
                return false;
            }
            await rm(file, { force: true });
            return true;
        });
    }

    async list(prefix = ''): Promise<string[]> {
        const keys: string[] = [];
        for (const name of await this.#entries()) {
            try {
                const { key } = JSON.parse(await readFile(join(this.#dir, name), 'utf8')) as { key: string };
                if (key.startsWith(prefix)) keys.push(key);
            } catch { /* deleted while listing */ }
        }
        return keys.sort();
    }

    async #entries(): Promise<string[]> {
        try {
            return (await readdir(this.#dir)).filter((name) => ENTRY.test(name));
        } catch {
            return [];
        }
    }

    async #usedWithout(replaced: string): Promise<number> {
        let used = 0;
        for (const name of await this.#entries()) {
            if (name !== replaced) used += (await stat(join(this.#dir, name))).size;
        }
        return used;
    }

    #serial<T>(work: () => Promise<T>): Promise<T> {
        const run = this.#queue.then(work, work);
        this.#queue = run.then(() => undefined, () => undefined);
        return run;
    }
}
