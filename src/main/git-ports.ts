import { execFile, type ChildProcess, type ExecFileOptions } from 'node:child_process';
import { join } from 'node:path';
import { redactSecrets } from '../core/github.js';
import { commitIdentityConfig } from '../core/add-workspace.js';
import { isLocalPathLike } from '../core/envelope-plan.js';
import { subtreeOf, systemProcessTree, type ProcessTree } from '../core/process-tree.js';
import { resolveProgram } from '../core/program-lookup.js';
import { gitMayRun } from './git-read-policy.js';

/**
 * HOW LONG A GIT READ MAY TAKE. Long enough that a slow real repository doesn't reach it: a status on a huge tree, with a scanner in the way, takes tens of seconds. A read past it is a failure the person sees, with a Retry, never an empty list that reads as "nothing changed".
 * A hook's child can hold git's output open after git is gone, so the wait itself ends at the limit, whatever the process does.
 */
export const GIT_READ_LIMIT = { ms: 120_000 };

export class GitDidNotAnswer extends Error {
    constructor() {
        super(`git did not answer within ${Math.round(GIT_READ_LIMIT.ms / 1000)} s`);
    }
}

/** A read inside the limit runs its git through this, so the limit knows what to end. */
export interface GitLimit {
    /** The child, for what writes to it; `null` when the limit has already passed and `callback` has been told. */
    git(args: readonly string[], options: ExecFileOptions, callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void): ChildProcess | null;
}

/**
 * What the limit ends: git, and what git started under it, a hook's child above all, which keeps the folder open and
 * would never end by itself. Read BEFORE the kill: once git is gone, its children's link to it is what cannot be walked.
 * Through the process tree's rules (`core/process-tree.ts`): the same process by pid, start time and name, the descendants
 * this reading verified, no `/T`. A child that a hook detached from its parent before the reading is not found.
 */
async function endGitTrees(children: readonly ChildProcess[], tree: ProcessTree): Promise<void> {
    const running = children.filter((child) => child.exitCode === null && child.signalCode === null && child.pid !== undefined);
    if (running.length === 0) return;
    try {
        const table = tree.read ? await tree.read() : tree.snapshot();
        if (table !== null) {
            const pids = new Set(running.map((child) => child.pid));
            const targets = subtreeOf(table, table.filter((p) => pids.has(p.pid)));
            if (tree.reap) await tree.reap(targets, table);
            else tree.killTree(targets, table);
        }
    } finally {
        // Whatever the reading could not find or refused: git itself still ends.
        for (const child of running) child.kill();
    }
}

/** The read, or a {@link GitDidNotAnswer} at the limit, and then what it started is ended. */
export function withinGitLimit<T>(run: (limit: GitLimit) => Promise<T>, tree: ProcessTree = systemProcessTree): Promise<T> {
    const children: ChildProcess[] = [];
    let over = false;
    const limit: GitLimit = {
        git: (args, options, callback) => {
            if (over) { callback(new GitDidNotAnswer(), '', ''); return null; }
            const child = execFile(resolveProgram('git'), [...args], { windowsHide: true, ...options }, callback);
            children.push(child);
            return child;
        },
    };
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            over = true;
            reject(new GitDidNotAnswer());
            void endGitTrees(children, tree).catch((error: unknown) => console.error(`[git] what a read started could not be ended: ${error instanceof Error ? error.message : String(error)}`));
        }, GIT_READ_LIMIT.ms);
        run(limit).then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error: unknown) => { clearTimeout(timer); reject(error); },
        );
    });
}

/**
 * THE GIT PORTS (§6.1): what the workspace ops call for `git init` and `git clone`. One place, so the
 * real git is measured by one test rather than trusted through main.ts. A clone that fails rejects
 * with git's OWN stderr — the reason a person reads — never a bare exit code.
 */

export function gitInit(path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        execFile(resolveProgram('git'), ['init'], { cwd: path, windowsHide: true }, (error, _stdout, stderr) => (error ? reject(new Error(String(stderr ?? error.message).trim() || error.message)) : resolve()));
    });
}

/** One git command in a folder; rejects with git's own words. */
function git(cwd: string, args: readonly string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        execFile(resolveProgram('git'), [...args], { cwd, windowsHide: true }, (error, stdout, stderr) => (error ? reject(new Error(String(stderr ?? error.message).trim() || error.message)) : resolve(String(stdout))));
    });
}

