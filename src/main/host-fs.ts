import { lstat, mkdir, readdir, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { folderNameProblem, hostFolder } from '../core/host-path.js';

/**
 * ONE FOLDER OF THE HOST, ON DEMAND (Tynn #835; Genie 1's #199 `listSystemTree`). The listing every file and folder
 * picker reads — through the remote protocol too, so a window driving another machine browses THAT machine's disk.
 *
 * `/` is the root: Windows lists its drives (`C:/`, `D:/`…), elsewhere `/` itself. Any other path is an absolute folder
 * of this machine, listed one level deep: folders first, then files, by name; paths absolute and forward-slashed. A
 * symlink is listed and never followed (a leaf). Nothing is hidden — a picker shows what is there.
 */

export interface HostEntry {
    readonly path: string;
    readonly name: string;
    readonly kind: 'dir' | 'file';
}

export type HostListing = { readonly ok: true; readonly path: string; readonly entries: readonly HostEntry[] } | { readonly ok: false; readonly reason: string };

const byName = (a: HostEntry, b: HostEntry) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.kind === 'dir' ? -1 : 1);

/**
 * Windows drive roots that answer (Genie 1's listWindowsDrives, genie#466): every letter probed in parallel, each given
 * 1.5 s — a disconnected network drive must not hold the picker — and a dead one dropped.
 */
async function windowsDrives(): Promise<string[]> {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const alive = await Promise.all(letters.map((l) => Promise.race([
        stat(`${l}:/`).then(() => true, () => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
    ])));
    const drives = letters.filter((_, i) => alive[i]).map((l) => `${l}:/`);
    return drives.length > 0 ? drives : ['C:/'];
}

export async function listHostDir(path: string, opts: { platform?: NodeJS.Platform; drives?: () => Promise<string[]> } = {}): Promise<HostListing> {
    const platform = opts.platform ?? process.platform;
    const target = hostFolder(path);
    if (platform === 'win32' && (target === '' || target === '/')) {
        const drives = await (opts.drives ?? windowsDrives)();
        return { ok: true, path: '/', entries: drives.map((d) => ({ path: d, name: d.replace(/\/$/, ''), kind: 'dir' as const })) };
    }
    const dir = target === '' ? '/' : target;
    if (!(dir.startsWith('/') || /^[A-Za-z]:\//.test(dir)) || !isAbsolute(dir)) return { ok: false, reason: `${path} is not an absolute path on this machine` };
    let names: string[];
    try {
        names = await readdir(dir);
    } catch (error) {
        return { ok: false, reason: `${dir} could not be read (${error instanceof Error ? error.message : String(error)})` };
    }
    const base = dir.endsWith('/') ? dir.slice(0, -1) : dir;
    const entries: HostEntry[] = [];
    for (const name of names) {
        const full = `${base}/${name}`;
        try {
            const info = await lstat(full);
            entries.push({ path: full, name, kind: info.isDirectory() && !info.isSymbolicLink() ? 'dir' : 'file' });
        } catch {
            /* vanished between the listing and the look: not listed */
        }
    }
    return { ok: true, path: dir, entries: entries.sort(byName) };
}

export type HostMade = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string };

/**
 * NEW FOLDER, ON THE HOST (the owner, 2026-10-22: the folder picker could not make one). `name` is made directly inside
 * `parent` — never deeper, never outside: the name is checked here, on the host, whatever the window checked — and the
 * folder's absolute, forward-slashed path is the answer. An existing name is refused, not reused; nothing is made in the
 * drive list. Reasons are the picker's own words (core/host-path.ts).
 */
export async function makeHostDir(parent: string, name: string, opts: { platform?: NodeJS.Platform } = {}): Promise<HostMade> {
    const platform = opts.platform ?? process.platform;
    const problem = folderNameProblem(name);
    if (problem) return { ok: false, reason: problem };
    const dir = hostFolder(parent);
    if (platform === 'win32' && dir === '/') return { ok: false, reason: 'Open a drive to make a folder in it.' };
    if (!(dir.startsWith('/') || /^[A-Za-z]:\//.test(dir)) || !isAbsolute(dir)) return { ok: false, reason: `${parent} is not an absolute path on this machine` };
    const trimmed = name.trim();
    const full = `${dir.endsWith('/') ? dir.slice(0, -1) : dir}/${trimmed}`;
    try {
        await mkdir(full);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: `“${trimmed}” already exists here.` };
        return { ok: false, reason: `${full} could not be made (${error instanceof Error ? error.message : String(error)})` };
    }
    return { ok: true, path: full };
}
