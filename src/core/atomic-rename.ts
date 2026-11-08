import { renameSync, rmSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';

/**
 * THE LAST STEP OF AN ATOMIC WRITE: A TEMP FILE RENAMED OVER ITS TARGET (Tynn #580). On Windows the rename fails with EPERM,
 * EACCES or EBUSY while another program (Defender, the indexer) briefly holds either file. On genie#1781's Windows run a
 * relaunched genie-host died on that renaming `host.json` into place, after the only write that retried gave up at 300 ms.
 *
 * Every runtime atomic write goes through here (test/atomic-rename.test.ts holds them to it): a bounded retry on Windows; at
 * the end the temp file is gone and the error says which file and why. Off Windows these codes are real permission
 * failures, and any other code is a real failure anywhere: neither is retried.
 */

/** About three seconds: well inside the 20 s a window gives a relaunching host to become ready. */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [20, 40, 80, 160, 320, 500, 500, 500, 500, 500];
/** A synchronous retry holds its thread, so it is short. */
export const RENAME_RETRY_SYNC_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160];

const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

interface AsyncPorts { readonly platform?: NodeJS.Platform; readonly rename?: (from: string, to: string) => Promise<void>; readonly remove?: (path: string) => Promise<void>; readonly sleep?: (ms: number) => Promise<void> }
interface SyncPorts { readonly platform?: NodeJS.Platform; readonly rename?: (from: string, to: string) => void; readonly remove?: (path: string) => void; readonly sleep?: (ms: number) => void }

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

function namedFailure(file: string, error: unknown): Error {
    const code = codeOf(error);
    return Object.assign(new Error(`could not write ${file}: ${code} after retrying; another program is holding it (${error instanceof Error ? error.message : String(error)})`), { code });
}

export async function renameOver(temp: string, file: string, ports: AsyncPorts = {}): Promise<void> {
    const windows = (ports.platform ?? process.platform) === 'win32';
    const move = ports.rename ?? rename;
    const remove = ports.remove ?? ((path: string) => rm(path, { force: true }));
    const sleep = ports.sleep ?? ((ms: number) => new Promise<void>((done) => { setTimeout(done, ms); }));
    for (let attempt = 0; ; attempt += 1) {
        try {
            await move(temp, file);
            return;
        } catch (error) {
            const transient = windows && TRANSIENT.has(codeOf(error) ?? '');
            if (transient && attempt < RENAME_RETRY_DELAYS_MS.length) { await sleep(RENAME_RETRY_DELAYS_MS[attempt]!); continue; }
            await remove(temp).catch(() => undefined);
            throw transient ? namedFailure(file, error) : error;
        }
    }
}

export function renameOverSync(temp: string, file: string, ports: SyncPorts = {}): void {
    const windows = (ports.platform ?? process.platform) === 'win32';
    const move = ports.rename ?? renameSync;
    const remove = ports.remove ?? ((path: string) => rmSync(path, { force: true }));
    // A bounded spin, only while Windows reports a lock (at most RENAME_RETRY_SYNC_DELAYS_MS in all).
    const sleep = ports.sleep ?? ((ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* the rename is what we wait for */ } });
    for (let attempt = 0; ; attempt += 1) {
        try {
            move(temp, file);
            return;
        } catch (error) {
            const transient = windows && TRANSIENT.has(codeOf(error) ?? '');
            if (transient && attempt < RENAME_RETRY_SYNC_DELAYS_MS.length) { sleep(RENAME_RETRY_SYNC_DELAYS_MS[attempt]!); continue; }
            try { remove(temp); } catch { /* the failure below is the one to say */ }
            throw transient ? namedFailure(file, error) : error;
        }
    }
}