/** A config value as git resolves it in that folder (repository, global, system); `null` when it has none. */
function gitConfigValue(cwd: string, key: string): Promise<string | null> {
    return git(cwd, ['config', '--get', key]).then((v) => v.trim(), () => null);
}

/**
 * A NEW WORKSPACE'S FIRST COMMIT — the Add workspace card's promise, "Genie makes the folder and its first commit"
 * (Genie 1's createAgiEnvelope): `git init` on `main` whatever the machine's init.defaultBranch, everything in the folder
 * staged (it holds only what Genie just wrote, and its .gitignore keeps sandbox/ and .trash/ out), one commit. A machine
 * with no identity commits as Genie's bot (core/add-workspace.ts commitIdentityConfig) through `-c` for THIS command:
 * Genie 1 wrote the fallback into the repository's config, which then signed the person's own later commits as the bot.
 */
export async function gitFirstCommit(path: string, message: string): Promise<void> {
    await git(path, ['init', '--quiet', '--initial-branch=main']);
    await gitCommit(path, message);
}

/**
 * Everything in the folder staged, one commit — with Genie's bot identity for THIS command only when the machine has
 * none, as the first commit does. For an envelope Genie is still making (the Tynn import's submodules).
 */
export async function gitCommit(path: string, message: string): Promise<void> {
    const identity = commitIdentityConfig({ name: await gitConfigValue(path, 'user.name'), email: await gitConfigValue(path, 'user.email') });
    await git(path, ['add', '--all', '--', '.']);
    await git(path, [...identity.flatMap(([k, v]) => ['-c', `${k}=${v}`]), 'commit', '--quiet', '-m', message]);
}

/** A git command with per-command config in its environment (see gitClone); rejects with git's words, secrets scrubbed. */
function gitWithAuth(cwd: string | undefined, args: readonly string[], auth?: GitAuth): Promise<string> {
    const env: NodeJS.ProcessEnv | undefined = auth && auth.config.length > 0 ? { ...process.env, ...gitConfigEnv(auth.config) } : undefined;
    const scrub = (text: string) => redactSecrets(text, auth?.secrets ?? []);
    return new Promise<string>((resolve, reject) => {
        execFile(resolveProgram('git'), [...args], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) }, (error, stdout, stderr) =>
            (error ? reject(new Error(scrub(String(stderr ?? error.message).trim() || error.message))) : resolve(String(stdout))));
    });
}

/**
 * A REPOSITORY AS A SUBMODULE of an envelope Genie is making (Add workspace parity item 3; Genie 1's build, create-agi.ts):
 * `git submodule add [-b <branch>] -- <url> <at>`, with the clone credential as gitClone carries it. With a branch, git
 * records it in .gitmodules itself; without one, the branch the remote checked out is recorded — what Genie 1 did, minus
 * its guessed `main` for a detached HEAD (then nothing is recorded). Resolves to the branch tracked, or `null`.
 *
 * `local`: the source is a folder on disk (Open existing folder's "Local", Add workspace parity item 7), which git refuses
 * to clone a submodule from since 2.38 (CVE-2022-39253) without `protocol.file.allow=always` — Genie 1 set it through
 * GIT_CONFIG_* for that one command (create-agi.ts:1063-1070), and so does this, beside the credential, never in a config
 * file. A path-like URL gets it too, as Genie 1 sniffed it.
 */
export async function gitAddSubmodule(envelope: string, url: string, at: string, branch: string | null, auth?: GitAuth, local = false): Promise<string | null> {
    const fileAllowed: GitAuth | undefined = local || isLocalPathLike(url) ? { config: [...(auth?.config ?? []), ['protocol.file.allow', 'always']], secrets: auth?.secrets ?? [] } : auth;
    await gitWithAuth(envelope, ['submodule', 'add', '--quiet', ...(branch ? ['-b', branch] : []), '--', url, at], fileAllowed);
    if (branch) return branch;
    const head = await git(join(envelope, ...at.split('/')), ['symbolic-ref', '--quiet', '--short', 'HEAD']).then((v) => v.trim() || null, () => null);
    // The submodule's name is its path (git's default for `submodule add`).
    if (head) await git(envelope, ['config', '-f', '.gitmodules', `submodule.${at}.branch`, head]);
    return head;
}

