import { gitExecFile } from './git-exec.js';
import { GitDidNotAnswer, withinGitLimit, type GitLimit } from './git-ports.js';
import { GIT_NEEDS_TRUST, gitMayRun } from './git-read-policy.js';
import { guardRepoPath, parseRepoStatus, type RepoStatus } from './repo-model.js';
import { resolveProgram } from '../core/program-lookup.js';
import type { ReleaseGate } from '../core/release-tag.js';

/**
 * THE REPOSITORY PANEL'S GIT (beta.33 item 14; Genie 1 main/repo/index.ts). The engine behind the Repository official
 * plugin's panel: status, diff, stage, unstage, commit, branch, push, pull, tag release — every one the person's own click, run with the
 * real `git` on the host that holds the workspace, its repo path confined to the workspace before git sees it. Push and pull
 * use the person's own git credentials (their credential helper, ssh agent) — Genie adds none. Pull is fast-forward only:
 * it never makes a merge commit nobody asked for. Destructive operations (force push, reset) are not offered.
 * Failures come back in git's own words.
 */

export type RepoResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T,>(value: T): RepoResult<T> => ({ ok: true, value });
const fail = (error: string): RepoResult<never> => ({ ok: false, error });

async function git(cwd: string, args: readonly string[], limit?: GitLimit): Promise<RepoResult<string>> {
    if (!(await gitMayRun(cwd))) return fail(GIT_NEEDS_TRUST);
    return new Promise((resolve) => {
        const answered = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer): void => {
            if (error) resolve(fail(String(stderr ?? '').trim() || error.message));
            else resolve(ok(String(stdout)));
        };
        const options = { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
        if (limit) limit.git(args, options, answered);
        else gitExecFile(resolveProgram('git'), [...args], { ...options, windowsHide: true }, answered);
    });
}

