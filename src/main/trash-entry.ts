import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * ONE ENTRY OF A WORKSPACE'S .trash (Tynn #697), the format every mover shares: a folder `.trash/genie-<ms>-<hex6>/` holding
 * the moved thing as `item` and its origin in `genie-trash.json`, so the Storage tab lists it and Restore puts it back. The
 * Storage tab's own moves (main/workspace-storage-host.ts) and the ArtBoard's Clear (genie#847) both write it from here.
 */
export const TRASH_RECORD = 'genie-trash.json';
export const TRASH_PAYLOAD = 'item';
export const TRASH_ID = /^genie-\d+-[0-9a-f]{6}$/;
export const LINKED_TRASH = 'This workspace’s .trash is a link, not a folder: Genie will not use it.';

/** `.trash` as a folder; `null` when absent; refused when it is anything else (a link would leave the workspace). */
export async function trashFolder(rootReal: string, create: boolean): Promise<{ ok: true; dir: string | null } | { ok: false; reason: string }> {
    const dir = join(rootReal, '.trash');
    try {
        const s = await lstat(dir);
        if (s.isSymbolicLink()) return { ok: false, reason: LINKED_TRASH };
        if (!s.isDirectory()) return { ok: false, reason: 'This workspace’s .trash is a file, not a folder.' };
        return { ok: true, dir };
    } catch {
        if (!create) return { ok: true, dir: null };
        await mkdir(dir, { recursive: true });
        return { ok: true, dir };
    }
}
