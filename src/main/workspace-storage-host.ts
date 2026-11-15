import { randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { resolveProgram } from '../core/program-lookup.js';
import {
    ARTIFACT_WALK_SKIP, STORAGE_CATEGORIES, approvalMatches, isArtifactName, parseWorktreeList, worktreeRefusal,
    type StorageCategory, type StorageItem, type StorageReport, type TrashApproval, type TrashEntry, type TrashOrigin,
} from '../core/workspace-storage.js';
import { sizeOf as defaultSizeOf, type DirSize } from './dir-size.js';
import { gitExecFile } from './git-exec.js';
import { GitDidNotAnswer, withinGitLimit } from './git-ports.js';
import { GIT_NEEDS_TRUST, gitMayRun } from './git-read-policy.js';

/**
 * A WORKSPACE'S STORAGE, ON THE HOST (Tynn #697): measure it by category, move reclaimable clutter into the workspace's
 * `.trash` with each item's origin recorded, put it back, and empty `.trash` only with the person's approval.
 *
 * THE RULES THIS FILE KEEPS:
 *  - It never leaves the workspace: every path is resolved under the workspace's real path; a worktree elsewhere, an id
 *    with `..`, a `.trash` that is a link, are refused. Measuring never follows a link (main/dir-size.ts).
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
}

const RECORD = 'genie-trash.json';
const PAYLOAD = 'item';
const TRASH_ID = /^genie-\d+-[0-9a-f]{6}$/;
/** How deep, and how many folders, the artifact search looks at. */
const ARTIFACT_DEPTH = 6;
const ARTIFACT_DIRS = 20_000;
const WALKS_AT_ONCE = 4;

const LINKED_TRASH = 'This workspace’s .trash is a link, not a folder: Genie will not use it.';

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

/** At most `n` at once, in order. */
async function pooled<T, R>(list: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(list.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
        while (next < list.length) { const i = next; next += 1; out[i] = await fn(list[i]!); }
    }));
    return out;
}

interface WorktreeFound { rel: string; abs: string; repoAbs: string; repoRel: string; branch: string | null; refusal: string | null }

export class WorkspaceStorage {
    readonly #now: () => number;
    readonly #sizeOf: (path: string) => Promise<DirSize>;

