import { dirname, isAbsolute, join, resolve } from 'node:path';
import { addRepo, listRepos, removeRepo, type RepoEntry } from '../core/repo-registry.js';
import { branchFromHead, lockState, type LockState } from '../core/repo-status.js';

/**
 * REPO OPERATIONS IN THE APP (§6.1) — the main-process half over the pure registry. Reads the envelope's
 * project.json through ports, applies the rule, writes the manifest back. A workspace without a manifest is
 * told to convert first; a folder that does not exist is refused before anything is written; the host repo
 * cannot be removed. Every refusal is a reason the surface shows.
 */

export interface RepoOpsPorts {
    readonly fs: {
        exists(path: string): Promise<boolean>;
        readJson(path: string): Promise<unknown>;
        writeJson(path: string, value: unknown): Promise<void>;
        /** The repo chips (`core/repo-status.ts`) read `.git/HEAD` and stat `.git/index.lock`; absent = no status, never a guess. */
        readText?(path: string): Promise<string | null>;
        mtime?(path: string): Promise<number | null>;
        unlink?(path: string): Promise<void>;
    };
    readonly registry: { workspace(id: string): { id: string; path: string } | null };
    readonly now?: () => number;
}

/**
 * The repo's git directory: `<repo>/.git`, or — a submodule's `.git` is a FILE reading `gitdir: ../.git/modules/x` —
 * the directory it points at. `null` when neither can be read.
 */
async function gitDirOf(ports: RepoOpsPorts, repoRoot: string): Promise<string | null> {
    const dotGit = join(repoRoot, '.git');
    if (await ports.fs.exists(dotGit)) return dotGit;
    const text = await ports.fs.readText?.(dotGit);
    const m = text ? /^gitdir:\s*(.+)$/m.exec(text) : null;
    if (!m?.[1]) return null;
    const target = m[1].trim();
    return isAbsolute(target) ? target : resolve(dirname(dotGit), target);
}

async function statusOf(ports: RepoOpsPorts, wsPath: string, repo: RepoEntry): Promise<{ branch?: string | null; lock?: LockState | null; missing?: boolean }> {
    const root = repo.path === '.' ? wsPath : join(wsPath, ...repo.path.split('/'));
    // A registered repo whose folder is not there is a WORKSPACE-LEVEL fault (the board's group-header row), reported
    // as a flag on the entry; the host repo (`.`) is the envelope itself and cannot be missing.
    const missing = repo.path !== '.' && !(await ports.fs.exists(root));
    const flag = missing ? { missing: true } : {};
    // Ports that cannot read `.git` add NOTHING else to the entry — absent, not null-as-a-claim — so a host without
    // them lists repos exactly as before.
    if (!ports.fs.readText || !ports.fs.mtime) return flag;
    if (missing) return { ...flag, branch: null, lock: null };
    const gitDir = await gitDirOf(ports, root);
    if (!gitDir) return { branch: null, lock: null };
    const [head, lockMtime] = await Promise.all([ports.fs.readText(join(gitDir, 'HEAD')), ports.fs.mtime(join(gitDir, 'index.lock'))]);
    return { branch: branchFromHead(head), lock: lockState(lockMtime, (ports.now ?? Date.now)()) };
}

/**
 * "Remove stale lock" (the board's fix on a red repo chip). Removes `index.lock` ONLY when it is stale — a fresh lock
 * is a git command in flight, and deleting it from under that command corrupts the index. Says why otherwise.
 */
export async function removeRepoLockOf(ports: RepoOpsPorts, workspaceId: string, slug: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const m = await manifestOf(ports, workspaceId);
    if (!m.ok) return m;
    const repo = listRepos(m.manifest).find((r) => r.slug === slug);
    if (!repo) return { ok: false, reason: `no repo "${slug}" in this workspace` };
    if (!ports.fs.unlink || !ports.fs.mtime) return { ok: false, reason: 'this window cannot touch the repo' };
    const ws = ports.registry.workspace(workspaceId)!;
    const gitDir = await gitDirOf(ports, repo.path === '.' ? ws.path : join(ws.path, ...repo.path.split('/')));
    if (!gitDir) return { ok: false, reason: `${slug} has no readable .git` };
    const lock = lockState(await ports.fs.mtime(join(gitDir, 'index.lock')), (ports.now ?? Date.now)());
    if (!lock) return { ok: false, reason: `${slug} is not locked` };
    if (!lock.stale) return { ok: false, reason: `${slug}'s index.lock is fresh — a git command is still running; try again in a minute` };
    await ports.fs.unlink(join(gitDir, 'index.lock'));
    return { ok: true };
}

type Manifest = { ok: true; path: string; manifest: Record<string, unknown> } | { ok: false; reason: string };

async function manifestOf(ports: RepoOpsPorts, workspaceId: string): Promise<Manifest> {
    const ws = ports.registry.workspace(workspaceId);
    if (!ws) return { ok: false, reason: `no workspace "${workspaceId}"` };
    const path = join(ws.path, 'project.json');
    const raw = await ports.fs.readJson(path);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'this workspace has no project.json; convert it to an envelope first' };
    return { ok: true, path, manifest: raw as Record<string, unknown> };
}

export async function listReposOf(ports: RepoOpsPorts, workspaceId: string): Promise<{ ok: true; repos: RepoEntry[] } | { ok: false; reason: string }> {
    const m = await manifestOf(ports, workspaceId);
    if (!m.ok) return m;
    const ws = ports.registry.workspace(workspaceId)!;
    // Each repo carries its branch and lock when the ports can read them (the header's chips); otherwise neither.
    const repos = await Promise.all(listRepos(m.manifest).map(async (r) => ({ ...r, ...(await statusOf(ports, ws.path, r)) })));
    return { ok: true, repos };
}

export async function addRepoTo(ports: RepoOpsPorts, workspaceId: string, input: { name: string; path: string; url?: string }): Promise<{ ok: true; slug: string } | { ok: false; reason: string }> {
    const m = await manifestOf(ports, workspaceId);
    if (!m.ok) return m;
    const result = addRepo(m.manifest, input);
    if (!result.ok) return result;
    const ws = ports.registry.workspace(workspaceId)!;
    const added = listRepos(result.manifest).find((r) => r.slug === result.slug)!;
    if (!(await ports.fs.exists(join(ws.path, ...added.path.split('/'))))) return { ok: false, reason: `${added.path} does not exist inside the envelope; clone or create it first` };
    await ports.fs.writeJson(m.path, result.manifest);
    return { ok: true, slug: result.slug };
}

export async function removeRepoFrom(ports: RepoOpsPorts, workspaceId: string, slug: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const m = await manifestOf(ports, workspaceId);
    if (!m.ok) return m;
    const result = removeRepo(m.manifest, slug);
    if (!result.ok) return result;
    await ports.fs.writeJson(m.path, result.manifest);
    return { ok: true };
}
