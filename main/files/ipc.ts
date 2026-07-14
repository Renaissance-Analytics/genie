import { ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { REGENERABLE_NAMES, SKIP_NAMES } from '../workspace/ignore';
import { isDesktop } from '../runtime-mode';
import { unwatchWorkspace, watchWorkspace } from './watch';

const execFileAsync = promisify(execFile);

/**
 * A validation error whose message is INTENTIONALLY safe to show the client
 * (e.g. "Path escapes workspace"). The safe text lives on `clientMessage` — a
 * property distinct from `.message`/`.stack` — so response paths can surface it
 * without tripping CodeQL js/stack-trace-exposure; every OTHER thrown error stays
 * redacted to a generic message + logged main-side.
 */
export class ClientError extends Error {
    readonly clientMessage: string;

    constructor(message: string) {
        super(message);
        this.name = 'ClientError';
        this.clientMessage = message;
    }
}

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
     *
     * For a SYSTEM-workspace request (`system: true`, desktop only) `root` is
     * instead an ABSOLUTE path to drill into (a tree node id like `C:/Users/x`
     * or `/home/x`).
     */
    root?: string;
    /**
     * SYSTEM-workspace full-filesystem browse. When true AND this is the desktop
     * (never headless), the tree roots at the machine's filesystem root(s) —
     * drive letters on Windows, `/` on POSIX — with ABSOLUTE node ids, and
     * reads/writes accept any absolute path. Fail-closed everywhere else.
     */
    system?: boolean;
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

/**
 * Whether a request may use UNCONFINED full-filesystem access. TRUE only for a
 * System-workspace request (`system === true`) ON THE DESKTOP. Fail-closed: the
 * headless genie-cloud host is ALWAYS false — so a headless build can never
 * resolve outside a workspace root, even if a caller set `system`. The System
 * workspace is a desktop-only concept (the user's own trusted local machine);
 * headless serves ONLY confined, real workspaces.
 */
function fullFsAllowed(system: boolean | undefined): boolean {
    return system === true && isDesktop();
}

/**
 * Resolve a path for a request, honouring the System-workspace full-FS bypass.
 *   - Full-FS (system + desktop): `relPath` is either an absolute path (a system
 *     tree node id) or relative to `workspacePath` (the home dir). No confinement
 *     — this is the user's own machine. Returns the resolved absolute path.
 *   - Otherwise: the confined {@link guardedResolve} (null on escape).
 */
function resolvePath(
    workspacePath: string,
    relPath: string,
    system: boolean | undefined,
): string | null {
    if (fullFsAllowed(system)) return path.resolve(workspacePath, relPath);
    return guardedResolve(workspacePath, relPath);
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
 * BREADTH-FIRST directory walk into TreeNodeData[]. Listing every DIRECT child
 * of a directory before descending into any of them is what stops a big early
 * subtree (a full checkout under `.worktrees`, a repo under `repos/`) from
 * STARVING shallow siblings: the shared `budget` truncates DEPTH, never a
 * directory's own entries — so a workspace root ALWAYS lists all its children
 * (the old depth-first walk `break`/`return []`-ed on budget exhaustion, which
 * dropped later root-level entries like `repos` once earlier subtrees drained
 * the cap). Symlinks are surfaced as leaves, never descended, so the tree can't
 * walk outside root. `idOf` derives each node id (workspace-relative for the
 * project tree, absolute for the System full-FS tree).
 */
async function walkBreadthFirst(
    rootDir: string,
    rootId: string,
    startDepth: number,
    maxDepth: number,
    budget: { remaining: number },
    idOf: (parentId: string, name: string, abs: string) => string,
): Promise<TreeNodeData[]> {
    const rootChildren: TreeNodeData[] = [];
    const queue: { dir: string; id: string; depth: number; out: TreeNodeData[] }[] = [
        { dir: rootDir, id: rootId, depth: startDepth, out: rootChildren },
    ];

    while (queue.length > 0) {
        const { dir, id: parentId, depth, out } = queue.shift()!;
        if (depth > maxDepth || budget.remaining <= 0) continue;

        let entries: import('node:fs').Dirent[];
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }

        const folders: TreeNodeData[] = [];
        const files: TreeNodeData[] = [];

        for (const entry of entries) {
            if (budget.remaining <= 0) break;
            const name = entry.name;
            if (SKIP_NAMES.has(name) || REGENERABLE_NAMES.has(name.toLowerCase())) {
                continue;
            }
            const abs = path.join(dir, name);
            const nodeId = idOf(parentId, name, abs);

            // A symlink is listed but never followed — a leaf can't walk out of root.
            if (entry.isSymbolicLink()) {
                budget.remaining--;
                files.push({ id: nodeId, label: name, type: 'file', ext: extOf(name) });
                continue;
            }
            if (entry.isDirectory()) {
                budget.remaining--;
                const children: TreeNodeData[] = [];
                folders.push({ id: nodeId, label: name, type: 'folder', children });
                // Descend on a LATER pass (breadth-first) so this whole level is
                // listed before any of its subtrees consume the budget.
                queue.push({ dir: abs, id: nodeId, depth: depth + 1, out: children });
            } else if (entry.isFile()) {
                budget.remaining--;
                files.push({ id: nodeId, label: name, type: 'file', ext: extOf(name) });
            }
        }

        folders.sort((a, b) => a.label.localeCompare(b.label));
        files.sort((a, b) => a.label.localeCompare(b.label));
        // Folders first, then files (classic file-tree ordering).
        out.push(...folders, ...files);
    }

    return rootChildren;
}

/**
 * Walk `dir` into TreeNodeData[] with WORKSPACE-RELATIVE node ids. `idPrefix`
 * is the workspace-relative path of `dir` ('' at root). Breadth-first (see
 * {@link walkBreadthFirst}) so the root's direct children are never starved.
 */
function walk(
    dir: string,
    idPrefix: string,
    depth: number,
    maxDepth: number,
    budget: { remaining: number },
): Promise<TreeNodeData[]> {
    return walkBreadthFirst(dir, idPrefix, depth, maxDepth, budget, (parentId, name) =>
        parentId ? `${parentId}/${name}` : name,
    );
}

/**
 * Walk `dir` into TreeNodeData[] with ABSOLUTE, forward-slashed node ids (for
 * the System-workspace full-FS browse). Same rules as {@link walk} (breadth-first
 * via {@link walkBreadthFirst}, so shallow siblings are never starved); each
 * node's id is its absolute path so a read/write can round-trip it directly.
 */
function walkAbs(
    dir: string,
    depth: number,
    maxDepth: number,
    budget: { remaining: number },
): Promise<TreeNodeData[]> {
    return walkBreadthFirst(
        dir,
        dir.replace(/\\/g, '/'),
        depth,
        maxDepth,
        budget,
        (_parentId, _name, abs) => abs.replace(/\\/g, '/'),
    );
}

/** Existing drive roots on Windows (A:..Z: that respond to access). */
async function listWindowsDrives(): Promise<string[]> {
    const out: string[] = [];
    for (let c = 65 /* A */; c <= 90 /* Z */; c++) {
        const letter = String.fromCharCode(c);
        try {
            await fsp.access(`${letter}:\\`);
            out.push(`${letter}:`);
        } catch {
            /* no such drive */
        }
    }
    return out;
}

/**
 * The System-workspace full-filesystem tree (desktop only). With no `root`, the
 * top level is the machine's filesystem root(s): drive letters on Windows, `/`
 * on POSIX. With `root` (an absolute path the UI drilled into) it walks there.
 */
async function listSystemTree(
    opts: ListTreeOpts,
    maxDepth: number,
    budget: { remaining: number },
): Promise<TreeNodeData[]> {
    const sub = (opts.root ?? '').trim();
    if (sub) {
        return walkAbs(path.resolve(sub), 0, maxDepth, budget);
    }
    if (process.platform === 'win32') {
        const drives = await listWindowsDrives();
        const out: TreeNodeData[] = [];
        for (const d of drives) {
            if (budget.remaining <= 0) break;
            budget.remaining--;
            const children = await walkAbs(`${d}\\`, 1, maxDepth, budget);
            // Drive node id ends with '/' so joinRel/reads resolve under it.
            out.push({ id: `${d}/`, label: d, type: 'folder', children });
        }
        return out;
    }
    return walkAbs('/', 0, maxDepth, budget);
}

export async function listTree(
    workspacePath: string,
    opts: ListTreeOpts = {},
): Promise<TreeNodeData[]> {
    const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const budget = { remaining: maxEntries };

    // System workspace, desktop only: browse the WHOLE machine (drive roots / /)
    // with absolute node ids. Fail-closed — headless never reaches this.
    if (fullFsAllowed(opts.system)) {
        return listSystemTree(opts, maxDepth, budget);
    }

    // A locked code view roots the walk at a workspace-relative subfolder.
    // Guard-resolve it against the workspace so it can't escape; the id
    // prefix keeps node ids relative to the WORKSPACE root, so file
    // reads/writes still path-guard against the workspace, not the subroot.
    // An ABSOLUTE root is never a confined subfolder — the Code view's
    // normaliseRoot only ever produces a bare workspace-RELATIVE path. Reject it
    // consistently on EVERY platform: a POSIX absolute (`/x`) AND a Windows
    // drive/UNC absolute (`C:\x`, `\\srv`) both escape confinement. Do this BEFORE
    // the leading-slash strip below — without it, `.replace(/^\/+/…)` turns a POSIX
    // absolute into a relative subpath, silently confining it to a nonexistent
    // subdir (→ []) on Linux while Windows correctly threw (guardedResolve). That
    // cross-platform inconsistency is the failing CI test (system-fs :115).
    const raw = (opts.root ?? '').replace(/\\/g, '/');
    if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
        throw new ClientError('Path escapes workspace');
    }
    const sub = raw.replace(/^\/+|\/+$/g, '');
    if (sub) {
        const start = guardedResolve(workspacePath, sub);
        if (!start) throw new ClientError('Path escapes workspace');
        return walk(start, sub, 0, maxDepth, budget);
    }

    const root = path.resolve(workspacePath);
    return walk(root, '', 0, maxDepth, budget);
}

