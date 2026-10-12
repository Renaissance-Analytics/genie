import { execFile } from 'node:child_process';

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

export function gitClone(url: string, into: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        execFile('git', ['clone', '--', url, into], { windowsHide: true }, (error, _stdout, stderr) => (error ? reject(new Error(String(stderr ?? error.message).trim() || error.message)) : resolve()));
    });
}

export interface GitCommit { sha: string; subject: string; author: string; at: number }

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
