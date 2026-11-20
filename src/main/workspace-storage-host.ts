import { randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveProgram } from '../core/program-lookup.js';
import {
    ARTIFACT_WALK_SKIP, DIRTY_REL, STORAGE_CATEGORIES, approvalMatches, isArtifactPath, originLabel, suggestedCleanup, mergedIntoLine, parseWorktreeList, worktreeRefusal, worktreeState, WORKTREE_STATE_LABEL,
    type StorageCategory, type StorageItem, type StorageReport, type TrashApproval, type TrashEntry, type TrashOrigin, type WorktreeState,
} from '../core/workspace-storage.js';
import { sizeOf as defaultSizeOf, type DirSize } from './dir-size.js';
import { gitExecFile } from './git-exec.js';
import { GitDidNotAnswer, withinGitLimit } from './git-ports.js';
import { GIT_NEEDS_TRUST, gitMayRun } from './git-read-policy.js';
import { restoreArtboardPayload } from './artboard-trash.js';
import { TRASH_ID, TRASH_PAYLOAD, TRASH_RECORD, trashFolder } from './trash-entry.js';

/**
 * A WORKSPACE'S STORAGE, ON THE HOST (Tynn #697): measure it by category, move reclaimable clutter into the workspace's
 * `.trash` with each item's origin recorded, put it back, and empty `.trash` only with the person's approval.
 *
 * THE RULES THIS FILE KEEPS:
 *  - It never leaves the workspace, with one exception that is only READ: git lists a repo's own registered worktrees,
 *    some of which agents made elsewhere (C:/_Projects/_wt/...), and those are shown and may be moved into .trash by git.
 *    Every other path is resolved under the workspace's real path; an id with `..`, a `.trash` that is a link, a worktree
 *    that is itself a link, are refused. Measuring never follows a link (main/dir-size.ts).
 *  - `.ai/_dirty` (Tynn #819) is used only when `.ai` and `.ai/_dirty` are real folders of the workspace; an entry in it
 *    that is a link is not listed. A Restore never goes through a link on its way back: its folder must still be the
 *    workspace's own.
 *  - The window sends ids, never paths, and every id is re-validated against a fresh reading before anything moves.
 *  - A worktree goes to .trash only when git says it is safe: not the main checkout, not locked, no uncommitted changes,
 *    no commit that no remote has. It is moved BY GIT (`git worktree move`) and locked there, so git still knows it and
 *    Restore is `git worktree move` back.
 *  - Nothing outside `.trash` is ever deleted. Empty trash deletes `.trash`'s entries, only with an approval naming exactly
 *    what is there now and its total, and removes a trashed worktree through git first.
 */

/** A file shared in chat that the host keeps for an agent of this workspace (core/thread-store.ts attachments). */
export interface ChatFile {
    readonly agentId: string;
    readonly agentName: string;
    readonly attachmentId: string;
    /** Where the thread store keeps it (outside the workspace). */
    readonly path: string;
    readonly bytes: number;
}

export type StorageResult<T extends object = object> = ({ ok: true } & T) | { ok: false; reason: string };

export interface StoragePorts {
    readonly now?: () => number;
    readonly sizeOf?: (path: string) => Promise<DirSize>;
    /** Deletes one .trash entry for good (tests: a failure on one entry). */
    readonly remove?: (path: string) => Promise<void>;
}

/** How far a Move or Empty is, after each item (Tynn #947). */
export interface StorageProgressEvent {
    readonly done: number;
    readonly total: number;
    readonly bytes: number;
    readonly current: string | null;
}

/** An item a Move or Empty did not move or delete, and why, in words. */
export interface StorageProblem {
    readonly id: string;
    readonly label: string;
    readonly reason: string;
}

export interface CleanUpResult {
    readonly moved: string[];
    readonly skipped: string[];
    readonly failed: string[];
    /** Each skipped or failed item, with the reason. */
    readonly problems: StorageProblem[];
    /** The bytes of what was moved. */
    readonly bytes: number;
}

export type EmptyTrashResult = StorageResult<{ deleted: number; bytes: number; failed: StorageProblem[] }>;

const RECORD = TRASH_RECORD;
const PAYLOAD = TRASH_PAYLOAD;
/** How deep, and how many folders, the artifact search looks at. */
const ARTIFACT_DEPTH = 6;
const ARTIFACT_DIRS = 20_000;
const WALKS_AT_ONCE = 4;

const toSlash = (p: string): string => p.split(sep).join('/');

async function git(cwd: string, args: readonly string[]): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
    if (!(await gitMayRun(cwd))) return { ok: false, error: GIT_NEEDS_TRUST };
    try {
        return await withinGitLimit((limit) => new Promise((done) => {
            const options = { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
            const answered = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer): void => {
                if (error) done({ ok: false, error: String(stderr ?? '').trim() || error.message });
                else done({ ok: true, out: String(stdout) });
            };
            if (limit) limit.git(args, options, answered);
            else gitExecFile(resolveProgram('git'), [...args], { ...options, windowsHide: true }, answered);
        }));
    } catch (error) {
        if (error instanceof GitDidNotAnswer) return { ok: false, error: error.message };
        throw error;
    }
}

