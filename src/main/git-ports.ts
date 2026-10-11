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
