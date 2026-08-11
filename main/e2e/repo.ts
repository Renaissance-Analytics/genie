import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { addWorkspace, getWorkspace, removeWorkspace } from '../db';

/**
 * Deterministic fixture for the REPOSITORY PANEL E2E spec (e2e/repo-panel.spec.ts).
 *
 * Like the agent-access harness this mocks NO IPC — the point is to exercise the
 * REAL chain: `repo:*` host git binding (main/repo/*) → preload → the
 * RepoChangesPanel adapter (vetted fancy-git-ui components) → back. All it needs
 * is a real git repo with real changes to act on, and a workspace row pointing at
 * it so the harness page can discover it via `workspaces.list()`.
 *
 * IDEMPOTENT AND RESETTING: the E2E profile is reused across runs, so the temp
 * repo is recreated from scratch each seed (fixed working-tree changes) and the
 * workspace row is re-inserted — otherwise a prior run's commit would leave the
 * tree clean and the "a changed file shows up" assertion would silently pass on
 * nothing.
 */

const WORKSPACE_ID = 'e2e-repo-panel';
const WORKSPACE_NAME = 'Repo Panel E2E';

export interface RepoSeed {
    workspaceId: string;
    workspaceName: string;
    repoPath: string;
    /** The tracked file left with an unstaged modification (has a real diff). */
    modifiedFile: string;
    /** The untracked file. */
    untrackedFile: string;
}

function git(cwd: string, args: string[]): void {
    execFileSync('git', args, {
        cwd,
        stdio: 'ignore',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Genie E2E',
            GIT_AUTHOR_EMAIL: 'e2e@genie.test',
            GIT_COMMITTER_NAME: 'Genie E2E',
            GIT_COMMITTER_EMAIL: 'e2e@genie.test',
            GIT_CONFIG_GLOBAL: os.devNull,
            GIT_CONFIG_SYSTEM: os.devNull,
        },
    });
}

/**
 * Create the fixture git repo (initial commit, then one unstaged tracked
 * modification + one untracked file) and the workspace row that targets it.
 */
export function seedRepoE2E(): RepoSeed {
    const repoPath = path.join(os.tmpdir(), 'genie-e2e-repo-panel');
    fs.rmSync(repoPath, { recursive: true, force: true });
    fs.mkdirSync(repoPath, { recursive: true });

    git(repoPath, ['init', '-b', 'main']);
    git(repoPath, ['config', 'user.email', 'e2e@genie.test']);
    git(repoPath, ['config', 'user.name', 'Genie E2E']);
    git(repoPath, ['config', 'commit.gpgsign', 'false']);

    fs.writeFileSync(path.join(repoPath, 'readme.md'), 'hello\nworld\n');
    fs.writeFileSync(path.join(repoPath, 'keep.txt'), 'unchanged\n');
    git(repoPath, ['add', '-A']);
    git(repoPath, ['commit', '-m', 'init']);

    // A tracked modification (a real diff) + an untracked file (a status entry).
    fs.writeFileSync(path.join(repoPath, 'readme.md'), 'hello\nworld\nchanged line\n');
    fs.writeFileSync(path.join(repoPath, 'untracked.txt'), 'brand new\n');

    if (getWorkspace(WORKSPACE_ID)) removeWorkspace(WORKSPACE_ID);
    addWorkspace({
        id: WORKSPACE_ID,
        backend: 'aionima',
        project_id: WORKSPACE_ID,
        project_name: WORKSPACE_NAME,
        tynn_project_id: WORKSPACE_ID,
        tynn_project_name: WORKSPACE_NAME,
        shape: 'simple',
        path: repoPath,
        editor: null,
        editor_cmd: null,
        start_cmd: null,
        env_file: null,
        last_opened_at: null,
        created_by_genie: 0,
        sort_order: 0,
    });

    const seed: RepoSeed = {
        workspaceId: WORKSPACE_ID,
        workspaceName: WORKSPACE_NAME,
        repoPath,
        modifiedFile: 'readme.md',
        untrackedFile: 'untracked.txt',
    };
    (globalThis as Record<string, unknown>).__GENIE_E2E_REPO__ = seed;
    return seed;
}

/** The workspace the harness page mounts the panel for. */
export function repoPanelWorkspaceId(): string {
    return WORKSPACE_ID;
}