/**
 * A credential for one git command: config carried in git's environment and the secrets to scrub from its words. `url`,
 * when present, is what a CLONE fetches instead of the URL it was given — the HTTPS twin of a github.com SSH URL the
 * sign-in covers (core/github.ts cloneAuthFor; Add workspace parity item 8). A submodule add keeps its URL as given, so
 * `.gitmodules` records what the person chose.
 */
export interface GitAuth { url?: string; config: ReadonlyArray<readonly [string, string]>; secrets: readonly string[] }

/**
 * A NEW ENVELOPE'S REMOTE (Add workspace parity item 11): `git remote add origin <url>`. The URL comes after `--`, so a
 * pasted one can never be read as an option of git's. Rejects with git's own words.
 */
export async function gitSetOrigin(path: string, url: string): Promise<void> {
    await git(path, ['remote', 'add', '--', 'origin', url]);
}

/**
 * `git push -u origin main` (Genie 1's pushEnvelopeToOrigin): `-u` so a later plain `git push` / `git pull` in the
 * workspace just works. `auth` is the GitHub sign-in's credential where the App may write there (core/github.ts
 * pushAuthFor), carried through git's environment for this one command as the clone's is; otherwise the person's own
 * credential helper or ssh agent answers. Rejects with git's words, every secret scrubbed.
 */
export async function gitPushMain(path: string, auth?: GitAuth): Promise<void> {
    await gitWithAuth(path, ['push', '--quiet', '-u', 'origin', 'main'], auth);
}

/**
 * `git clone`, optionally with config for THIS command only — the GitHub sign-in's credential (core/github.ts
 * cloneAuthFor). The config rides git's GIT_CONFIG_COUNT/KEY_n/VALUE_n environment (git ≥ 2.31), not `-c` arguments:
 * a process's arguments are readable by every user on the machine, its environment only by the same user. Nothing is
 * written into the clone's .git/config. Every secret is scrubbed out of git's words before they go anywhere.
 *
 * `--recurse-submodules`, as Genie 1 cloned (clone.ts, create-agi.ts): an envelope's code lives in submodules under
 * repos/, and a clone without them is an envelope of empty folders. git keeps GIT_CONFIG_COUNT/KEY/VALUE in the
 * environment of the submodule clones it spawns, so the credential reaches a private envelope's private submodules too
 * (measured by test/git-ports.test.ts with real git).
 *
 * `branch`: the one to check out (Tynn's `default_branch` for the envelope it names); none = the remote's HEAD.
 */
export function gitClone(url: string, into: string, auth?: GitAuth, branch?: string | null): Promise<void> {
    return gitWithAuth(undefined, ['clone', '--recurse-submodules', ...(branch ? ['--branch', branch] : []), '--', auth?.url ?? url, into], auth).then(() => {});
}

/** Config entries as git's environment: GIT_CONFIG_COUNT and GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n, appended after any already there. */
function gitConfigEnv(config: ReadonlyArray<readonly [string, string]>): Record<string, string> {
    const base = Number(process.env.GIT_CONFIG_COUNT ?? '0') || 0;
    const env: Record<string, string> = { GIT_CONFIG_COUNT: String(base + config.length) };
    config.forEach(([key, value], i) => {
        env[`GIT_CONFIG_KEY_${base + i}`] = key;
        env[`GIT_CONFIG_VALUE_${base + i}`] = value;
    });
    return env;
}

export interface GitCommit { sha: string; subject: string; author: string; at: number }

export type GitFileState = 'committed' | 'modified' | 'untracked';

/**
 * A file's text as of the last commit of its OWN repository (`git show HEAD:./<name>` in its folder), or `null` —
 * not committed, not a repository, no commits yet. The baseline git keeps for a change nobody reported.
 */
export function gitShowHead(root: string, rel: string): Promise<string | null> {
    const parts = rel.split('/');
    const name = parts.pop() ?? rel;
    const cwd = join(root, ...parts);
    return gitMayRun(cwd).then((may) => (!may ? null : withinGitLimit((limit) => new Promise<string | null>((resolve) => {
        limit.git(['show', `HEAD:./${name}`], { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout)));
    }))));
}

