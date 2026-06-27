import fs from 'fs';
import path from 'path';
import { simpleGit } from 'simple-git';

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
 * down whole. The clone uses the user's ambient git auth (SSH agent / credential
 * helper), exactly like cloning from a terminal, so private repos work without
 * Genie handling secrets. Refuses a non-empty destination so an existing folder
 * is never clobbered.
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

    try {
        // simple-git clone: (repo, localPath, opts). Created here, in the parent,
        // so git makes the destination folder for us.
        await simpleGit({ baseDir: opts.parent_path }).clone(url, dest, [
            '--recurse-submodules',
        ]);
    } catch (e) {
        throw new Error(
            `Clone failed: ${(e as Error).message}. Check the URL and that you have ` +
                'access (SSH key / credential helper) to the repository.',
        );
    }

    return { path: dest };
}
