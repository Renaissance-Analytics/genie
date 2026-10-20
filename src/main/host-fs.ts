import { lstat, readdir, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

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

const fwd = (p: string) => p.replace(/\\/g, '/');
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
    const target = fwd(path.trim());
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
