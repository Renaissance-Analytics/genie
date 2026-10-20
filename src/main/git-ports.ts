import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { redactSecrets } from '../core/github.js';

/**
 * THE GIT PORTS (§6.1): what the workspace ops call for `git init` and `git clone`. One place, so the
 * real git is measured by one test rather than trusted through main.ts. A clone that fails rejects
 * with git's OWN stderr — the reason a person reads — never a bare exit code.
 */

export function gitInit(path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        execFile('git', ['init'], { cwd: path, windowsHide: true }, (error, _stdout, stderr) => (error ? reject(new Error(String(stderr ?? error.message).trim() || error.message)) : resolve()));
    });
}

/**
 * `git clone`, optionally with config for THIS command only — the GitHub sign-in's credential (core/github.ts
 * cloneAuthFor). The config rides git's GIT_CONFIG_COUNT/KEY_n/VALUE_n environment (git ≥ 2.31), not `-c` arguments:
 * a process's arguments are readable by every user on the machine, its environment only by the same user. Nothing is
 * written into the clone's .git/config. Every secret is scrubbed out of git's words before they go anywhere.
 */
export function gitClone(url: string, into: string, auth?: { config: ReadonlyArray<readonly [string, string]>; secrets: readonly string[] }): Promise<void> {
    const env: NodeJS.ProcessEnv | undefined = auth && auth.config.length > 0 ? { ...process.env, ...gitConfigEnv(auth.config) } : undefined;
    const scrub = (text: string) => redactSecrets(text, auth?.secrets ?? []);
    return new Promise<void>((resolve, reject) => {
        execFile('git', ['clone', '--', url, into], { windowsHide: true, ...(env ? { env } : {}) }, (error, _stdout, stderr) => (error ? reject(new Error(scrub(String(stderr ?? error.message).trim() || error.message))) : resolve()));
    });
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
    return new Promise<string | null>((resolve) => {
        execFile('git', ['show', `HEAD:./${name}`], { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout)));
    });
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
    return new Promise<GitFileState | null>((resolve) => {
        execFile('git', ['status', '--porcelain=v1', '--', name], { cwd, windowsHide: true }, (error, stdout) => {
            if (error) { resolve(null); return; }
            const line = String(stdout).split('\n').find((l) => l.length > 0);
            if (line !== undefined) { resolve(line.startsWith('??') ? 'untracked' : 'modified'); return; }
            execFile('git', ['ls-files', '--error-unmatch', '--', name], { cwd, windowsHide: true }, (e2) => resolve(e2 ? null : 'committed'));
        });
    });
}

/**
 * The commits since a moment, newest first — `git log` itself, never a guess: the short sha, the subject, the author
 * name, the committer time. A folder that is not a repository (or has no commits) is an empty list, not an error:
 * "nothing to show" is the honest answer there.
 */
export function gitLogSince(path: string, sinceMs: number): Promise<GitCommit[]> {
    return new Promise<GitCommit[]>((resolve) => {
        execFile('git', ['log', `--since=${new Date(sinceMs).toISOString()}`, '--format=%h%x1f%s%x1f%an%x1f%ct'], { cwd: path, windowsHide: true }, (error, stdout) => {
            if (error) { resolve([]); return; }
            resolve(String(stdout).split('\n').filter((line) => line.length > 0).map((line) => {
                const [sha, subject, author, ct] = line.split('\x1f');
                return { sha: sha ?? '', subject: subject ?? '', author: author ?? '', at: Number(ct ?? 0) * 1000 };
            }));
        });
    });
}