    constructor(ports: StoragePorts = {}) {
        this.#now = ports.now ?? Date.now;
        this.#sizeOf = ports.sizeOf ?? ((p) => defaultSizeOf(p));
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

    /** The worktrees of the workspace's repositories that sit inside it (never the main checkout, never one in .trash). */
    async #worktrees(rootReal: string): Promise<WorktreeFound[]> {
        const out: WorktreeFound[] = [];
        const trashReal = join(rootReal, '.trash');
        for (const repo of await this.#repos(rootReal)) {
            const listed = await git(repo.abs, ['worktree', 'list', '--porcelain']);
            if (!listed.ok) continue;
            const list = parseWorktreeList(listed.out);
            for (const w of list.slice(1)) {
                if (w.bare) continue;
                let real: string;
                try { real = await realpath(w.path); } catch { continue; }
                const rel = inside(rootReal, real);
                if (rel === null || inside(trashReal, real) !== null || real === trashReal) continue;
                const status = await git(real, ['status', '--porcelain']);
                const ahead = await git(real, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
                const unpushed = ahead.ok && /^\d+\s*$/.test(ahead.out) ? Number(ahead.out.trim()) : null;
                const refusal = worktreeRefusal({ locked: w.locked, dirty: !status.ok || status.out.trim() !== '', unpushed });
                out.push({ rel, abs: real, repoAbs: repo.abs, repoRel: repo.rel, branch: w.branch, refusal: !status.ok ? `Genie could not read its status: ${status.error}` : refusal });
            }
        }
        return out.sort((a, b) => a.rel.localeCompare(b.rel));
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
                if (isArtifactName(e.name)) { const rel = inside(rootReal, full); if (rel) found.push(rel); continue; }
                if (depth + 1 < ARTIFACT_DEPTH) queue.push({ dir: full, depth: depth + 1 });
            }
        }
        return found.sort();
    }

    /** `.trash` as a folder; `null` when absent; refused when it is anything else (a link would leave the workspace). */
    async #trashDir(rootReal: string, create: boolean): Promise<{ ok: true; dir: string | null } | { ok: false; reason: string }> {
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
        const [repos, worktrees, artifacts, trash] = await Promise.all([this.#repos(rootReal), this.#worktrees(rootReal), this.#artifacts(rootReal), this.listTrash(rootReal)]);
        let truncated = false;
        const sized = async (abs: string) => { const s = await this.#sizeOf(abs); if (s.truncated) truncated = true; return s; };
        const items: StorageItem[] = [];
        const repoItems = await pooled(repos.filter((r) => r.rel !== '.'), WALKS_AT_ONCE, async (r) => {
            const s = await sized(r.abs);
            return { id: `repos:${r.rel}`, category: 'repos' as const, label: r.rel, rel: r.rel, ...s, reclaimable: false, refusal: null };
        });
        items.push(...repoItems);
        items.push(...await pooled(worktrees, WALKS_AT_ONCE, async (w) => {
            const s = await sized(w.abs);
            return { id: `worktrees:${w.rel}`, category: 'worktrees' as const, label: w.branch ? `${w.rel} (${w.branch})` : w.rel, rel: w.rel, ...s, reclaimable: w.refusal === null, refusal: w.refusal };
        }));
        items.push(...await pooled(artifacts, WALKS_AT_ONCE, async (rel) => {
            const s = await sized(join(rootReal, ...rel.split('/')));
            return { id: `ci-artifacts:${rel}`, category: 'ci-artifacts' as const, label: rel, rel, ...s, reclaimable: true, refusal: null };
        }));
        for (const c of input.chatFiles) {
            const file = basename(c.path);
            items.push({ id: `chat-files:${c.agentId}/${c.attachmentId}`, category: 'chat-files', label: `${c.agentName}: ${c.attachmentId} (${file})`, rel: `${c.agentId}/${file}`, bytes: c.bytes, files: 1, truncated: false, reclaimable: true, refusal: null });
        }
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
            const notArtifact = { ok: false as const, reason: 'That is not a CI or test artifact Genie found in this workspace.' };
            const segments = rest.split('/');
            if (rest === '' || isAbsolute(rest) || segments.some((s) => s === '' || s === '.' || s === '..' || ARTIFACT_WALK_SKIP.includes(s)) || !isArtifactName(segments.at(-1)!)) return notArtifact;
            const abs = join(rootReal, ...segments);
            try {
                const s = await lstat(abs);
                if (s.isSymbolicLink() || !s.isDirectory()) return notArtifact;
                if (inside(rootReal, await realpath(abs)) !== rest) return notArtifact;
            } catch { return notArtifact; }
            plan = { origin: { kind: 'path', category: 'ci-artifacts', rel: rest }, label: rest, run: (payload) => rename(abs, payload) };
        } else if (category === 'worktrees') {
            const w = (await this.#worktrees(rootReal)).find((x) => x.rel === rest);
            if (!w) return { ok: false, reason: 'That is not a worktree Genie may move: only one of this workspace’s own, other than a repository’s main checkout.' };
            if (w.refusal) return { ok: false, reason: w.refusal };
            plan = {
                origin: { kind: 'worktree', repoRel: w.repoRel, rel: w.rel, branch: w.branch },
                label: w.rel,
                run: async (payload) => {
                    const moved = await git(w.repoAbs, ['worktree', 'move', w.abs, payload]);
                    if (!moved.ok) throw new Error(`git did not move the worktree: ${moved.error}`);
                    const locked = await git(w.repoAbs, ['worktree', 'lock', '--reason', 'In the workspace .trash (Genie)', payload]);
                    if (!locked.ok) throw new Error(`git moved the worktree but did not lock it: ${locked.error}`);
                },
            };
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
        try {
            await plan.run(join(entry, PAYLOAD));
        } catch (error) {
            await rm(entry, { recursive: true, force: true }).catch(() => undefined);
            return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
        await writeFile(join(entry, RECORD), JSON.stringify({ version: 1, movedAt: this.#now(), origin: plan.origin }), 'utf8');
        return { ok: true, trashId, label: plan.label };
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
                if (await exists(target)) return taken(o.rel);
                await mkdir(dirname(target), { recursive: true });
                await rename(payload, target);
            } else if (o.kind === 'worktree') {
                const target = join(rootReal, ...o.rel.split('/'));
                const repo = o.repoRel === '.' ? rootReal : join(rootReal, ...o.repoRel.split('/'));
                if (inside(rootReal, target) !== o.rel || (o.repoRel !== '.' && inside(rootReal, repo) !== o.repoRel)) return cannot;
                if (await exists(target)) return taken(o.rel);
                await mkdir(dirname(target), { recursive: true });
                const unlocked = await git(repo, ['worktree', 'unlock', payload]);
                if (!unlocked.ok) return { ok: false, reason: `git did not unlock the worktree: ${unlocked.error}` };
                const moved = await git(repo, ['worktree', 'move', payload, target]);
                if (!moved.ok) {
                    await git(repo, ['worktree', 'lock', '--reason', 'In the workspace .trash (Genie)', payload]);
                    return { ok: false, reason: `git did not move the worktree back: ${moved.error}` };
                }
            } else if (o.kind === 'chat-file') {
                if (await exists(o.path)) return taken(o.path);
                await mkdir(dirname(o.path), { recursive: true });
                await move(payload, o.path);
            } else {
                return cannot;
            }
        } catch (error) {
            return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
        await rm(entry, { recursive: true, force: true });
        return { ok: true, label: o.kind === 'chat-file' ? `${o.agentId}: ${o.attachmentId}` : o.rel };
    }

    /**
     * Delete everything in .trash, permanently: only with an approval naming exactly what is there now and how much. Each
     * entry is removed by name inside .trash (`rm` removes a link, never what it points at); a trashed worktree is removed
     * through git first, so git forgets it. Nothing outside .trash is touched.
     */
    async emptyTrash(root: string, approval: TrashApproval | null): Promise<StorageResult<{ deleted: number; bytes: number }>> {
        if (!approval) return { ok: false, reason: 'Emptying the trash needs your approval of what is in it.' };
        const rootReal = await realpath(root);
        const t = await this.#trashDir(rootReal, false);
        if (!t.ok) return t;
        const trash = await this.listTrash(rootReal);
        if (!approvalMatches(trash, approval)) return { ok: false, reason: 'The trash changed since you approved it: look again and approve what is there now.' };
        if (t.dir === null) return { ok: true, deleted: 0, bytes: 0 };
        const repos = new Set<string>();
        for (const e of trash) {
            const entry = join(t.dir, e.id);
            if (dirname(entry) !== t.dir || basename(entry) !== e.id) continue;
            if (e.origin.kind === 'worktree') {
                const repo = e.origin.repoRel === '.' ? rootReal : join(rootReal, ...e.origin.repoRel.split('/'));
                if (await isDir(repo)) {
                    await git(repo, ['worktree', 'remove', '--force', '--force', join(entry, PAYLOAD)]);
                    repos.add(repo);
                }
            }
            await rm(entry, { recursive: true, force: true });
        }
        for (const repo of repos) await git(repo, ['worktree', 'prune']);
        return { ok: true, deleted: trash.length, bytes: approval.bytes };
    }
}

async function readRecord(entry: string): Promise<{ movedAt: number; origin: TrashOrigin } | null> {
    try {
        const r = JSON.parse(await readFile(join(entry, RECORD), 'utf8')) as { version?: unknown; movedAt?: unknown; origin?: { kind?: unknown } };
        if (r.version !== 1 || typeof r.movedAt !== 'number' || !r.origin || typeof r.origin.kind !== 'string') return null;
        if (!['path', 'worktree', 'chat-file'].includes(r.origin.kind)) return null;
        return { movedAt: r.movedAt, origin: r.origin as TrashOrigin };
    } catch {
        return null;
    }
}