/**
 * One file's state in its OWN repository (git walks up from the file's folder, so a file inside a submodule answers
 * for the submodule): `committed` (tracked, unchanged), `modified` (tracked, uncommitted changes), `untracked`.
 * `null` when git says nothing — not a repository, or an ignored file. Never a guess.
 */
export function gitFileStatus(root: string, rel: string): Promise<GitFileState | null> {
    const parts = rel.split('/');
    const name = parts.pop() ?? rel;
    const cwd = join(root, ...parts);
    return gitMayRun(cwd).then((may) => (!may ? null : withinGitLimit((limit) => new Promise<GitFileState | null>((resolve) => {
        limit.git(['status', '--porcelain=v1', '--', name], { cwd }, (error, stdout) => {
            if (error) { resolve(null); return; }
            const line = String(stdout).split('\n').find((l) => l.length > 0);
            if (line !== undefined) { resolve(line.startsWith('??') ? 'untracked' : 'modified'); return; }
            limit.git(['ls-files', '--error-unmatch', '--', name], { cwd }, (e2) => resolve(e2 ? null : 'committed'));
        });
    }))));
}

/**
 * The commits since a moment, newest first — `git log` itself, never a guess: the short sha, the subject, the author
 * name, the committer time. A folder that is not a repository (or has no commits) is an empty list, not an error:
 * "nothing to show" is the honest answer there.
 */
export function gitLogSince(path: string, sinceMs: number): Promise<GitCommit[]> {
    return gitMayRun(path).then((may) => (!may ? [] : withinGitLimit((limit) => new Promise<GitCommit[]>((resolve) => {
        limit.git(['log', `--since=${new Date(sinceMs).toISOString()}`, '--format=%h%x00%s%x00%an%x00%ct%x00'], { cwd: path }, (error, stdout) => {
            if (error) { resolve([]); return; }
            // NUL between fields: a commit's text cannot hold one, so a subject cannot shift the fields after it.
            const fields = String(stdout).split('\0');
            const commits: GitCommit[] = [];
            for (let i = 0; i + 3 < fields.length; i += 4) commits.push({ sha: fields[i]!.trim(), subject: fields[i + 1]!, author: fields[i + 2]!, at: Number(fields[i + 3]!) * 1000 });
            resolve(commits);
        });
    }))));
}

/** A changed file's state, as the tree colours it (beta.33 item 15; Genie 1 FileTree's git colours). */
export type GitTreeState = 'modified' | 'added' | 'deleted' | 'untracked';

/**
 * Every changed file under a workspace, by its git state, in ONE `git status` (Genie 1's `files.gitStatus`). Paths are
 * relative to the WORKSPACE — which may sit inside a larger repository, so git's repo-relative paths are re-based on the
 * workspace's prefix and anything outside it is dropped. Not a repository: an empty map, "nothing to show".
 */
export function gitTreeStatus(root: string): Promise<Record<string, GitTreeState>> {
    return gitMayRun(root).then((may) => (!may ? {} : withinGitLimit((limit) => new Promise((resolve) => {
        limit.git(['rev-parse', '--show-prefix'], { cwd: root }, (error, prefixOut) => {
            if (error) { resolve({}); return; }
            const prefix = String(prefixOut).trim();
            limit.git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], { cwd: root, maxBuffer: 32 * 1024 * 1024 }, (e2, stdout) => {
                if (e2) { resolve({}); return; }
                const out: Record<string, GitTreeState> = {};
                const fields = String(stdout).split('\0');
                for (let i = 0; i < fields.length; i++) {
                    const entry = fields[i]!;
                    if (entry.length < 4) continue;
                    const x = entry[0]!;
                    const y = entry[1]!;
                    const path = entry.slice(3);
                    // A rename or copy carries its ORIGINAL path in the next field; the entry's own path is the new one.
                    if (x === 'R' || x === 'C') i++;
                    if (!path.startsWith(prefix)) continue;
                    const rel = path.slice(prefix.length);
                    if (rel === '') continue;
                    out[rel] = x === '?' ? 'untracked' : x === 'D' || y === 'D' ? 'deleted' : x === 'A' ? 'added' : 'modified';
                }
                resolve(out);
            });
        });
    }))));
}
