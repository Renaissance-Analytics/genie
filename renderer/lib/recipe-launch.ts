import type { WorkspaceRow } from './genie';

/**
 * The scope a "Run a recipe" launch carries for the ACTIVE workspace:
 *   - `workspaceId` binds the recipe's tasks + (remote) terminals to it.
 *   - `defaultCwd` = the workspace's repo path, which the WizardModal uses as
 *     the fallback cwd for terminal steps that don't set their own — so a git
 *     recipe's `git`/`gh` commands run inside the repo, not an arbitrary dir.
 *
 * The launcher button is disabled when this is null, so a recipe never runs
 * unscoped. Kept as a pure helper (like shouldOpenWorkstationSetup) so the
 * scoping decision is unit-testable without a DOM.
 */
export interface RecipeLaunchScope {
    workspaceId: string;
    defaultCwd: string;
}

export function recipeLaunchScope(
    activeWorkspace: Pick<WorkspaceRow, 'id' | 'path'> | null | undefined,
): RecipeLaunchScope | null {
    if (!activeWorkspace || !activeWorkspace.path) return null;
    return { workspaceId: activeWorkspace.id, defaultCwd: activeWorkspace.path };
}

/** Whether the "Run a recipe" affordance should be enabled. */
export function canRunRecipe(
    activeWorkspace: Pick<WorkspaceRow, 'id' | 'path'> | null | undefined,
): boolean {
    return recipeLaunchScope(activeWorkspace) !== null;
}
