import { SYSTEM_WORKSPACE_ID, type WorkspaceRow } from './genie';
import { projectPickerOptions, type PickerOption, type PickerProject } from './project-picker';

/**
 * Where the Feedback modal files, and for which workspace (genie#675).
 */

/**
 * The Tynn project a workspace's feedback goes to, or '' when it has none.
 *
 * A `none` workspace (System, a GApp) may hold a manifest id in these columns;
 * that is never a Tynn project, so there is nowhere to file (genie#679).
 */
export function feedbackProjectFor(
    workspace: Pick<WorkspaceRow, 'backend' | 'tynn_project_id' | 'project_id'>,
): string {
    if (workspace.backend === 'none') return '';
    return workspace.tynn_project_id || workspace.project_id || '';
}

/**
 * The workspace the global Feedback hotkey opens for: the active one, else the
 * System workspace, which always exists once Genie has booted. Null only when
 * there is no row at all.
 */
export function feedbackWorkspaceFor(
    activeWorkspaceId: string | null,
    workspacesById: ReadonlyMap<string, WorkspaceRow>,
): WorkspaceRow | null {
    const active = activeWorkspaceId ? workspacesById.get(activeWorkspaceId) : undefined;
    return active ?? workspacesById.get(SYSTEM_WORKSPACE_ID) ?? null;
}

/**
 * Options for the Feedback modal's project picker.
 *
 * The selected project is always among them. A native `<select>` whose value
 * matches no option DISPLAYS the first one, so a linked project the list has not
 * got (still loading, or no longer visible to this person) would otherwise show
 * one project on screen while the send files to another.
 */
export function feedbackProjectOptions(
    projects: readonly PickerProject[],
    selectedId: string,
    selectedName: string,
): PickerOption[] {
    const options = projectPickerOptions(projects);
    if (!selectedId || options.some((o) => o.value === selectedId)) return options;
    return [{ value: selectedId, label: selectedName || selectedId }, ...options];
}