export async function readFile(
    workspacePath: string,
    relPath: string,
    system?: boolean,
): Promise<{ content: string; truncated: boolean }> {
    const abs = resolvePath(workspacePath, relPath, system);
    if (!abs) throw new ClientError('Path escapes workspace');
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
    system?: boolean,
): Promise<{ ok: boolean }> {
    const abs = resolvePath(workspacePath, relPath, system);
    if (!abs) throw new ClientError('Path escapes workspace');
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

// --- Capability-scoped plugin file I/O (Plugin System, §6.2 / §12.4) ---------
//
// A GRANTED plugin tool (running in the sandboxed worker) reaches the filesystem
// ONLY through these helpers, brokered by the worker-host capability bridge.
// They are STRICTLY TIGHTER than the general `files:*` surface:
//   - always workspace-CONFINED via `guardedResolve` (never the System full-FS
//     bypass — a plugin is not the trusted System workspace),
//   - limited to the plugin's DECLARED, user-GRANTED extension allow-list, and
//   - size-capped.
// They are NOT exposed on `window.genie.files`; only the plugin bridge calls
// them, after the grant/scope gate in `plugins/fs-bridge.ts`. Any escape,
// disallowed extension, empty allow-list, or oversize buffer throws — fail-closed.

/** Ceiling for capability-scoped plugin binary I/O (a .pptx/.xlsx can be a few MB). */
export const MAX_PLUGIN_BINARY_BYTES = 25 * 1024 * 1024;

/** Lowercased, dot-prefixed extension of a path (e.g. '.pptx'), or '' when none. */
function extLower(p: string): string {
    return path.extname(p).toLowerCase();
}

/** Normalise an extension allow-list to lowercased, dot-prefixed, de-duped entries. */
function normaliseExts(exts: string[]): string[] {
    const out = new Set<string>();
    for (const e of exts) {
        const s = String(e).trim().toLowerCase();
        if (!s) continue;
        out.add(s.startsWith('.') ? s : `.${s}`);
    }
    return [...out];
}

/**
 * Guard-resolve `relPath` for a plugin under `workspaceRoot` AND enforce the
 * declared/granted extension allow-list. Returns the absolute path or throws:
 *   - escapes the workspace (`..`, absolute, other drive) → 'Path escapes workspace'
 *   - resolves to the workspace root itself → 'Invalid path'
 *   - the allow-list is empty → 'No file extensions are granted…' (fail-closed)
 *   - the extension isn't in the allow-list → 'Extension … is not granted…'
 * This is the single guard both the binary and text plugin helpers share.
 */
export function resolvePluginPath(
    workspaceRoot: string,
    relPath: string,
    allowedExts: string[],
): string {
    const abs = guardedResolve(workspaceRoot, relPath);
    if (!abs) throw new ClientError('Path escapes workspace');
    if (abs === path.resolve(workspaceRoot)) throw new Error('Invalid path');
    const allow = normaliseExts(allowedExts);
    if (allow.length === 0) {
        throw new Error('No file extensions are granted to this plugin');
    }
    const ext = extLower(abs);
    if (!allow.includes(ext)) {
        throw new Error(
            `Extension "${ext || '(none)'}" is not in this plugin's granted list (${allow.join(', ')})`,
        );
    }
    return abs;
}

/** Workspace-relative, forward-slashed path for a resolved absolute path. */
function relOf(workspaceRoot: string, abs: string): string {
    return path.relative(path.resolve(workspaceRoot), abs).replace(/\\/g, '/');
}

/**
 * Write raw BYTES for a granted plugin — guard-resolved + extension-limited +
 * size-capped. The generation tools produce in-memory bytes (dark-slide /
 * holy-sheet `Agent.toBytes` → Uint8Array) and this is the ONLY path those bytes
 * reach disk, so a `.pptx`/`.xlsx` can only ever land inside the granting
 * workspace under a granted extension.
 */
export async function writePluginBinary(
    workspaceRoot: string,
    relPath: string,
    bytes: Buffer,
    allowedExts: string[],
): Promise<{ ok: true; relPath: string; bytes: number }> {
    const abs = resolvePluginPath(workspaceRoot, relPath, allowedExts);
    if (bytes.length > MAX_PLUGIN_BINARY_BYTES) throw new Error('Content exceeds size limit');
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, bytes);
    return { ok: true, relPath: relOf(workspaceRoot, abs), bytes: bytes.length };
}