/**
 * WHEN A FAILED GIT CALL IS WORTH ANOTHER TRY: Windows refuses to rename a folder for a moment while a scanner, the indexer or
 * a process that just exited still holds a handle inside it (git's own words: "Permission denied", "Access is denied", "being
 * used by another process"). The same call a moment later succeeds. Anything else (a locked worktree, a missing path) is final.
 */
export const TRANSIENT_GIT_FAILURE = /permission denied|access is denied|being used by another process|resource busy|device or resource busy|unable to rename|EBUSY|EPERM|EACCES/i;
const TRY_AGAIN_MS = 250;

/** Run `call` until it succeeds, fails for a reason that is not transient, or `attempts` are spent; waits longer each time. */
export async function retryTransient<R extends { ok: boolean; error?: string }>(call: () => Promise<R>, attempts = 8, wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))): Promise<R> {
    let last = await call();
    for (let n = 1; n < attempts && !last.ok && TRANSIENT_GIT_FAILURE.test(last.error ?? ''); n += 1) {
        await wait(TRY_AGAIN_MS * n);
        last = await call();
    }
    return last;
}

const isDir = async (p: string): Promise<boolean> => { try { const s = await lstat(p); return s.isDirectory(); } catch { return false; } };
const exists = async (p: string): Promise<boolean> => { try { await lstat(p); return true; } catch { return false; } };

/** Workspace-relative, `/`-separated, or `null` when `abs` is not strictly inside `root`. */
function inside(rootReal: string, abs: string): string | null {
    const rel = relative(rootReal, abs);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
    return toSlash(rel);
}

/** Move a file or folder, across volumes too (a chat file lives under ~/.genie, the workspace may be elsewhere). */
async function move(from: string, to: string): Promise<void> {
    try {
        await rename(from, to);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        await copyFile(from, to);
        await unlink(from);
    }
}

/** A folder rename that Windows refuses for a moment while a handle inside it closes (see TRANSIENT_GIT_FAILURE): tried again. */
async function renameRetrying(from: string, to: string, attempts = 8): Promise<void> {
    for (let n = 1; ; n += 1) {
        try { await rename(from, to); return; } catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? '';
            if (n >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw error;
            await new Promise((done) => setTimeout(done, TRY_AGAIN_MS * n));
        }
    }
}

const words = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A worktree that is in .trash, where git still names it: its files must stay there, recorded, and the reason said. */
class MovedButStillListed extends Error {}

/** Two paths name the same place (git prints `/`, Windows is case-insensitive). */
function samePath(a: string, b: string): boolean {
    const norm = (p: string) => { const r = resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
    return norm(a) === norm(b);
}

/** At most `n` at once, in order. */
async function pooled<T, R>(list: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(list.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
        while (next < list.length) { const i = next; next += 1; out[i] = await fn(list[i]!); }
    }));
    return out;
}

/** A worktree git lists for one of the workspace's repositories, before its state is read. */
interface WorktreeListed { id: string; rel: string; abs: string; repoAbs: string; repoRel: string; branch: string | null; head: string | null; external: boolean; locked: boolean; /** The path as git lists it (it can differ from the real path, e.g. a short Windows name). */ listed: string }
interface WorktreeFound extends WorktreeListed { state: WorktreeState; refusal: string | null }

export class WorkspaceStorage {
    readonly #now: () => number;
    readonly #sizeOf: (path: string) => Promise<DirSize>;
    readonly #remove: (path: string) => Promise<void>;

