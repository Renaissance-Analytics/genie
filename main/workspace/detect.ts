import fs from 'fs';
import path from 'path';

/**
 * Classify a folder per the public `.agi` format contract documented in
 * `docs/agi-format.md` §Detection.
 *
 *   - EMPTY           — nothing useful at the path
 *   - SIMPLE_REPO     — a plain git repo (or non-git folder), not an envelope
 *   - PRE_INIT        — `repos/<name>/.git` exists but no root `.git`
 *   - FULL_ENVELOPE   — root `.git` + `.gitmodules` + `project.json`
 */

export type FolderState =
    | 'EMPTY'
    | 'SIMPLE_REPO'
    | 'PRE_INIT'
    | 'FULL_ENVELOPE';

export interface DetectResult {
    state: FolderState;
    has_project_json: boolean;
    has_root_git: boolean;
    has_gitmodules: boolean;
    repos: string[]; // names of subfolders inside repos/ that are git repos
}

export function detectFolder(folderPath: string): DetectResult {
    if (!fs.existsSync(folderPath)) {
        return {
            state: 'EMPTY',
            has_project_json: false,
            has_root_git: false,
            has_gitmodules: false,
            repos: [],
        };
    }

    const has_project_json = fs.existsSync(
        path.join(folderPath, 'project.json'),
    );
    const has_root_git = fs.existsSync(path.join(folderPath, '.git'));
    const has_gitmodules = fs.existsSync(
        path.join(folderPath, '.gitmodules'),
    );

    const reposDir = path.join(folderPath, 'repos');
    let repos: string[] = [];
    if (fs.existsSync(reposDir) && fs.statSync(reposDir).isDirectory()) {
        repos = fs
            .readdirSync(reposDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .filter((d) =>
                fs.existsSync(path.join(reposDir, d.name, '.git')),
            )
            .map((d) => d.name);
    }

    if (has_root_git && (has_project_json || has_gitmodules)) {
        return {
            state: 'FULL_ENVELOPE',
            has_project_json,
            has_root_git,
            has_gitmodules,
            repos,
        };
    }
    if (!has_root_git && repos.length > 0) {
        return {
            state: 'PRE_INIT',
            has_project_json,
            has_root_git,
            has_gitmodules,
            repos,
        };
    }
    if (has_root_git) {
        return {
            state: 'SIMPLE_REPO',
            has_project_json,
            has_root_git,
            has_gitmodules,
            repos,
        };
    }
    return {
        state: 'EMPTY',
        has_project_json,
        has_root_git,
        has_gitmodules,
        repos,
    };
}
