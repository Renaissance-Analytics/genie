/**
 * IPC surface for the Repository panel (`repo:*`). Thin wrappers over the
 * host-side git binding in `index.ts` — one implementation, invoked by the
 * renderer's `RepoChangesPanel` adapter through the preload bridge. Every op
 * takes the workspace root + a workspace-relative repo folder (contained
 * host-side before it reaches git).
 */
import { ipcMain } from 'electron';
import {
    discoverRepos,
    repoStatus,
    repoDiff,
    repoStage,
    repoUnstage,
    repoCommit,
    repoPush,
    repoPull,
    repoCreateBranch,
} from './index';

export function registerRepoIpc(): void {
    ipcMain.handle('repo:list', (_e, workspaceRoot: string) => discoverRepos(workspaceRoot));
    ipcMain.handle('repo:status', (_e, workspaceRoot: string, repoRel: string) =>
        repoStatus(workspaceRoot, repoRel),
    );
    ipcMain.handle(
        'repo:diff',
        (_e, workspaceRoot: string, repoRel: string, filePath: string, staged: boolean) =>
            repoDiff(workspaceRoot, repoRel, filePath, staged),
    );
    ipcMain.handle('repo:stage', (_e, workspaceRoot: string, repoRel: string, paths: string[]) =>
        repoStage(workspaceRoot, repoRel, paths),
    );
    ipcMain.handle('repo:unstage', (_e, workspaceRoot: string, repoRel: string, paths: string[]) =>
        repoUnstage(workspaceRoot, repoRel, paths),
    );
    ipcMain.handle('repo:commit', (_e, workspaceRoot: string, repoRel: string, message: string) =>
        repoCommit(workspaceRoot, repoRel, message),
    );
    ipcMain.handle('repo:push', (_e, workspaceRoot: string, repoRel: string, remote?: string) =>
        repoPush(workspaceRoot, repoRel, remote),
    );
    ipcMain.handle('repo:pull', (_e, workspaceRoot: string, repoRel: string) =>
        repoPull(workspaceRoot, repoRel),
    );
    ipcMain.handle('repo:create-branch', (_e, workspaceRoot: string, repoRel: string, name: string) =>
        repoCreateBranch(workspaceRoot, repoRel, name),
    );
}
