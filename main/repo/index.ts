/**
 * Host-side Repository binding — the git engine behind the Repository PANEL
 * (the first plugin-panel consumer). GUI-free and host-core-safe: it owns all
 * git EXECUTION for the panel, exposed over IPC (`repo:*`) so the renderer
 * adapter is a thin client. This is the "first-party feature with a plugin-shaped
 * seam" from s217 §3.1 — the panel is the seam, the git engine is core Genie.
 *
 * Engine = `simple-git` (already a genie dependency); `fancy-git-js` is a later
 * swap behind this same interface (s217 §3.3). Auth reuses `git-auth.ts`
 * (`githubCloneAuth` config + `redactSecrets`) so a token-authed push over HTTPS
 * behaves exactly like the recursive clone and never persists or leaks the token.
 * Every repo path is CONTAINED within the workspace root (`guardRepoPath`) before
 * it reaches git. Human-initiated actions are UNGATED (owner's Phase-1 decision);
 * agent-governed push via Tynn `repo.git` HITL is a later phase.
 */
import fs from 'fs';
import path from 'path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { getToken } from '../github/storage';
import { githubCloneAuth, redactSecrets } from '../workspace/git-auth';
import { readProjectJson } from '../workspace/project-json';
import {
    guardRepoPath,
    parseRepoStatus,
    repoRefsFromProjectJson,
    type RepoRef,
    type RepoStatus,
} from './model';

export type RepoResult<T> = { ok: true; value: T } | { ok: false; error: string };

function ok<T>(value: T): { ok: true; value: T } {
    return { ok: true, value };
}
function fail(error: string): { ok: false; error: string } {
    return { ok: false, error };
}

/** Auth config + secrets for a github push/pull over HTTPS (empty with no token). */
function authFor(): { config: string[]; secrets: string[] } {
    const token = getToken();
    // githubCloneAuth builds the `-c` config (insteadOf rewrites + token
    // extraheader) and the secret list to scrub from any surfaced error. The URL
    // arg is irrelevant here (we only take config/secrets), so pass a placeholder.
    const auth = githubCloneAuth('x', token);
    return { config: auth.config, secrets: auth.secrets };
}

/** Is `<workspaceRoot>/<rel>` a git work tree (has a `.git` file or folder)? */
function isGitRepo(workspaceRoot: string, rel: string): boolean {
    try {
        const abs = guardRepoPath(workspaceRoot, rel);
        return fs.existsSync(path.join(abs, '.git'));
    } catch {
        return false;
    }
}

/** Build a simple-git bound to a contained repo path, optionally with auth config. */
function gitAt(workspaceRoot: string, repoRel: string, config: string[] = []): SimpleGit {
    const baseDir = guardRepoPath(workspaceRoot, repoRel);
    return simpleGit({ baseDir, config, trimmed: false });
}

/** Enumerate the selectable repos for a workspace: the root + `project.json` members. */
export async function discoverRepos(workspaceRoot: string): Promise<RepoResult<RepoRef[]>> {
    try {
        const root = path.resolve(workspaceRoot);
        const rootName = path.basename(root) || 'workspace';
        const project = readProjectJson(root);
        const refs = repoRefsFromProjectJson(rootName, project?.repos, (rel) =>
            isGitRepo(root, rel),
        );
        return ok(refs);
    } catch (e) {
        return fail((e as Error).message);
    }
}

/** Branch + ahead/behind + changed files for one repo (the panel's view model). */
export async function repoStatus(
    workspaceRoot: string,
    repoRel: string,
): Promise<RepoResult<RepoStatus>> {
    try {
        const out = await gitAt(workspaceRoot, repoRel).raw([
            'status',
            '--porcelain=v1',
            '--branch',
            '-uall',
        ]);
        return ok(parseRepoStatus(out));
    } catch (e) {
        return fail((e as Error).message);
    }
}

/**
 * The unified diff for one file (staged or unstaged). Untracked files have no
 * git diff yet — the caller shows "stage to review" — so this returns an empty
 * patch rather than erroring for them.
 */
export async function repoDiff(
    workspaceRoot: string,
    repoRel: string,
    filePath: string,
    staged: boolean,
): Promise<RepoResult<{ patch: string }>> {
    try {
        const args = ['diff', ...(staged ? ['--cached'] : []), '--', filePath];
        const patch = await gitAt(workspaceRoot, repoRel).raw(args);
        return ok({ patch });
    } catch (e) {
        return fail((e as Error).message);
    }
}

/** Stage the given repo-relative paths (whole-file staging; partial staging is a fast-follow). */
export async function repoStage(
    workspaceRoot: string,
    repoRel: string,
    paths: string[],
): Promise<RepoResult<null>> {
    try {
        if (paths.length === 0) return ok(null);
        await gitAt(workspaceRoot, repoRel).raw(['add', '--', ...paths]);
        return ok(null);
    } catch (e) {
        return fail((e as Error).message);
    }
}

/** Unstage the given repo-relative paths (`git restore --staged`). */
export async function repoUnstage(
    workspaceRoot: string,
    repoRel: string,
    paths: string[],
): Promise<RepoResult<null>> {
    try {
        if (paths.length === 0) return ok(null);
        await gitAt(workspaceRoot, repoRel).raw(['restore', '--staged', '--', ...paths]);
        return ok(null);
    } catch (e) {
        return fail((e as Error).message);
    }
}

/** Commit the staged changes with `message`. Errors (e.g. nothing staged) surface. */
export async function repoCommit(
    workspaceRoot: string,
    repoRel: string,
    message: string,
): Promise<RepoResult<{ commit: string }>> {
    try {
        const msg = String(message ?? '').trim();
        if (!msg) return fail('A commit message is required.');
        const res = await gitAt(workspaceRoot, repoRel).commit(msg);
        return ok({ commit: res.commit });
    } catch (e) {
        return fail((e as Error).message);
    }
}

/**
 * Push the current branch to `remote` (default 'origin'), setting upstream —
 * `-u <remote> HEAD` works for a brand-new or an already-tracked branch alike.
 * Token-authed over HTTPS when Genie holds a GitHub token; the token is scrubbed
 * from any surfaced error.
 */
export async function repoPush(
    workspaceRoot: string,
    repoRel: string,
    remote = 'origin',
): Promise<RepoResult<null>> {
    const { config, secrets } = authFor();
    try {
        await gitAt(workspaceRoot, repoRel, config).raw(['push', '-u', remote || 'origin', 'HEAD']);
        return ok(null);
    } catch (e) {
        return fail(redactSecrets((e as Error).message, secrets));
    }
}

/** Pull with `--ff-only` — fast-forward or stop, never a surprise merge commit. */
export async function repoPull(
    workspaceRoot: string,
    repoRel: string,
): Promise<RepoResult<null>> {
    const { config, secrets } = authFor();
    try {
        await gitAt(workspaceRoot, repoRel, config).raw(['pull', '--ff-only']);
        return ok(null);
    } catch (e) {
        return fail(redactSecrets((e as Error).message, secrets));
    }
}

/** Create + switch to a new branch (`git switch -c <name>`). */
export async function repoCreateBranch(
    workspaceRoot: string,
    repoRel: string,
    name: string,
): Promise<RepoResult<null>> {
    try {
        const branch = String(name ?? '').trim();
        if (!branch) return fail('A branch name is required.');
        await gitAt(workspaceRoot, repoRel).raw(['switch', '-c', branch]);
        return ok(null);
    } catch (e) {
        return fail((e as Error).message);
    }
}