/** Run git in the confined repo folder; a path that escapes the workspace never reaches git. */
async function inRepo(root: string, repoRel: string, args: readonly string[], limit?: GitLimit): Promise<RepoResult<string>> {
    let cwd: string;
    try { cwd = guardRepoPath(root, repoRel); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
    return git(cwd, args, limit);
}

const done = (r: RepoResult<string>): RepoResult<null> => (r.ok ? ok(null) : r);

/** A read has a limit; a push or a pull, which may wait on a network or a person's key, does not. */
const asRead = (run: (limit: GitLimit) => Promise<RepoResult<string>>): Promise<RepoResult<string>> =>
    withinGitLimit(run).catch((error: unknown) => { if (error instanceof GitDidNotAnswer) return fail(error.message); throw error; });

export async function repoStatus(root: string, repoRel: string): Promise<RepoResult<RepoStatus>> {
    const r = await asRead((limit) => inRepo(root, repoRel, ['status', '--porcelain=v1', '--branch', '-uall'], limit));
    return r.ok ? ok(parseRepoStatus(r.value)) : r;
}

/** One file's unified diff, staged or not. An untracked file has none yet — empty, not an error. */
export async function repoDiff(root: string, repoRel: string, file: string, staged: boolean): Promise<RepoResult<{ patch: string }>> {
    const r = await asRead((limit) => inRepo(root, repoRel, ['diff', ...(staged ? ['--cached'] : []), '--', file], limit));
    return r.ok ? ok({ patch: r.value }) : r;
}

export async function repoStage(root: string, repoRel: string, paths: readonly string[]): Promise<RepoResult<null>> {
    if (paths.length === 0) return ok(null);
    return done(await inRepo(root, repoRel, ['add', '--', ...paths]));
}

export async function repoUnstage(root: string, repoRel: string, paths: readonly string[]): Promise<RepoResult<null>> {
    if (paths.length === 0) return ok(null);
    return done(await inRepo(root, repoRel, ['restore', '--staged', '--', ...paths]));
}

export async function repoCommit(root: string, repoRel: string, message: string): Promise<RepoResult<{ commit: string }>> {
    const msg = String(message ?? '').trim();
    if (!msg) return fail('A commit message is required.');
    const r = await inRepo(root, repoRel, ['commit', '-m', msg]);
    if (!r.ok) return r;
    const head = await inRepo(root, repoRel, ['rev-parse', '--short', 'HEAD']);
    return ok({ commit: head.ok ? head.value.trim() : '' });
}

/** Push the current branch and set its upstream — `-u <remote> HEAD` is the same for a new branch and a tracked one. */
export async function repoPush(root: string, repoRel: string, remote = 'origin'): Promise<RepoResult<null>> {
    return done(await inRepo(root, repoRel, ['push', '-u', remote || 'origin', 'HEAD']));
}

export async function repoPull(root: string, repoRel: string): Promise<RepoResult<null>> {
    return done(await inRepo(root, repoRel, ['pull', '--ff-only']));
}

/** HEAD's full commit SHA: what a Tag release would tag. */
export async function repoHead(root: string, repoRel: string): Promise<RepoResult<string>> {
    const r = await asRead((limit) => inRepo(root, repoRel, ['rev-parse', '--verify', 'HEAD^{commit}'], limit));
    return r.ok ? ok(r.value.trim()) : r;
}

/**
 * TAG RELEASE (PM G-4, Tynn #937): an annotated tag on HEAD, pushed to the remote — that one tag, never `--tags`. The
 * commit is read FIRST, as a full SHA, and that SHA is what the gate is asked about and what is tagged: HEAD moving while
 * Tynn is asked cannot put the tag on a commit nobody signed. A linked workspace's gate is Tynn's release decision
 * (release-tag-gate.ts), which lets it through unsigned only where Tynn says none is required; an unlinked workspace has
 * none and tags as any git does. A refused push takes the local tag back,
 * so the next try is clean and no unpushed release tag waits to ride out on someone's `git push --tags`.
 */
export async function repoTagRelease(root: string, repoRel: string, tag: string, opts: { remote?: string; gate?: (commit: string) => Promise<ReleaseGate> }): Promise<RepoResult<{ tag: string; commit: string }>> {
    const name = String(tag ?? '').trim();
    if (!name) return fail('A tag name is required.');
    if (name.startsWith('-')) return fail(`"${name}" is not a tag name git takes.`);
    const format = await inRepo(root, repoRel, ['check-ref-format', `refs/tags/${name}`]);
    if (!format.ok) return fail(`"${name}" is not a tag name git takes.`);
    const head = await inRepo(root, repoRel, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (!head.ok) return head;
    const commit = head.value.trim();
    let message = `Release ${name}`;
    if (opts.gate) {
        const gate = await opts.gate(commit);
        if (!gate.ok) return fail(gate.reason);
        const version = gate.versionNumber ?? '(unnumbered)';
        const who = gate.signedBy ? `, signed by ${gate.signedBy}` : '';
        message += gate.required
            ? `\n\nTynn release decision ${gate.recordId ?? '(unnamed)'} for version ${version}${who}.`
            : `\n\nTynn required no release decision for version ${version}: its repository has not opted into the release rules.`;
    }
    const made = await inRepo(root, repoRel, ['tag', '-a', '-m', message, name, commit]);
    if (!made.ok) return made;
    const remote = opts.remote || 'origin';
    const pushed = await inRepo(root, repoRel, ['push', remote, `refs/tags/${name}:refs/tags/${name}`]);
    if (!pushed.ok) {
        await inRepo(root, repoRel, ['tag', '-d', name]);
        return pushed;
    }
    return ok({ tag: name, commit });
}

export async function repoCreateBranch(root: string, repoRel: string, name: string): Promise<RepoResult<null>> {
    const branch = String(name ?? '').trim();
    if (!branch) return fail('A branch name is required.');
    return done(await inRepo(root, repoRel, ['switch', '-c', branch]));
}