    constructor(ports: StoragePorts = {}) {
        this.#now = ports.now ?? Date.now;
        this.#sizeOf = ports.sizeOf ?? ((p) => defaultSizeOf(p));
        this.#remove = ports.remove ?? ((p) => rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    }

    /** Every repository of the workspace: the workspace itself when it is one, and each `repos/<name>` that is. */
    async #repos(rootReal: string): Promise<Array<{ abs: string; rel: string }>> {
        const out: Array<{ abs: string; rel: string }> = [];
        if (await exists(join(rootReal, '.git'))) out.push({ abs: rootReal, rel: '.' });
        let names: string[] = [];
        try {
            names = (await readdir(join(rootReal, 'repos'), { withFileTypes: true })).filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name).sort();
        } catch { /* no repos/ */ }
        for (const n of names) {
            const abs = join(rootReal, 'repos', n);
            if (await exists(join(abs, '.git'))) out.push({ abs, rel: `repos/${n}` });
        }
        return out;
    }

    /**
     * Every worktree git lists for the workspace's repositories, inside the workspace or not (never a main checkout, never one
     * in .trash, never one that is itself a link), each with its state: dirty, unpushed, clean and merged, clean and unmerged.
     */
    async #worktrees(rootReal: string): Promise<WorktreeFound[]> {
        const out: WorktreeFound[] = [];
        for (const w of await this.#listWorktrees(rootReal)) out.push(await this.#checkWorktree(w));
        return out;
    }

    /** What git lists, one `git worktree list` per repository: no worktree's own git is asked yet (cheap, Tynn #947). */
    async #listWorktrees(rootReal: string): Promise<WorktreeListed[]> {
        const out: WorktreeListed[] = [];
        const trashReal = join(rootReal, '.trash');
        for (const repo of await this.#repos(rootReal)) {
            const listed = await git(repo.abs, ['worktree', 'list', '--porcelain']);
            if (!listed.ok) continue;
            const list = parseWorktreeList(listed.out);
            for (const w of list.slice(1)) {
                if (w.bare) continue;
                let real: string;
                try { if ((await lstat(w.path)).isSymbolicLink()) continue; real = await realpath(w.path); } catch { continue; }
                if (real === rootReal || inside(trashReal, real) !== null || real === trashReal) continue;
                const inRoot = inside(rootReal, real);
                const rel = inRoot ?? toSlash(real);
                out.push({ id: `worktrees:${rel}`, rel, abs: real, repoAbs: repo.abs, repoRel: repo.rel, branch: w.branch, head: w.head, external: inRoot === null, locked: w.locked, listed: w.path });
            }
        }
        return out.sort((a, b) => a.rel.localeCompare(b.rel));
    }

    /** One worktree's state, read now from its own git: dirty, unpushed, merged. */
    async #checkWorktree(w: WorktreeListed): Promise<WorktreeFound> {
        const status = await git(w.abs, ['status', '--porcelain']);
        const ahead = await git(w.abs, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
        const unpushed = ahead.ok && /^\d+\s*$/.test(ahead.out) ? Number(ahead.out.trim()) : null;
        const contains = await git(w.abs, ['for-each-ref', '--contains', 'HEAD', '--format=%(refname)', 'refs/remotes']);
        const dirty = !status.ok || status.out.trim() !== '';
        const merged = contains.ok && mergedIntoLine(contains.out.split(/\r?\n/).filter((l) => l !== ''));
        const refusal = !status.ok ? `Genie could not read its status: ${status.error}` : worktreeRefusal({ locked: w.locked, dirty, unpushed });
        return { ...w, state: worktreeState({ locked: w.locked, dirty, unpushed, merged }), refusal };
    }

    /** One worktree of the workspace by its id, checked now; `null` when git does not list it. */
    async #worktree(rootReal: string, itemId: string): Promise<WorktreeFound | null> {
        const w = (await this.#listWorktrees(rootReal)).find((x) => x.id === itemId);
        return w ? this.#checkWorktree(w) : null;
    }

    /** A CI/test artifact folder of the workspace by its relative path, as a fresh look finds it; `null` when it is not one. */
    async #artifactAt(rootReal: string, rest: string): Promise<string | null> {
        const segments = rest.split('/');
        if (rest === '' || isAbsolute(rest) || segments.some((s) => s === '' || s === '.' || s === '..' || ARTIFACT_WALK_SKIP.includes(s)) || !isArtifactPath(rest)) return null;
        if (rest === DIRTY_REL || rest.startsWith(`${DIRTY_REL}/`)) return null;
        const abs = join(rootReal, ...segments);
        try {
            const s = await lstat(abs);
            if (s.isSymbolicLink() || !s.isDirectory()) return null;
            if (inside(rootReal, await realpath(abs)) !== rest) return null;
        } catch { return null; }
        return abs;
    }

    /** CI/test artifact folders by name, bounded, never through a link, never inside node_modules, .git or .trash. */
    async #artifacts(rootReal: string): Promise<string[]> {
        const found: string[] = [];
        const queue: Array<{ dir: string; depth: number }> = [{ dir: rootReal, depth: 0 }];
        let seen = 0;
        while (queue.length > 0 && seen < ARTIFACT_DIRS) {
            const { dir, depth } = queue.shift()!;
            seen += 1;
            let list;
            try { list = await readdir(dir, { withFileTypes: true }); } catch { continue; }
            for (const e of list) {
                if (e.isSymbolicLink() || !e.isDirectory() || ARTIFACT_WALK_SKIP.includes(e.name)) continue;
                const full = join(dir, e.name);
                const rel = inside(rootReal, full);
                // .ai/_dirty's entries are the person's, measured as `dirty`: never counted twice.
                if (rel === DIRTY_REL) continue;
                if (rel !== null && isArtifactPath(rel)) { found.push(rel); continue; }
                if (depth + 1 < ARTIFACT_DEPTH) queue.push({ dir: full, depth: depth + 1 });
            }
        }
        return found.sort();
    }

    /** `.trash` as a folder; `null` when absent; refused when it is anything else (a link would leave the workspace). */
    #trashDir(rootReal: string, create: boolean): Promise<{ ok: true; dir: string | null } | { ok: false; reason: string }> {
        return trashFolder(rootReal, create);
    }

    /**
     * `.ai/_dirty` as the workspace's own folder, or `null`: absent, or `.ai` or `.ai/_dirty` a link or not a folder, or its
     * real path not where it should be. Never created here.
     */
    async #dirtyDir(rootReal: string): Promise<string | null> {
        const segments = DIRTY_REL.split('/');
        for (let i = 1; i <= segments.length; i += 1) {
            try {
                const s = await lstat(join(rootReal, ...segments.slice(0, i)));
                if (s.isSymbolicLink() || !s.isDirectory()) return null;
            } catch { return null; }
        }
        const dir = join(rootReal, ...segments);
        try { return inside(rootReal, await realpath(dir)) === DIRTY_REL ? dir : null; } catch { return null; }
    }

    /** The entries directly in `.ai/_dirty`: files and folders, never a link, never its `.gitkeep`; by name. */
    async #dirtyEntries(rootReal: string): Promise<Array<{ name: string; abs: string }>> {
        const dir = await this.#dirtyDir(rootReal);
        if (dir === null) return [];
        let list;
        try { list = await readdir(dir, { withFileTypes: true }); } catch { return []; }
        return list
            .filter((e) => e.name !== '.gitkeep' && !e.isSymbolicLink() && (e.isFile() || e.isDirectory()))
            .map((e) => ({ name: e.name, abs: join(dir, e.name) }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /** What .trash holds: Genie's entries with their origin, and anything else by its name. */
    async listTrash(root: string): Promise<TrashEntry[]> {
        const rootReal = await realpath(root);
        const t = await this.#trashDir(rootReal, false);
        if (!t.ok || t.dir === null) return [];
        const dir = t.dir;
        const names = (await readdir(dir)).sort();
        return pooled(names, WALKS_AT_ONCE, async (name): Promise<TrashEntry> => {
            const full = join(dir, name);
            const record = TRASH_ID.test(name) ? await readRecord(full) : null;
            if (record) return { id: name, origin: record.origin, movedAt: record.movedAt, bytes: (await this.#sizeOf(join(full, PAYLOAD))).bytes };
            return { id: name, origin: { kind: 'unknown', name }, movedAt: null, bytes: (await this.#sizeOf(full)).bytes };
        });
    }

    /** The workspace's disk, by category, with what may be reclaimed and why not. */
    async measure(root: string, input: { chatFiles: readonly ChatFile[] }): Promise<StorageReport> {
        const rootReal = await realpath(root);
        const [repos, worktrees, artifacts, dirty, trash] = await Promise.all([this.#repos(rootReal), this.#worktrees(rootReal), this.#artifacts(rootReal), this.#dirtyEntries(rootReal), this.listTrash(rootReal)]);
        let truncated = false;
        const sized = async (abs: string) => { const s = await this.#sizeOf(abs); if (s.truncated) truncated = true; return s; };
        const items: StorageItem[] = [];
        const repoItems = await pooled(repos.filter((r) => r.rel !== '.'), WALKS_AT_ONCE, async (r) => {
            const s = await sized(r.abs);
            return { id: `repos:${r.rel}`, category: 'repos' as const, label: r.rel, rel: r.rel, bytes: s.bytes, files: s.files, truncated: s.truncated, newest: s.newest, reclaimable: false, refusal: null };
        });
        items.push(...repoItems);
        items.push(...await pooled(worktrees, WALKS_AT_ONCE, async (w) => {
            const s = await sized(w.abs);
            return { id: w.id, category: 'worktrees' as const, label: w.branch ? `${w.rel} (${w.branch})` : w.rel, rel: w.rel, bytes: s.bytes, files: s.files, truncated: s.truncated, newest: s.newest, reclaimable: w.refusal === null, refusal: w.refusal, state: w.state, external: w.external };
        }));
        items.push(...await pooled(artifacts, WALKS_AT_ONCE, async (rel) => {
            const s = await sized(join(rootReal, ...rel.split('/')));
            return { id: `ci-artifacts:${rel}`, category: 'ci-artifacts' as const, label: rel, rel, bytes: s.bytes, files: s.files, truncated: s.truncated, newest: s.newest, reclaimable: true, refusal: null };
        }));
        for (const c of input.chatFiles) {
            const file = basename(c.path);
            items.push({ id: `chat-files:${c.agentId}/${c.attachmentId}`, category: 'chat-files', label: `${c.agentName}: ${c.attachmentId} (${file})`, rel: `${c.agentId}/${file}`, bytes: c.bytes, files: 1, truncated: false, reclaimable: true, refusal: null });
        }
        items.push(...await pooled(dirty, WALKS_AT_ONCE, async (d) => {
            const s = await sized(d.abs);
            const rel = `${DIRTY_REL}/${d.name}`;
            return { id: `dirty:${d.name}`, category: 'dirty' as const, label: rel, rel, bytes: s.bytes, files: s.files, truncated: s.truncated, newest: s.newest, reclaimable: true, refusal: null };
        }));
        const totals = Object.fromEntries(STORAGE_CATEGORIES.map((k) => [k, 0])) as Record<StorageCategory, number>;
        for (const i of items) totals[i.category] += i.bytes;
        totals.trash = trash.reduce((n, t) => n + t.bytes, 0);
        const reclaimableBytes = items.filter((i) => i.reclaimable).reduce((n, i) => n + i.bytes, 0);
        return { measuredAt: this.#now(), totals, reclaimableBytes, items, trash, truncated };
    }

    /** Move one item to the workspace's .trash, re-validated now; its origin recorded beside it. */
    async moveToTrash(root: string, itemId: string, input: { chatFiles: readonly ChatFile[] }): Promise<StorageResult<{ trashId: string; label: string }>> {
        const rootReal = await realpath(root);
        const colon = itemId.indexOf(':');
        const category = colon > 0 ? itemId.slice(0, colon) : '';
        const rest = colon > 0 ? itemId.slice(colon + 1) : '';
        type Plan = { origin: TrashOrigin; label: string; run: (payload: string) => Promise<void> };
        let plan: Plan;
        if (category === 'repos') return { ok: false, reason: 'A repository cannot be moved to .trash.' };
        if (category === 'ci-artifacts') {
            const abs = await this.#artifactAt(rootReal, rest);
            if (abs === null) return { ok: false, reason: 'That is not a CI or test artifact Genie found in this workspace.' };
            plan = { origin: { kind: 'path', category: 'ci-artifacts', rel: rest }, label: rest, run: (payload) => renameRetrying(abs, payload) };
        } else if (category === 'worktrees') {
            // Only this one worktree's git is asked (Tynn #947: re-checking every worktree for every item made 641 items take hours).
            const w = await this.#worktree(rootReal, itemId);
            if (!w) return { ok: false, reason: 'That is not a worktree Genie may move: only one registered with a repository of this workspace, other than its main checkout.' };
            if (w.refusal) return { ok: false, reason: w.refusal };
            plan = {
                // PRUNED (Tynn #947): the folder goes into .trash and git forgets it, so `git worktree list` names nothing in
                // .trash. Nothing is lost by that: it is clean and every commit is on a remote (the refusal above), and
                // Restore registers it again with its own files.
                origin: { kind: 'worktree', repoRel: w.repoRel, rel: w.rel, branch: w.branch, head: w.head, external: w.external, pruned: true },
                label: w.rel,
                run: async (payload) => {
                    try { await renameRetrying(w.abs, payload); } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'EXDEV') throw new Error('It is on another drive than this workspace: Genie does not copy a worktree across drives.');
                        throw new Error(`It could not be moved: ${words(error)}`);
                    }
                    const pruned = await retryTransient(() => git(w.repoAbs, ['worktree', 'prune']));
                    if (!pruned.ok) throw new MovedButStillListed(`It is in .trash, but git did not forget it: ${pruned.error}`);
                    const still = await git(w.repoAbs, ['worktree', 'list', '--porcelain']);
                    if (still.ok && parseWorktreeList(still.out).some((x) => samePath(x.path, w.abs) || samePath(x.path, w.listed))) throw new MovedButStillListed('It is in .trash, but git still lists it where it was.');
                },
            };
        } else if (category === 'dirty') {
            // One name directly in .ai/_dirty, as a fresh listing has it now: never a path, a link, `..` or its .gitkeep.
            const d = (await this.#dirtyEntries(rootReal)).find((e) => e.name === rest);
            if (!d) return { ok: false, reason: 'That is not a file or folder in this workspace’s .ai/_dirty.' };
            const rel = `${DIRTY_REL}/${d.name}`;
            plan = { origin: { kind: 'path', category: 'dirty', rel }, label: rel, run: (payload) => rename(d.abs, payload) };
        } else if (category === 'chat-files') {
            const c = input.chatFiles.find((f) => `${f.agentId}/${f.attachmentId}` === rest);
            if (!c) return { ok: false, reason: 'That is not a file shared in this workspace’s chat.' };
            plan = { origin: { kind: 'chat-file', agentId: c.agentId, attachmentId: c.attachmentId, path: c.path }, label: `${c.agentName}: ${c.attachmentId}`, run: (payload) => move(c.path, payload) };
        } else {
            return { ok: false, reason: 'Genie does not know that item.' };
        }
        const t = await this.#trashDir(rootReal, true);
        if (!t.ok) return t;
        const trashId = `genie-${this.#now()}-${randomBytes(3).toString('hex')}`;
        const entry = join(t.dir!, trashId);
        await mkdir(entry);
        const record = (): Promise<void> => writeFile(join(entry, RECORD), JSON.stringify({ version: 1, movedAt: this.#now(), origin: plan.origin }), 'utf8');
        try {
            await plan.run(join(entry, PAYLOAD));
        } catch (error) {
            // Moved, and only git's bookkeeping failed: the files are in .trash and must stay there, recorded, never deleted here.
            if (error instanceof MovedButStillListed) { await record(); return { ok: false, reason: error.message }; }
            await rm(entry, { recursive: true, force: true }).catch(() => undefined);
            return { ok: false, reason: words(error) };
        }
        await record();
        return { ok: true, trashId, label: plan.label };
    }

    /**
     * THE ONE-CLICK CLEAN-UP: move several items, but only those still suggested NOW (a merged, quiet worktree; a test result
     * older than a day). The window's list is a request, never the authority: an id that is not suggested now (dirty since,
     * newer, unmerged, a chat file) is skipped, and the reason is said.
     *
     * Tynn #947: it re-checks ONLY the items asked for (each one's size and, for a worktree, its own git), never the whole
     * workspace: a full measure per click, then a check of every worktree for every item, made the owner's 641 items take
     * hours. `onProgress` is told after each item.
     */
    async cleanUp(root: string, itemIds: readonly string[], input: { chatFiles: readonly ChatFile[] }, onProgress?: (e: StorageProgressEvent) => void): Promise<CleanUpResult> {
        const rootReal = await realpath(root);
        const ids = [...new Set(itemIds)];
        const out: CleanUpResult = { moved: [], skipped: [], failed: [], problems: [], bytes: 0 };
        let bytes = 0;
        // One at a time: two moves in one repository would race for git's lock.
        for (const [n, id] of ids.entries()) {
            const fresh = await this.#suggestedNow(rootReal, id);
            if (!fresh.ok) {
                out.skipped.push(id);
                out.problems.push({ id, label: fresh.label, reason: fresh.reason });
            } else {
                const r = await this.moveToTrash(root, id, input);
                if (r.ok) { out.moved.push(id); bytes += fresh.bytes; } else { out.failed.push(id); out.problems.push({ id, label: fresh.label, reason: r.reason }); }
            }
            onProgress?.({ done: n + 1, total: ids.length, bytes, current: fresh.label });
        }
        return { ...out, bytes };
    }

    /** Whether one item is suggested for the one-click clean-up now, read fresh; the reason in words when not. */
    async #suggestedNow(rootReal: string, id: string): Promise<{ ok: true; label: string; bytes: number } | { ok: false; label: string; reason: string }> {
        const colon = id.indexOf(':');
        const category = colon > 0 ? id.slice(0, colon) : '';
        const rest = colon > 0 ? id.slice(colon + 1) : id;
        const now = this.#now();
        let item: StorageItem;
        if (category === 'worktrees') {
            const w = await this.#worktree(rootReal, id);
            if (!w) return { ok: false, label: rest, reason: 'Git no longer lists it as a worktree of this workspace.' };
            const s = await this.#sizeOf(w.abs);
            item = { id, category: 'worktrees', label: w.rel, rel: w.rel, bytes: s.bytes, files: s.files, truncated: s.truncated, newest: s.newest, reclaimable: w.refusal === null, refusal: w.refusal, state: w.state, external: w.external };
        } else if (category === 'ci-artifacts') {
            const abs = await this.#artifactAt(rootReal, rest);
            if (abs === null) return { ok: false, label: rest, reason: 'It is no longer a CI or test result folder in this workspace.' };
            const s = await this.#sizeOf(abs);
            item = { id, category: 'ci-artifacts', label: rest, rel: rest, bytes: s.bytes, files: s.files, truncated: s.truncated, newest: s.newest, reclaimable: true, refusal: null };
        } else if (STORAGE_CATEGORIES.includes(category as StorageCategory)) {
            return { ok: false, label: rest, reason: 'The one-click clean-up moves only merged worktrees and old test results: move this one by itself.' };
        } else {
            return { ok: false, label: id, reason: 'Genie does not know that item.' };
        }
        if (suggestedCleanup([item], now).length === 1) return { ok: true, label: item.label, bytes: item.bytes };
        if (item.refusal) return { ok: false, label: item.label, reason: item.refusal };
        if (item.category === 'worktrees' && item.state !== 'merged') return { ok: false, label: item.label, reason: `It is ${WORKTREE_STATE_LABEL[item.state ?? 'unknown'].toLowerCase()}.` };
        if (item.category === 'worktrees') return { ok: false, label: item.label, reason: 'It changed in the last hour: an agent may be using it.' };
        return { ok: false, label: item.label, reason: 'It is less than a day old: it may still be read.' };
    }

    /** Put one of Genie's .trash entries back where it came from; never over something already there. */
    async restore(root: string, trashId: string): Promise<StorageResult<{ label: string }>> {
        const rootReal = await realpath(root);
        const t = await this.#trashDir(rootReal, false);
        if (!t.ok) return t;
        const cannot = { ok: false as const, reason: 'Genie can only put back what it moved to .trash.' };
        if (t.dir === null || !TRASH_ID.test(trashId)) return cannot;
        const entry = join(t.dir, trashId);
        const record = await readRecord(entry);
        if (!record) return cannot;
        const payload = join(entry, PAYLOAD);
        const o = record.origin;
        const taken = (rel: string) => ({ ok: false as const, reason: `Something is already at ${rel}: move it away first.` });
        try {
            if (o.kind === 'path') {
                const target = join(rootReal, ...o.rel.split('/'));
                if (inside(rootReal, target) !== o.rel) return cannot;
                // Never back THROUGH a link (Tynn #819: a .ai/_dirty that became a link out of the workspace): each folder on
                // the way that exists must be a real folder, and the one it lands in must be the workspace's own.
                const parentRel = o.rel.split('/').slice(0, -1).join('/');
                if (!(await realFoldersOnTheWay(rootReal, parentRel))) return cannot;
                if (await exists(target)) return taken(o.rel);
                await mkdir(dirname(target), { recursive: true });
                if (parentRel !== '' && inside(rootReal, await realpath(dirname(target))) !== parentRel) return cannot;
                await rename(payload, target);
            } else if (o.kind === 'worktree') {
                // A worktree that was outside the workspace goes back to its absolute place; one inside, to its relative one.
                const target = o.external === true ? o.rel : join(rootReal, ...o.rel.split('/'));
                const repo = o.repoRel === '.' ? rootReal : join(rootReal, ...o.repoRel.split('/'));
                if (o.external === true ? !isAbsolute(o.rel) : inside(rootReal, target) !== o.rel) return cannot;
                if (o.repoRel !== '.' && inside(rootReal, repo) !== o.repoRel) return cannot;
                if (await exists(target)) return taken(o.rel);
                await mkdir(dirname(target), { recursive: true });
                if (o.pruned === true) {
                    const back = await this.#registerAgain(repo, target, payload, o.branch, o.head ?? null);
                    if (!back.ok) return back;
                    await rm(entry, { recursive: true, force: true });
                    return { ok: true, label: o.rel };
                }
                // An entry from before Tynn #947: moved and locked by git, so git still knows it: unlock and move it back.
                const unlocked = await retryTransient(() => git(repo, ['worktree', 'unlock', payload]));
                if (!unlocked.ok) return { ok: false, reason: `git did not unlock the worktree: ${unlocked.error}` };
                const moved = await retryTransient(() => git(repo, ['worktree', 'move', payload, target]));
                if (!moved.ok) {
                    await git(repo, ['worktree', 'lock', '--reason', 'In the workspace .trash (Genie)', payload]);
                    return { ok: false, reason: `git did not move the worktree back: ${moved.error}` };
                }
            } else if (o.kind === 'chat-file') {
                if (await exists(o.path)) return taken(o.path);
                await mkdir(dirname(o.path), { recursive: true });
                await move(payload, o.path);
            } else if (o.kind === 'artboard') {
                // Items cleared off the ArtBoard (genie#847): back onto .artboard/index.json, their files back beside it.
                const back = await restoreArtboardPayload(rootReal, payload);
                if (!back.ok) return back;
            } else {
                return cannot;
            }
        } catch (error) {
            return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
        await rm(entry, { recursive: true, force: true });
        return { ok: true, label: o.kind === 'chat-file' ? `${o.agentId}: ${o.attachmentId}` : o.kind === 'artboard' ? `ArtBoard: ${o.label}` : o.rel };
    }

    /**
     * Delete everything in .trash, permanently: only with an approval naming exactly what is there now and how much. Each
     * entry is removed by name inside .trash (`rm` removes a link, never what it points at); a trashed worktree is removed
     * through git first, so git forgets it. Nothing outside .trash is touched.
     */
    async emptyTrash(root: string, approval: TrashApproval | null, onProgress?: (e: StorageProgressEvent) => void): Promise<EmptyTrashResult> {
        if (!approval) return { ok: false, reason: 'Emptying the trash needs your approval of what is in it.' };
        const rootReal = await realpath(root);
        const t = await this.#trashDir(rootReal, false);
        if (!t.ok) return t;
        const trash = await this.listTrash(rootReal);
        if (!approvalMatches(trash, approval)) return { ok: false, reason: 'The trash changed since you approved it: look again and approve what is there now.' };
        if (t.dir === null) return { ok: true, deleted: 0, bytes: 0, failed: [] };
        const repos = new Set<string>();
        const failed: StorageProblem[] = [];
        let deleted = 0;
        let bytes = 0;
        for (const [n, e] of trash.entries()) {
            const entry = join(t.dir, e.id);
            const label = originLabel(e.origin);
            if (dirname(entry) === t.dir && basename(entry) === e.id) {
                // One entry that cannot be deleted is named, and the rest still go (Tynn #947): never one failure for all.
                try {
                    // A worktree git still knows (an entry from before #947) is removed through git first, so git forgets it.
                    if (e.origin.kind === 'worktree') {
                        const repo = e.origin.repoRel === '.' ? rootReal : join(rootReal, ...e.origin.repoRel.split('/'));
                        if (await isDir(repo)) {
                            if (e.origin.pruned !== true) await retryTransient(() => git(repo, ['worktree', 'remove', '--force', '--force', join(entry, PAYLOAD)]));
                            repos.add(repo);
                        }
                    }
                    await this.#remove(entry);
                    deleted += 1;
                    bytes += e.bytes;
                } catch (error) {
                    failed.push({ id: e.id, label, reason: words(error) });
                }
            } else {
                failed.push({ id: e.id, label, reason: 'Its name is not one Genie deletes inside .trash.' });
            }
            onProgress?.({ done: n + 1, total: trash.length, bytes, current: label });
        }
        for (const repo of repos) await git(repo, ['worktree', 'prune']);
        return { ok: true, deleted, bytes, failed };
    }

    /**
     * A pruned worktree back as git's own (Tynn #947): git makes the worktree again at its place without checking anything
     * out, the files it had (ignored ones too, an .env) are moved back in, and the index is read from its commit, so its
     * status is what it was: clean. Its branch if git still has it free, else its commit, detached.
     */
    async #registerAgain(repo: string, target: string, payload: string, branch: string | null, head: string | null): Promise<StorageResult> {
        const attempts: string[][] = [];
        if (branch) attempts.push(['worktree', 'add', '--no-checkout', target, branch]);
        if (head) attempts.push(['worktree', 'add', '--no-checkout', '--detach', target, head]);
        if (attempts.length === 0) return { ok: false, reason: 'Genie does not know its branch or commit, so git cannot make it again.' };
        let added: Awaited<ReturnType<typeof git>> = { ok: false, error: '' };
        for (const args of attempts) { added = await git(repo, args); if (added.ok) break; }
        if (!added.ok) return { ok: false, reason: `git did not make the worktree again: ${added.error}` };
        try {
            for (const name of await readdir(payload)) {
                if (name === '.git') continue;
                await renameRetrying(join(payload, name), join(target, name));
            }
        } catch (error) {
            return { ok: false, reason: `git made the worktree again, but its files did not all go back (the rest are still in .trash): ${words(error)}` };
        }
        const indexed = await git(target, ['reset', '--quiet']);
        if (!indexed.ok) return { ok: false, reason: `Its files are back, but git did not read its index: ${indexed.error}` };
        return { ok: true };
    }
}

/** Each folder of `rel` under the workspace that exists is a real folder, not a link or a file; the missing rest is made later. */
async function realFoldersOnTheWay(rootReal: string, rel: string): Promise<boolean> {
    const segments = rel === '' ? [] : rel.split('/');
    for (let i = 1; i <= segments.length; i += 1) {
        let s;
        try { s = await lstat(join(rootReal, ...segments.slice(0, i))); } catch { return true; }
        if (s.isSymbolicLink() || !s.isDirectory()) return false;
    }
    return true;
}

/** A Genie .trash entry's record (its origin), or `null` when it has none Genie wrote. */
export async function readTrashRecord(entry: string): Promise<{ movedAt: number; origin: TrashOrigin } | null> {
    return readRecord(entry);
}

async function readRecord(entry: string): Promise<{ movedAt: number; origin: TrashOrigin } | null> {
    try {
        const r = JSON.parse(await readFile(join(entry, RECORD), 'utf8')) as { version?: unknown; movedAt?: unknown; origin?: { kind?: unknown; ids?: unknown; label?: unknown } };
        if (r.version !== 1 || typeof r.movedAt !== 'number' || !r.origin || typeof r.origin.kind !== 'string') return null;
        if (!['path', 'worktree', 'chat-file', 'artboard'].includes(r.origin.kind)) return null;
        if (r.origin.kind === 'artboard' && (!Array.isArray(r.origin.ids) || !r.origin.ids.every((id) => typeof id === 'string') || typeof r.origin.label !== 'string')) return null;
        return { movedAt: r.movedAt, origin: r.origin as TrashOrigin };
    } catch {
        return null;
    }
}

