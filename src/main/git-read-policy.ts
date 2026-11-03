import { execFile } from 'node:child_process';
import { resolveProgram } from '../core/program-lookup.js';
import { parseGitConfigList, unsafeGitKeys, type GitConfigEntry } from '../core/workspace-trust.js';

/**
 * WHETHER GIT MAY RUN IN A FOLDER. A folder's own git config can name programs that an ordinary `git status` or `git diff` runs, so in a folder the person has not trusted, Genie reads that config first, and runs no git there if it holds a key
 * that could run something. Reading it runs nothing (measured on Linux and Windows). `--includes` and `--worktree` are both needed: `--local` alone does not show what an included file or a worktree config says.
 *
 * Every git read goes through {@link gitMayRun}. Until a policy is set (a test, or before composition) git runs as it always did.
 */
export type GitReadPolicy = (cwd: string) => Promise<boolean>;

let policy: GitReadPolicy | null = null;

export function setGitReadPolicy(next: GitReadPolicy | null): void {
    policy = next;
}

export function gitMayRun(cwd: string): Promise<boolean> {
    return policy ? policy(cwd) : Promise.resolve(true);
}

/** What a refused git action says. */
export const GIT_NEEDS_TRUST = "This folder's git config can run commands, so Genie runs no git here until you trust this workspace.";

const listing = (cwd: string, scope: '--local' | '--worktree'): Promise<GitConfigEntry[]> => new Promise((resolve) => {
    execFile(resolveProgram('git'), ['config', scope, '--includes', '--list', '-z'], { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        resolve(error ? [] : parseGitConfigList(String(stdout)));
    });
});

/** A folder's own git config, as git itself resolves it: includes, the worktree's, a `.git` file's target, and a parent repository's when the folder is inside one. */
export async function folderGitConfig(cwd: string): Promise<GitConfigEntry[]> {
    const [local, worktree] = await Promise.all([listing(cwd, '--local'), listing(cwd, '--worktree')]);
    const seen = new Set<string>();
    return [...local, ...worktree].filter((entry) => {
        const id = `${entry.key}\n${entry.value}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });
}

/** Git runs in a trusted workspace, and in any other folder whose git config holds nothing that could run something. */
export function trustAwarePolicy(isTrusted: (cwd: string) => boolean): GitReadPolicy {
    return async (cwd) => {
        if (isTrusted(cwd)) return true;
        return unsafeGitKeys(await folderGitConfig(cwd)).length === 0;
    };
}
