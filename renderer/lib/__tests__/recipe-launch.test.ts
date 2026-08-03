import { describe, expect, it } from 'vitest';
import { canRunRecipe, recipeLaunchScope } from '../recipe-launch';
import type { WorkspaceRow } from '../genie';

/**
 * The "Run a recipe" toolbar affordance is scoped to the ACTIVE workspace: it
 * passes the workspace id (so recipe tasks/remote terminals bind to it) and the
 * workspace's repo path as the WizardModal's default cwd (so a recipe's `git`/
 * `gh` terminal steps run in the repo). This is the pure decision behind the
 * button's enablement + the props the launcher receives — the impure render is
 * in master.tsx. Mirrors how shouldOpenWorkstationSetup / issueWatchBadge keep
 * the decision out of the component so it can be unit-tested without a DOM.
 */
function ws(over: Partial<WorkspaceRow> = {}): WorkspaceRow {
    return {
        id: 'ws-a',
        backend: 'tynn',
        project_id: 'p1',
        project_name: 'Repo',
        tynn_project_id: 'p1',
        tynn_project_name: 'Repo',
        shape: 'agi',
        path: 'C:/repos/repo',
        editor: null,
        editor_cmd: null,
        start_cmd: null,
        env_file: null,
        last_opened_at: null,
        created_by_genie: 1,
        ...over,
    } as WorkspaceRow;
}

describe('recipeLaunchScope', () => {
    it('scopes a launch to the active workspace id + its repo path', () => {
        expect(recipeLaunchScope(ws())).toEqual({
            workspaceId: 'ws-a',
            defaultCwd: 'C:/repos/repo',
        });
    });

    it('returns null when there is no active workspace', () => {
        expect(recipeLaunchScope(undefined)).toBeNull();
        expect(recipeLaunchScope(null)).toBeNull();
    });

    it('returns null when the active workspace has no path (nothing to cwd into)', () => {
        expect(recipeLaunchScope(ws({ path: '' }))).toBeNull();
    });

    it('carries a different workspace + path faithfully', () => {
        expect(recipeLaunchScope(ws({ id: 'ws-b', path: '/home/x/proj' }))).toEqual({
            workspaceId: 'ws-b',
            defaultCwd: '/home/x/proj',
        });
    });
});

describe('canRunRecipe', () => {
    it('enables the affordance only when a scoped launch is possible', () => {
        expect(canRunRecipe(ws())).toBe(true);
        expect(canRunRecipe(undefined)).toBe(false);
        expect(canRunRecipe(null)).toBe(false);
        expect(canRunRecipe(ws({ path: '' }))).toBe(false);
    });
});
