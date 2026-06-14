import { ipcMain } from 'electron';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { REGENERABLE_NAMES, SKIP_NAMES } from '../workspace/ignore';

/**
 * Filesystem IPC for the Code View. Three channels, all scoped to a
 * workspace root and hardened against escaping it:
 *
 *   files:list-tree(workspacePath, opts?) → TreeNodeData[]
 *     Walk the workspace into a folders-first tree. Reuses the analyser's
 *     SKIP_NAMES / REGENERABLE_NAMES so the tree mirrors what the envelope
 *     wizard considers noise. Depth + entry caps bound the walk; symlinks
 *     are never followed (a symlinked dir lists as a leaf, so it can't be
 *     used to escape the root via the tree).
 *
 *   files:read(workspacePath, relPath)  → { content, truncated }
 *   files:write(workspacePath, relPath, content) → { ok }
 *     Both resolve relPath against the workspace and reject anything that
 *     lands outside it (path-guard), oversize, or binary.
 *
 * The renderer never gets a raw fs handle — every path flows through the
 * guard here.
 */

/** Mirrors react-fancy's TreeNodeData (id/label/type/ext/children). */
export interface TreeNodeData {
    id: string;
    label: string;
    type?: 'file' | 'folder';
    ext?: string;
    children?: TreeNodeData[];
}

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_ENTRIES = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB read/write ceiling
const NUL = String.fromCharCode(0);

interface ListTreeOpts {
    maxDepth?: number;
    maxEntries?: number;
    /**
     * Workspace-relative subfolder to root the walk at (locked code views).
     * Guard-resolved under `workspacePath` — a `..`/absolute escape throws.
     * Node ids stay relative to `workspacePath` so reads still path-guard
     * against the workspace root, never the locked subroot.
     */
    root?: string;
}

/**
 * Resolve `relPath` under `workspacePath` and refuse to leave the root.
 * Returns the absolute path on success, or null when the resolved path
 * escapes (via `..`, an absolute path, or a different drive). The root
 * itself ('' or '.') resolves to the workspace root.
 */
function guardedResolve(workspacePath: string, relPath: string): string | null {
    const root = path.resolve(workspacePath);
    const abs = path.resolve(root, relPath);
    if (abs === root) return abs;
    if (abs.startsWith(root + path.sep)) return abs;
    return null;
}

/** A NUL byte in the first chunk is the cheap, reliable binary signal. */
function looksBinary(buf: Buffer): boolean {
    const n = Math.min(buf.length, 8000);
    for (let i = 0; i < n; i++) {
        if (buf[i] === 0) return true;
    }
    return false;
}

function extOf(name: string): string | undefined {
    const e = path.extname(name);
    return e ? e.slice(1).toLowerCase() : undefined;
}

/**
 * Walk `dir` into TreeNodeData[]. `idPrefix` is the workspace-relative
 * path of `dir` (forward-slashed, '' at root). `budget` is a shared
 * mutable entry counter so the whole walk stops at the cap. Symlinks are
 * surfaced as leaf nodes — never descended — so they can't escape root.
 */
async function walk(
    dir: string,
    idPrefix: string,
    depth: number,
    maxDepth: number,
    budget: { remaining: number },
): Promise<TreeNodeData[]> {
    if (depth > maxDepth || budget.remaining <= 0) return [];

    let entries: import('node:fs').Dirent[];
    try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }

    const folders: TreeNodeData[] = [];
    const files: TreeNodeData[] = [];

    for (const entry of entries) {
        if (budget.remaining <= 0) break;
        const name = entry.name;
        if (SKIP_NAMES.has(name) || REGENERABLE_NAMES.has(name.toLowerCase())) {
            continue;
        }
        const relId = idPrefix ? `${idPrefix}/${name}` : name;
        const abs = path.join(dir, name);

        // A symlink (to a dir or file) is listed but never followed: as a
        // leaf it carries no children, so the tree can't be used to walk
        // outside the workspace root.
        if (entry.isSymbolicLink()) {
            budget.remaining--;
            files.push({ id: relId, label: name, type: 'file', ext: extOf(name) });
            continue;
        }

        if (entry.isDirectory()) {
            budget.remaining--;
            const children = await walk(abs, relId, depth + 1, maxDepth, budget);
            folders.push({ id: relId, label: name, type: 'folder', children });
        } else if (entry.isFile()) {
            budget.remaining--;
            files.push({ id: relId, label: name, type: 'file', ext: extOf(name) });
        }
    }

    folders.sort((a, b) => a.label.localeCompare(b.label));
    files.sort((a, b) => a.label.localeCompare(b.label));
    // Folders first, then files (classic file-tree ordering).
    return [...folders, ...files];
}

