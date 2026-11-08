import type { ExecFileOptions } from 'node:child_process';
import { gitExecFile, type GitChild } from './git-exec.js';
import { join } from 'node:path';
import { redactSecrets } from '../core/github.js';
import { commitIdentityConfig } from '../core/add-workspace.js';
import { isLocalPathLike } from '../core/envelope-plan.js';
import { findIn, systemProcessTree, type ProcessInfo, type ProcessTree } from '../core/process-tree.js';
import { resolveProgram } from '../core/program-lookup.js';
import { gitMayRun } from './git-read-policy.js';
import { winLauncherPath } from './win-launcher.js';

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
    git(args: readonly string[], options: ExecFileOptions, callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void): GitChild | null;
}

/**
 * Of `table`, every process that is ours: started by one of `ours` (by its parent's pid, and no earlier than that parent,
 * so a reused pid is not taken for a child) — whether or not that parent is still running, since Windows keeps a process's
 * parent id after the parent is gone. Added to `ours`; the newcomers are returned.
 */
function growOurs(ours: Map<number, ProcessInfo>, table: readonly ProcessInfo[]): ProcessInfo[] {
    const added: ProcessInfo[] = [];
    for (let changed = true; changed;) {
        changed = false;
        for (const p of table) {
            if (ours.has(p.pid)) continue;
            const parent = ours.get(p.ppid);
            if (parent && p.pid !== parent.pid && p.started >= parent.started) { ours.set(p.pid, p); added.push(p); changed = true; }
        }
    }
    return added;
}

/**
 * Readings taken while ending one read's tree, for what it started meanwhile, and the wall time they may take: a SAFETY
 * STOP on the walk, never a cap on how many are ended. Every process the walk finds is a descendant of our git by pid,
 * start time and name, so a big tree is still ours: a cap on the count would let a hook that forks past it keep running
 * in the repository (#1638's review).
 */
const GIT_TREE_ROUNDS = 8;
const GIT_TREE_WALL_MS = 10_000;
/** How long the limit waits for a read's launcher to be gone (its job closed) before the walk; it is ended at once. */
const GIT_JOB_END_WAIT_MS = 5_000;

/**
 * What the limit ends: git, and what git started under it, a hook's child above all, which keeps the folder open and
 * would never end by itself. NOTHING IT STARTED ESCAPES, even what it starts while it is being ended (the line's run after
 * #1637: git gone, and its hook's sh chain — git's second call of the hook — still running in the repository). One
 * reading, then the kill, left that window: whatever started between the two was in no reading.
 *
 * So the tree is taken from a first reading (git and every descendant, by parent pid and start time), then read AGAIN
 * after each round, and anything a process of ours started is ours too — until a reading finds nothing new. On Windows
 * each round ENDS what is known: a process keeps its parent's id when that parent is gone, so a child started at the last
 * moment is still found by it. Elsewhere each round STOPS what is known first (SIGSTOP: a stopped process starts nothing,
 * and its children keep their parent, where a killed parent's would be handed to init and lost to the walk); then all of
 * it ends together. Always through the tree's rules (`core/process-tree.ts`): the same process by pid, start time and
 * name, no `/T`. A child that a hook detached before the first reading is not found. A job object would close even that
 * (noted for #1628's launcher).
 */
