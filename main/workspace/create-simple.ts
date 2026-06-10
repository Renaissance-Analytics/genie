import fs from 'fs';

/**
 * "Simple" workspaces register an existing folder. No file system writes,
 * no git operations. Just verify the path exists.
 */
export interface CreateSimpleOpts {
    path: string;
}

export function validateSimpleWorkspace(opts: CreateSimpleOpts): void {
    if (!fs.existsSync(opts.path)) {
        throw new Error(`Folder does not exist: ${opts.path}`);
    }
    const stat = fs.statSync(opts.path);
    if (!stat.isDirectory()) {
        throw new Error(`Path is not a directory: ${opts.path}`);
    }
}
