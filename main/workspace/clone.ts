import fs from 'fs';
import path from 'path';
import { simpleGit } from 'simple-git';
import { getToken } from '../github/storage';
import { githubCloneAuth, redactSecrets } from './git-auth';

/** Derive a destination folder name from a git URL (the repo leaf, sans .git). */
export function repoNameFromUrl(url: string): string {
    const trimmed = url.trim().replace(/[/]+$/, '');
    const leaf = trimmed.split(/[/:]/).pop() ?? '';
    return leaf.replace(/\.git$/i, '') || 'repo';
}

export interface CloneRepoOpts {
    url: string;
    parent_path: string;
    /** Override the destination folder name (defaults to the repo leaf). */
    folder?: string;
}

/**
 * Clone a remote git repo into `parent_path/<folder>` and return the local path
 * — so the Add-workspace "Simple" flow can register a REMOTE repo as a source,
 * not just a local folder. Recurses submodules so an envelope-shaped repo comes
 * down whole. When Genie holds a GitHub token, the WHOLE recursive tree (the
 * envelope + every private submodule) authenticates over HTTPS with that token,
 * so a user without SSH keys / a credential helper still clones private repos;
 * with no token it falls back to the user's ambient git auth exactly as before.
 * Refuses a non-empty destination so an existing folder is never clobbered.
 */
export async function cloneRepo(opts: CloneRepoOpts): Promise<{ path: string }> {
    const url = opts.url.trim();
    if (!url) throw new Error('A repository URL is required.');
    if (!opts.parent_path?.trim()) {
        throw new Error('A destination folder is required.');
    }

    const folder = opts.folder?.trim() || repoNameFromUrl(url);
    const dest = path.join(opts.parent_path, folder);
    if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
        throw new Error(`Target folder "${dest}" is not empty. Choose an empty location.`);
    }
    fs.mkdirSync(opts.parent_path, { recursive: true });

    // Authenticate the recursive clone with Genie's GitHub token when present
    // (rewrites a github SSH URL → HTTPS + injects the token for every
    // github.com fetch, submodules included); no-op when there's no token.
    const auth = githubCloneAuth(url, getToken());
    try {
        // simple-git clone: (repo, localPath, opts). Created here, in the parent,
        // so git makes the destination folder for us. `config` becomes leading
        // `-c` args that also propagate to submodule fetches.
        await simpleGit({ baseDir: opts.parent_path, config: auth.config }).clone(
            auth.url,
            dest,
            ['--recurse-submodules'],
        );
    } catch (e) {
        // Scrub the token from the git error before it's surfaced/logged.
        throw new Error(
            `Clone failed: ${redactSecrets((e as Error).message, auth.secrets)}. Check the URL ` +
                'and that you have access to the repository (connect GitHub in Settings, ' +
                'or set up an SSH key / credential helper).',
        );
    }

    return { path: dest };
}