async function endGitTrees(children: readonly GitChild[], tree: ProcessTree, platform: NodeJS.Platform = process.platform, jobs: ReadonlySet<GitChild> = new Set()): Promise<void> {
    const running = children.filter((child) => child.exitCode === null && child.signalCode === null && child.pid !== undefined);
    if (running.length === 0) return;
    // THE JOB FIRST, before anything in it (Windows, genie-launch.exe `job`). The launcher keeps its job's kill only while
    // git runs: when git ends, the launcher lifts the kill and exits, and what git started is left running. So git must
    // never end before its launcher. The walk below ended both at once, each by its own taskkill, and lost that race twice
    // in 20 runs (run 42363613581: all 230 of a hook's children alive 40 s after the limit). Ending the launcher here ends
    // its process with the kill still set, so the job ends everything in it. Waited for (bounded), then the walk takes
    // whatever is left outside the job.
    const jobbed = running.filter((child) => jobs.has(child));
    if (jobbed.length > 0) {
        await Promise.all(jobbed.map((child) => new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, GIT_JOB_END_WAIT_MS);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
            child.kill();
        })));
    }
    const read = async (): Promise<readonly ProcessInfo[] | null> => (tree.read ? tree.read() : tree.snapshot());
    // Every one identified is ended: the tree's count limit is lifted (it guards a session's guess, not a verified walk).
    const end = async (targets: readonly ProcessInfo[], now: readonly ProcessInfo[]): Promise<void> => {
        if (targets.length === 0) return;
        if (tree.reap) await tree.reap(targets, now, Number.MAX_SAFE_INTEGER);
        else tree.killTree(targets, now, Number.MAX_SAFE_INTEGER);
    };
    const stop = (targets: readonly ProcessInfo[], now: readonly ProcessInfo[]): void => {
        for (const p of targets) { if (findIn(now, p)) { try { process.kill(p.pid, 'SIGSTOP'); } catch { /* gone */ } } }
    };
    const ours = new Map<number, ProcessInfo>();
    try {
        let table = await read();
        if (table === null) return;
        const pids = new Set(running.map((child) => child.pid));
        for (const p of table) if (pids.has(p.pid)) ours.set(p.pid, p);
        growOurs(ours, table);
        const until = Date.now() + GIT_TREE_WALL_MS;
        for (let round = 0; round < GIT_TREE_ROUNDS && Date.now() < until; round += 1) {
            const known = [...ours.values()];
            if (platform === 'win32') await end(known, table);
            else stop(known, table);
            const next = await read();
            if (next === null) break;
            table = next;
            if (growOurs(ours, table).length === 0) break;
        }
        // Whatever of ours is still there, ended together (on Windows, what the last round missed; elsewhere, all of it).
        const left = [...ours.values()].filter((p) => findIn(table!, p));
        await end(left, table);
        if (ours.size > 24) console.error(`[git] a read past its limit had started ${ours.size} processes; all of them were ended`);
    } finally {
        // Whatever the readings could not find or refused: git itself still ends.
        for (const child of running) child.kill();
    }
}

/** The read, or a {@link GitDidNotAnswer} at the limit, and then what it started is ended. */
export function withinGitLimit<T>(run: (limit: GitLimit) => Promise<T>, tree: ProcessTree = systemProcessTree): Promise<T> {
    const children: GitChild[] = [];
    /** The children that are a launcher holding a job: ended first, before anything in their job (endGitTrees). */
    const jobs = new Set<GitChild>();
    let over = false;
    const limit: GitLimit = {
        git: (args, options, callback) => {
            if (over) { callback(new GitDidNotAnswer(), '', ''); return null; }
            // On Windows inside a kill-on-close job (genie-launch.exe, #1639): what git or a hook starts — MSYS background
            // children whose fork parent is gone included — is in the job, and ending the read ends the job.
            const launcher = winLauncherPath();
            // Created where git-exec.ts routes it: genie-host's spawn-host child (Tynn #532), or here.
            const child = launcher !== null
                ? gitExecFile(launcher, ['job', resolveProgram('git'), ...args], { windowsHide: true, ...options }, callback)
                : gitExecFile(resolveProgram('git'), [...args], { windowsHide: true, ...options }, callback);
            children.push(child);
            if (launcher !== null) jobs.add(child);
            return child;
        },
    };
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            over = true;
            reject(new GitDidNotAnswer());
            void endGitTrees(children, tree, process.platform, jobs).catch((error: unknown) => console.error(`[git] what a read started could not be ended: ${error instanceof Error ? error.message : String(error)}`));
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
        gitExecFile(resolveProgram('git'), ['init'], { cwd: path, windowsHide: true }, (error, _stdout, stderr) => (error ? reject(new Error(String(stderr ?? error.message).trim() || error.message)) : resolve()));
    });
}

/** One git command in a folder; rejects with git's own words. */
function git(cwd: string, args: readonly string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        gitExecFile(resolveProgram('git'), [...args], { cwd, windowsHide: true }, (error, stdout, stderr) => (error ? reject(new Error(String(stderr ?? error.message).trim() || error.message)) : resolve(String(stdout))));
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
        gitExecFile(resolveProgram('git'), [...args], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) }, (error, stdout, stderr) =>
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