/** Read raw BYTES (base64) for a granted plugin — same guard + ext + size cap. */
export async function readPluginBinary(
    workspaceRoot: string,
    relPath: string,
    allowedExts: string[],
): Promise<{ base64: string; bytes: number; relPath: string }> {
    const abs = resolvePluginPath(workspaceRoot, relPath, allowedExts);
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) throw new Error('Not a file');
    if (stat.size > MAX_PLUGIN_BINARY_BYTES) throw new Error('File exceeds size limit');
    const buf = await fsp.readFile(abs);
    return { base64: buf.toString('base64'), bytes: buf.length, relPath: relOf(workspaceRoot, abs) };
}

/** Write UTF-8 TEXT for a granted plugin — same guard + ext + size cap (no NUL). */
export async function writePluginText(
    workspaceRoot: string,
    relPath: string,
    content: string,
    allowedExts: string[],
): Promise<{ ok: true; relPath: string; bytes: number }> {
    const abs = resolvePluginPath(workspaceRoot, relPath, allowedExts);
    if (content.indexOf(NUL) !== -1) throw new Error('Refusing to write binary content');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_PLUGIN_BINARY_BYTES) throw new Error('Content exceeds size limit');
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
    return { ok: true, relPath: relOf(workspaceRoot, abs), bytes };
}

