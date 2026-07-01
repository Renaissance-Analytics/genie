import { ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { REGENERABLE_NAMES, SKIP_NAMES } from '../workspace/ignore';
import { unwatchWorkspace, watchWorkspace } from './watch';

const execFileAsync = promisify(execFile);

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
 * Build a `-copy` sibling name for `name`, inserting the suffix BEFORE the
 * extension: `foo.txt` → `foo-copy.txt`, `Makefile` → `Makefile-copy`,
 * `.gitignore` → `.gitignore-copy`. `n` (2, 3, …) disambiguates collisions:
 * `foo-copy-2.txt`.
 */
function copyName(name: string, n: number): string {
    const ext = path.extname(name);
    const base = ext ? name.slice(0, -ext.length) : name;
    const suffix = n > 1 ? `-copy-${n}` : '-copy';
    return `${base}${suffix}${ext}`;
}

/**
 * Duplicate the file at `relPath` as a `-copy` sibling, returning the new
 * workspace-relative path. Picks the first free `-copy` / `-copy-N` name so an
 * existing copy is never clobbered. Path-guarded on both ends; the workspace
 * root and folders are rejected (duplicate is a file-only op).
 */
export async function duplicatePath(
    workspacePath: string,
    relPath: string,
): Promise<{ ok: boolean; relPath: string }> {
    const from = guardedResolve(workspacePath, relPath);
    if (!from) throw new Error('Path escapes workspace');
    if (from === path.resolve(workspacePath)) throw new Error('Invalid path');
    const stat = await fsp.stat(from);
    if (!stat.isFile()) throw new Error('Not a file');

    const dir = path.dirname(from);
    const name = path.basename(from);
    const norm = relPath.replace(/\\/g, '/');
    const slash = norm.lastIndexOf('/');
    const relDir = slash === -1 ? '' : norm.slice(0, slash);

    // Find the first free -copy name in the source folder.
    for (let n = 1; n <= 1000; n++) {
        const candidate = copyName(name, n);
        const toAbs = path.join(dir, candidate);
        // Keep the destination inside the workspace (defensive — the source
        // already is, so a sibling is too, but guard anyway).
        const toRel = relDir ? `${relDir}/${candidate}` : candidate;
        if (!guardedResolve(workspacePath, toRel)) continue;
        const taken = await fsp
            .access(toAbs)
            .then(() => true)
            .catch(() => false);
        if (taken) continue;
        await fsp.copyFile(from, toAbs);
        return { ok: true, relPath: toRel };
    }
    throw new Error('Too many copies');
}

/**
 * Copy an EXTERNAL file/folder (an arbitrary OS path, e.g. dragged in from
 * Windows Explorer / Finder) INTO a workspace folder. The SOURCE is an arbitrary
 * disk path (must exist); the DESTINATION is guard-resolved against the workspace
 * root, so a drop from outside can never write outside the workspace. On a name
 * collision a `-copy` sibling is chosen rather than clobbering. Returns the new
 * workspace-relative path. (Internal moves use renamePath — copy is for external
 * sources only.)
 */
export async function importExternalPath(
    workspacePath: string,
    srcAbs: string,
    destFolderRel: string,
): Promise<{ ok: boolean; relPath: string }> {
    if (!srcAbs) throw new Error('No source path');
    const stat = await fsp.stat(srcAbs); // throws if the source is gone
    const leaf = path.basename(srcAbs);
    if (!leaf) throw new Error('Invalid source path');

    const dir = (destFolderRel ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    const baseRel = dir ? `${dir}/${leaf}` : leaf;
    const baseAbs = guardedResolve(workspacePath, baseRel);
    if (!baseAbs) throw new Error('Destination escapes workspace');

    // No-clobber: pick the first free `-copy` name in the destination folder.
    let finalRel = baseRel;
    let finalAbs = baseAbs;
    const exists = await fsp.access(baseAbs).then(() => true).catch(() => false);
    if (exists) {
        finalRel = '';
        for (let n = 1; n <= 1000; n++) {
            const candRel = dir ? `${dir}/${copyName(leaf, n)}` : copyName(leaf, n);
            const candAbs = guardedResolve(workspacePath, candRel);
            if (!candAbs) continue;
            const taken = await fsp.access(candAbs).then(() => true).catch(() => false);
            if (taken) continue;
            finalRel = candRel;
            finalAbs = candAbs;
            break;
        }
        if (!finalRel) throw new Error('Too many copies — clear some out first.');
    }

    await fsp.mkdir(path.dirname(finalAbs), { recursive: true });
    if (stat.isDirectory()) {
        await fsp.cp(srcAbs, finalAbs, { recursive: true });
    } else {
        await fsp.copyFile(srcAbs, finalAbs);
    }
    return { ok: true, relPath: finalRel };
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

/**
 * A workspace-relative path → single status token. Tokens are normalised
 * (not raw 2-char XY codes) so the renderer can colour without re-parsing:
 *   'untracked' | 'modified' | 'added' | 'deleted' | 'renamed' | 'ignored'
 */
export type GitFileStatus =
    | 'untracked'
    | 'modified'
    | 'added'
    | 'deleted'
    | 'renamed'
    | 'ignored';

export type GitStatusMap = Record<string, GitFileStatus>;

/**
 * Collapse a porcelain v1 two-char XY status into one normalised token.
 * X = staged (index) state, Y = worktree state. Precedence is chosen for
 * a file-tree colouring use-case (what does the user most want to see):
 *   '??' untracked, '!!' ignored, any 'D' deleted, any 'R' renamed,
 *   index 'A' added/staged, otherwise modified.
 */
function classifyXY(xy: string): GitFileStatus {
    if (xy === '??') return 'untracked';
    if (xy === '!!') return 'ignored';
    const x = xy[0];
    const y = xy[1];
    if (x === 'R' || y === 'R') return 'renamed';
    if (x === 'D' || y === 'D') return 'deleted';
    if (x === 'A') return 'added';
    return 'modified';
}

/**
 * Forward-slash a git porcelain path and strip the surrounding quotes git
 * adds when a path has "unusual" chars. Quoted paths can carry C-style
 * escapes (\t, \", \\, octal) — git only quotes when `core.quotepath` is on
 * (the default), but porcelain v1 with `-z` would avoid them. We don't pass
 * `-z` (so rename `->` parsing stays simple), so handle the common quote
 * unwrapping for paths with spaces / specials.
 */
function unquotePath(p: string): string {
    let s = p;
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
        s = s.slice(1, -1).replace(/\\(["\\])/g, '$1');
    }
    return s.replace(/\\/g, '/');
}

/**
 * Parse `git status --porcelain=v1` output into a workspace-relative path →
 * status map. Each line is `XY <path>` (or `XY <old> -> <new>` for renames).
 * For a rename we record the NEW path (the one that exists in the tree) as
 * 'renamed'. Exported for unit testing the parser in isolation.
 */
export function parseGitPorcelain(stdout: string): GitStatusMap {
    const map: GitStatusMap = {};
    for (const rawLine of stdout.split('\n')) {
        if (!rawLine) continue;
        // Strip a trailing CR (porcelain lines are \n-separated, but be safe).
        const line = rawLine.replace(/\r$/, '');
        if (line.length < 3) continue;
        const xy = line.slice(0, 2);
        const rest = line.slice(3); // skip the single space after XY
        const status = classifyXY(xy);

        // Rename/copy lines carry "old -> new"; the new path is what's on disk.
        // The ` -> ` separator sits between two (possibly quoted) paths.
        const arrow = rest.indexOf(' -> ');
        if (arrow !== -1 && (xy[0] === 'R' || xy[0] === 'C')) {
            const newPath = unquotePath(rest.slice(arrow + 4));
            map[newPath] = status;
            continue;
        }
        map[unquotePath(rest)] = status;
    }
    return map;
}

/**
 * Run `git status` in `workspacePath` and return a normalised path→status
 * map. Never throws: a non-git dir, missing git, or any git error yields an
 * empty map (the tree simply isn't coloured). Args are passed as an array
 * (no shell) so paths with spaces / specials can't be interpolated.
 *
 * `-uall` lists every untracked file individually (not just the containing
 * dir). `--ignored` is opt-in via `opts.ignored` — off by default since the
 * walk already hides most ignored noise and listing it all is wasteful.
 */
export async function gitStatus(
    workspacePath: string,
    opts: { ignored?: boolean } = {},
): Promise<GitStatusMap> {
    const root = path.resolve(workspacePath);
    // Cheap pre-check: a workspace with no .git (and not inside one) won't be
    // a repo. We still let git decide (submodules, .git files), but bail fast
    // when the dir itself is unreadable.
    try {
        const args = ['status', '--porcelain=v1', '-uall'];
        if (opts.ignored) args.push('--ignored');
        const { stdout } = await execFileAsync('git', args, {
            cwd: root,
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
            timeout: 10_000,
        });
        return parseGitPorcelain(stdout);
    } catch {
        // Not a repo, git missing, timeout, etc. → no colouring.
        return {};
    }
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
        'files:duplicate',
        (_e, workspacePath: string, relPath: string) =>
            duplicatePath(workspacePath, relPath),
    );
    // Copy an external OS path (Explorer/Finder drag) into a workspace folder.
    ipcMain.handle(
        'files:import-external',
        (_e, workspacePath: string, srcAbs: string, destFolderRel: string) =>
            importExternalPath(workspacePath, srcAbs, destFolderRel ?? ''),
    );
    ipcMain.handle(
        'files:delete',
        (_e, workspacePath: string, relPath: string) =>
            deletePath(workspacePath, relPath),
    );
    ipcMain.handle(
        'files:git-status',
        (_e, workspacePath: string, opts?: { ignored?: boolean }) =>
            gitStatus(workspacePath, opts ?? {}),
    );
    // Live tree: start/stop watching a workspace root on disk. Changes made
    // outside the renderer (agents, git, tools) broadcast 'files:tree-changed'.
    ipcMain.handle('files:watch', (_e, workspacePath: string) => {
        watchWorkspace(workspacePath);
        return { ok: true };
    });
    ipcMain.handle('files:unwatch', (_e, workspacePath: string) => {
        unwatchWorkspace(workspacePath);
        return { ok: true };
    });
}