export async function listTree(
    workspacePath: string,
    opts: ListTreeOpts = {},
): Promise<TreeNodeData[]> {
    const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const budget = { remaining: maxEntries };

    // A locked code view roots the walk at a workspace-relative subfolder.
    // Guard-resolve it against the workspace so it can't escape; the id
    // prefix keeps node ids relative to the WORKSPACE root, so file
    // reads/writes still path-guard against the workspace, not the subroot.
    const sub = (opts.root ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (sub) {
        const start = guardedResolve(workspacePath, sub);
        if (!start) throw new Error('Path escapes workspace');
        return walk(start, sub, 0, maxDepth, budget);
    }

    const root = path.resolve(workspacePath);
    return walk(root, '', 0, maxDepth, budget);
}

export async function readFile(
    workspacePath: string,
    relPath: string,
): Promise<{ content: string; truncated: boolean }> {
    const abs = guardedResolve(workspacePath, relPath);
    if (!abs) throw new Error('Path escapes workspace');
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) throw new Error('Not a file');
    const buf = await fsp.readFile(abs);
    if (looksBinary(buf)) throw new Error('Binary file');
    const truncated = buf.length > MAX_FILE_BYTES;
    const slice = truncated ? buf.subarray(0, MAX_FILE_BYTES) : buf;
    return { content: slice.toString('utf8'), truncated };
}

export async function writeFile(
    workspacePath: string,
    relPath: string,
    content: string,
): Promise<{ ok: boolean }> {
    const abs = guardedResolve(workspacePath, relPath);
    if (!abs) throw new Error('Path escapes workspace');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw new Error('Content exceeds size limit');
    // Guard against NUL bytes — these never appear in real source files and
    // would corrupt a UTF-8 write into binary garbage.
    if (content.indexOf(NUL) !== -1) {
        throw new Error('Refusing to write binary content');
    }
    await fsp.writeFile(abs, content, 'utf8');
    return { ok: true };
}

/**
 * Create an empty file at `relPath` under the workspace root. Fails if the
 * target already exists (so a "New file" never silently overwrites). The
 * parent directory is created as needed. Path-guarded like read/write.
 */
export async function createFile(
    workspacePath: string,
    relPath: string,
): Promise<{ ok: boolean }> {
    const abs = guardedResolve(workspacePath, relPath);
    if (!abs) throw new Error('Path escapes workspace');
    // The root itself is never a valid create target.
    if (abs === path.resolve(workspacePath)) throw new Error('Invalid path');
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    // wx = create + fail if it exists. Reliable across platforms.
    const fh = await fsp.open(abs, 'wx').catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'EEXIST') throw new Error('File already exists');
        throw e;
    });
    await fh.close();
    return { ok: true };
}

/**
 * Create a folder at `relPath` under the workspace root. Recursive
 * (intermediate dirs are made); a pre-existing folder is a no-op success
 * (mkdir recursive doesn't throw on EEXIST for a dir). Path-guarded.
 */
export async function createFolder(
    workspacePath: string,
    relPath: string,
): Promise<{ ok: boolean }> {
    const abs = guardedResolve(workspacePath, relPath);
    if (!abs) throw new Error('Path escapes workspace');
    if (abs === path.resolve(workspacePath)) throw new Error('Invalid path');
    await fsp.mkdir(abs, { recursive: true });
    return { ok: true };
}

/**
 * Rename / move a node from `fromRel` to `toRel`. BOTH paths are
 * guard-resolved against the workspace root, so neither side can escape.
 * Fails if the destination already exists (no clobber).
 */
export async function renamePath(
    workspacePath: string,
    fromRel: string,
    toRel: string,
): Promise<{ ok: boolean }> {
    const from = guardedResolve(workspacePath, fromRel);
    const to = guardedResolve(workspacePath, toRel);
    if (!from || !to) throw new Error('Path escapes workspace');
    const root = path.resolve(workspacePath);
    if (from === root || to === root) throw new Error('Invalid path');
    // No-clobber: refuse if the destination already exists.
    const exists = await fsp
        .access(to)
        .then(() => true)
        .catch(() => false);
    if (exists) throw new Error('Destination already exists');
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    return { ok: true };
}

/**
 * Delete the node at `relPath`. Recursive for folders. Path-guarded; the
 * workspace root itself can never be deleted.
 */
export async function deletePath(
    workspacePath: string,
    relPath: string,
): Promise<{ ok: boolean }> {
    const abs = guardedResolve(workspacePath, relPath);
    if (!abs) throw new Error('Path escapes workspace');
    if (abs === path.resolve(workspacePath)) throw new Error('Invalid path');
    await fsp.rm(abs, { recursive: true, force: true });
    return { ok: true };
}

export function registerFilesIpc(): void {
    ipcMain.handle(
        'files:list-tree',
        (_e, workspacePath: string, opts?: ListTreeOpts) =>
            listTree(workspacePath, opts ?? {}),
    );
    ipcMain.handle('files:read', (_e, workspacePath: string, relPath: string) =>
        readFile(workspacePath, relPath),
    );
    ipcMain.handle(
        'files:write',
        (_e, workspacePath: string, relPath: string, content: string) =>
            writeFile(workspacePath, relPath, content),
    );
    ipcMain.handle(
        'files:create-file',
        (_e, workspacePath: string, relPath: string) =>
            createFile(workspacePath, relPath),
    );
    ipcMain.handle(
        'files:create-folder',
        (_e, workspacePath: string, relPath: string) =>
            createFolder(workspacePath, relPath),
    );
    ipcMain.handle(
        'files:rename',
        (_e, workspacePath: string, fromRel: string, toRel: string) =>
            renamePath(workspacePath, fromRel, toRel),
    );
    ipcMain.handle(
        'files:delete',
        (_e, workspacePath: string, relPath: string) =>
            deletePath(workspacePath, relPath),
    );
}
