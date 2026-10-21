import { access, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { listRepos } from '../core/repo-registry.js';
import { readArtBoard, reviewArtBoardPost, type ReviewResult } from './artboard-host.js';
import { repoCommit, repoCreateBranch, repoDiff, repoPull, repoPush, repoStage, repoStatus, repoUnstage, type RepoResult } from './repo-git.js';
import type { ResolvedBoard } from '../core/artboard.js';

/**
 * THE OFFICIAL PANELS' HOST CALLS (beta.33 item 14): what the Repository and ArtBoard panels ask of the host, by WORKSPACE —
 * the renderer never names a host path, the host looks the workspace up. Each call is refused, in words, for a workspace
 * Genie does not have. main.ts forwards one IPC channel per panel here; the rules are tested without Electron.
 */

export interface PanelsHostDeps {
    readonly workspacePath: (workspaceId: string) => string | null;
    /** AgentInbox delivery of an ArtBoard verdict, from the person to the posting agent. */
    readonly send: (agentId: string, text: string) => Promise<void>;
    readonly now: () => string;
}

const unknownWorkspace = 'Genie does not have that workspace';
const exists = (p: string) => access(p).then(() => true, () => false);

/** The repos a workspace's panel can pick: the workspace itself when it is one, then the envelope's `repos[]` that are. */
export async function workspaceRepos(root: string): Promise<{ rel: string; name: string }[]> {
    const out: { rel: string; name: string }[] = [];
    if (await exists(join(root, '.git'))) out.push({ rel: '', name: basename(root) || 'workspace' });
    let manifest: unknown = null;
    try { manifest = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')); } catch { manifest = null; }
    if (manifest && typeof manifest === 'object') {
        for (const r of listRepos(manifest as Record<string, unknown>)) {
            if (r.path === '.' || r.path === '') continue;
            if (await exists(join(root, ...r.path.split('/'), '.git'))) out.push({ rel: r.path, name: r.name });
        }
    }
    return out;
}

export type RepoOp = 'list' | 'status' | 'diff' | 'stage' | 'unstage' | 'commit' | 'branch' | 'push' | 'pull';

export async function repoCall(deps: PanelsHostDeps, op: unknown, workspaceId: unknown, rel: unknown, a?: unknown, b?: unknown): Promise<RepoResult<unknown>> {
    const root = typeof workspaceId === 'string' ? deps.workspacePath(workspaceId) : null;
    if (!root) return { ok: false, error: unknownWorkspace };
    const repo = typeof rel === 'string' ? rel : '';
    const paths = Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
    switch (op) {
        case 'list': return { ok: true, value: await workspaceRepos(root) };
        case 'status': return repoStatus(root, repo);
        case 'diff': return repoDiff(root, repo, typeof a === 'string' ? a : '', b === true);
        case 'stage': return repoStage(root, repo, paths);
        case 'unstage': return repoUnstage(root, repo, paths);
        case 'commit': return repoCommit(root, repo, typeof a === 'string' ? a : '');
        case 'branch': return repoCreateBranch(root, repo, typeof a === 'string' ? a : '');
        case 'push': return repoPush(root, repo, typeof a === 'string' && a ? a : 'origin');
        case 'pull': return repoPull(root, repo);
        default: return { ok: false, error: `the repository panel has no "${String(op)}"` };
    }
}

export async function artboardRead(deps: PanelsHostDeps, workspaceId: unknown): Promise<ResolvedBoard> {
    const root = typeof workspaceId === 'string' ? deps.workspacePath(workspaceId) : null;
    if (!root) return { posts: [], error: unknownWorkspace };
    return readArtBoard(root);
}

export async function artboardReview(deps: PanelsHostDeps, workspaceId: unknown, postId: unknown, verdict: unknown, comment: unknown): Promise<ReviewResult> {
    const root = typeof workspaceId === 'string' ? deps.workspacePath(workspaceId) : null;
    if (!root) return { ok: false, error: unknownWorkspace };
    if (typeof postId !== 'string' || (verdict !== 'approved' && verdict !== 'rejected')) return { ok: false, error: 'bad arguments' };
    return reviewArtBoardPost(root, postId, { verdict, comment: typeof comment === 'string' ? comment : undefined }, { send: deps.send, now: deps.now });
}