/** Read UTF-8 TEXT for a granted plugin — same guard + ext + size cap. */
export async function readPluginText(
    workspaceRoot: string,
    relPath: string,
    allowedExts: string[],
): Promise<{ content: string; truncated: boolean; relPath: string }> {
    const abs = resolvePluginPath(workspaceRoot, relPath, allowedExts);
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) throw new Error('Not a file');
    const buf = await fsp.readFile(abs);
    if (looksBinary(buf)) throw new Error('Binary file');
    const truncated = buf.length > MAX_PLUGIN_BINARY_BYTES;
    const slice = truncated ? buf.subarray(0, MAX_PLUGIN_BINARY_BYTES) : buf;
    return { content: slice.toString('utf8'), truncated, relPath: relOf(workspaceRoot, abs) };
}

/**
 * Create an empty file at `relPath` under the workspace root. Fails if the
 * target already exists (so a "New file" never silently overwrites). The
 * parent directory is created as needed. Path-guarded like read/write.
 */
export async function createFile(
    workspacePath: string,
    relPath: string,
    system?: boolean,
): Promise<{ ok: boolean }> {
    const abs = resolvePath(workspacePath, relPath, system);
    if (!abs) throw new ClientError('Path escapes workspace');
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
    system?: boolean,
): Promise<{ ok: boolean }> {
    const abs = resolvePath(workspacePath, relPath, system);
    if (!abs) throw new ClientError('Path escapes workspace');
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
    system?: boolean,
): Promise<{ ok: boolean }> {
    const from = resolvePath(workspacePath, fromRel, system);
    const to = resolvePath(workspacePath, toRel, system);
    if (!from || !to) throw new ClientError('Path escapes workspace');
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
    system?: boolean,
): Promise<{ ok: boolean; relPath: string }> {
    const from = resolvePath(workspacePath, relPath, system);
    if (!from) throw new ClientError('Path escapes workspace');
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
        // already is, so a sibling is too, but guard anyway). System full-FS
        // duplicates alongside the source (same dir), so the sibling resolves.
        const toRel = relDir ? `${relDir}/${candidate}` : candidate;
        if (!resolvePath(workspacePath, toRel, system)) continue;
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

/** Ceiling for an external-file import shipped over a remote link (client reads
 *  its own local file to POST the bytes to the host). Matches the mobile server's
 *  MAX_UPLOAD_BYTES so a file the host will accept is exactly one the client will
 *  read. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

/**
 * Resolve the DESTINATION for an external import — `<destFolder>/<leaf>`,
 * guard-resolved against the workspace root, with the no-clobber `-copy` fallback.
 * Shared by the src-path importer ({@link importExternalPath}) and the bytes
 * importer ({@link importExternalBytes}); the guard here is the single point that
 * keeps an outside drop from ever writing outside the workspace.
 */
async function resolveImportDest(
    workspacePath: string,
    leaf: string,
    destFolderRel: string,
    system?: boolean,
): Promise<{ finalAbs: string; finalRel: string }> {
    if (!leaf) throw new Error('Invalid source path');
    const dir = (destFolderRel ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    const baseRel = dir ? `${dir}/${leaf}` : leaf;
    const baseAbs = resolvePath(workspacePath, baseRel, system);
    if (!baseAbs) throw new ClientError('Destination escapes workspace');

    // No-clobber: pick the first free `-copy` name in the destination folder.
    let finalRel = baseRel;
    let finalAbs = baseAbs;
    const exists = await fsp.access(baseAbs).then(() => true).catch(() => false);
    if (exists) {
        finalRel = '';
        for (let n = 1; n <= 1000; n++) {
            const candRel = dir ? `${dir}/${copyName(leaf, n)}` : copyName(leaf, n);
            const candAbs = resolvePath(workspacePath, candRel, system);
            if (!candAbs) continue;
            const taken = await fsp.access(candAbs).then(() => true).catch(() => false);
            if (taken) continue;
            finalRel = candRel;
            finalAbs = candAbs;
            break;
        }
        if (!finalRel) throw new Error('Too many copies — clear some out first.');
    }
    return { finalAbs, finalRel };
}

/**
 * Copy an EXTERNAL file/folder (an arbitrary OS path, e.g. dragged in from
 * Windows Explorer / Finder) INTO a workspace folder. The SOURCE is an arbitrary
 * disk path (must exist); the DESTINATION is guard-resolved against the workspace
 * root, so a drop from outside can never write outside the workspace. On a name
 * collision a `-copy` sibling is chosen rather than clobbering. Returns the new
 * workspace-relative path. (Internal moves use renamePath — copy is for external
 * sources only.) LOCAL drops only — the host reads a client's disk path it can't
 * see, so a remote window uses {@link importExternalBytes} instead.
 */
export async function importExternalPath(
    workspacePath: string,
    srcAbs: string,
    destFolderRel: string,
    system?: boolean,
): Promise<{ ok: boolean; relPath: string }> {
    if (!srcAbs) throw new Error('No source path');
    const stat = await fsp.stat(srcAbs); // throws if the source is gone
    const leaf = path.basename(srcAbs);
    const { finalAbs, finalRel } = await resolveImportDest(
        workspacePath,
        leaf,
        destFolderRel,
        system,
    );

    await fsp.mkdir(path.dirname(finalAbs), { recursive: true });
    if (stat.isDirectory()) {
        await fsp.cp(srcAbs, finalAbs, { recursive: true });
    } else {
        await fsp.copyFile(srcAbs, finalAbs);
    }
    return { ok: true, relPath: finalRel };
}

/**
 * Copy an external file into a workspace folder from raw BYTES. Used by a remote
 * (Work-Mode host) window: the FILE lives on the CLIENT's disk (the host can't
 * read it), so the client reads its own dropped file and ships the bytes to the
 * host, which writes them here. Destination is guard-resolved against the
 * workspace root and no-clobbers to a `-copy` sibling — the same path-guard +
 * no-clobber behaviour as a LOCAL drop. `filename` is reduced to its basename so a
 * `../evil` leaf can't escape. Files only: a folder can't be a single buffer, so
 * remote folder imports fall back to per-file drops on the client.
 */
export async function importExternalBytes(
    workspacePath: string,
    filename: string,
    bytes: Buffer,
    destFolderRel: string,
    system?: boolean,
): Promise<{ ok: boolean; relPath: string }> {
    const leaf = path.basename(filename ?? '');
    const { finalAbs, finalRel } = await resolveImportDest(
        workspacePath,
        leaf,
        destFolderRel,
        system,
    );
    await fsp.mkdir(path.dirname(finalAbs), { recursive: true });
    await fsp.writeFile(finalAbs, bytes);
    return { ok: true, relPath: finalRel };
}

/**
 * Read an arbitrary LOCAL absolute file as raw bytes (base64) — the CLIENT half of
 * a remote external-file drop. A host window has no access to the client's disk, so
 * the client reads its own just-dropped file here and ships the bytes to the host's
 * `/api/files/import-external`. This is a LOCAL read of a user-chosen path (a
 * drag-drop the user just performed on THIS machine), never a workspace-confined op,
 * so it takes no workspace root. Files only; capped at {@link MAX_IMPORT_BYTES}.
 */
export async function readExternalBytes(
    absPath: string,
): Promise<{ name: string; base64: string }> {
    if (!absPath) throw new Error('No source path');
    const stat = await fsp.stat(absPath); // throws if the source is gone
    if (stat.isDirectory()) {
        throw new Error('Folder drops are not supported over a remote link');
    }
    if (stat.size > MAX_IMPORT_BYTES) {
        throw new Error('File too large to copy over a remote link');
    }
    const buf = await fsp.readFile(absPath);
    return { name: path.basename(absPath), base64: buf.toString('base64') };
}

/**
 * Delete the node at `relPath`. Recursive for folders. Path-guarded; the
 * workspace root itself can never be deleted.
 */
export async function deletePath(
    workspacePath: string,
    relPath: string,
    system?: boolean,
): Promise<{ ok: boolean }> {
    const abs = resolvePath(workspacePath, relPath, system);
    if (!abs) throw new ClientError('Path escapes workspace');
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
    ipcMain.handle(
        'files:read',
        (_e, workspacePath: string, relPath: string, system?: boolean) =>
            readFile(workspacePath, relPath, system),
    );
    ipcMain.handle(
        'files:write',
        (_e, workspacePath: string, relPath: string, content: string, system?: boolean) =>
            writeFile(workspacePath, relPath, content, system),
    );
    ipcMain.handle(
        'files:create-file',
        (_e, workspacePath: string, relPath: string, system?: boolean) =>
            createFile(workspacePath, relPath, system),
    );
    ipcMain.handle(
        'files:create-folder',
        (_e, workspacePath: string, relPath: string, system?: boolean) =>
            createFolder(workspacePath, relPath, system),
    );
    ipcMain.handle(
        'files:rename',
        (_e, workspacePath: string, fromRel: string, toRel: string, system?: boolean) =>
            renamePath(workspacePath, fromRel, toRel, system),
    );
    ipcMain.handle(
        'files:duplicate',
        (_e, workspacePath: string, relPath: string, system?: boolean) =>
            duplicatePath(workspacePath, relPath, system),
    );
    // Copy an external OS path (Explorer/Finder drag) into a workspace folder.
    ipcMain.handle(
        'files:import-external',
        (_e, workspacePath: string, srcAbs: string, destFolderRel: string, system?: boolean) =>
            importExternalPath(workspacePath, srcAbs, destFolderRel ?? '', system),
    );
    // Read a LOCAL absolute file's bytes (base64) — the client half of a remote
    // external-file drop (the bytes are POSTed to the host to write into a folder).
    ipcMain.handle('files:read-external-bytes', (_e, absPath: string) =>
        readExternalBytes(String(absPath ?? '')),
    );
    ipcMain.handle(
        'files:delete',
        (_e, workspacePath: string, relPath: string, system?: boolean) =>
            deletePath(workspacePath, relPath, system),
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
