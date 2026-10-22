/**
 * A FOLDER OF THE HOST, AS THE PICKER MOVES THROUGH IT (the owner, 2026-10-22: "I am unable to create a folder or navigate
 * to other folders outside of the user root unless I manually put the path in the folder picker").
 *
 * Paths are the host listing's (main/host-fs.ts): absolute, forward-slashed; `/` is the machine's root — its drives on
 * Windows (`C:/`, `D:/`), `/` itself elsewhere. Pure: the window decides where Up goes without asking the host, and the
 * host checks a new folder's name with the same words the picker shows.
 */

const DRIVE_BARE = /^[A-Za-z]:$/;
const DRIVE_ROOT = /^[A-Za-z]:\/$/;

/**
 * A folder as the host reads it: forward slashes; a bare drive (`C:`, what a breadcrumb or a typed `C:\` leaves) is that
 * drive's root `C:/` — node reads a bare `C:` as the folder last used on C, not its root; no trailing slash but on a root.
 */
export function hostFolder(path: string): string {
    const p = path.trim().replace(/\\/g, '/');
    if (p === '' || p === '/') return '/';
    if (DRIVE_BARE.test(p)) return `${p}/`;
    if (DRIVE_ROOT.test(p)) return p;
    const trimmed = p.replace(/\/+$/, '');
    if (DRIVE_BARE.test(trimmed)) return `${trimmed}/`;
    return trimmed === '' ? '/' : trimmed;
}

/** Up: the parent folder. A drive's parent is the drive list (`/`); the root has none. */
export function parentOf(path: string): string | null {
    const p = hostFolder(path);
    if (p === '/') return null;
    if (DRIVE_ROOT.test(p)) return '/';
    const i = p.lastIndexOf('/');
    if (i <= 0) return '/';
    const parent = p.slice(0, i);
    return DRIVE_BARE.test(parent) ? `${parent}/` : parent;
}

/**
 * The machine's roots, from the host's listing of `/`: on Windows that listing IS the drives (`C:/`, `D:/`); anywhere else
 * it is the folders under `/`, and the one root is `/`. An unreadable root still leaves `/` to go to.
 */
export function rootsOf(listing: { readonly ok: true; readonly path: string; readonly entries: readonly { readonly path: string }[] } | { readonly ok: false; readonly reason: string }): string[] {
    if (!listing.ok || listing.entries.length === 0) return ['/'];
    return listing.entries.every((e) => DRIVE_ROOT.test(e.path)) ? listing.entries.map((e) => e.path) : ['/'];
}

/** A root as its button reads: `C:` for a drive, `/` for the POSIX root. */
export function rootLabel(root: string): string {
    return DRIVE_ROOT.test(root) ? root.slice(0, -1) : root;
}

/**
 * What is wrong with a new folder's name, or null — in the words react-fancy's FileBrowser shows on its own New folder
 * form, so the picker speaks with one voice whether the window or the host caught it. A name never leaves its parent.
 */
export function folderNameProblem(raw: string): string | null {
    const name = raw.trim();
    if (name === '') return 'Enter a name.';
    if (name.includes('/') || name.includes('\\')) return 'A name cannot contain / or \\.';
    if (name === '.' || name === '..') return 'That name is reserved.';
    return null;
}
