import { listTerminalSpecs, listWorkspaces, type TerminalSpecRow } from '../db';
import { getProcessStatuses } from './process-supervisor';
import type { ProcessStatus } from './process-lifecycle';

/**
 * Cross-workspace process aggregation for the Task Manager — EVERY background
 * process Genie has spawned, across ALL workspaces plus the synthetic System
 * Workspace, each row tagged with the workspace that spawned it.
 *
 * Processes are `terminal_specs` of type 'process'. Their owning workspace is
 * already recorded on the spec (`workspace_id`); a System-Workspace process
 * persists with `workspace_id: null` + `meta.system === true` (the System
 * Workspace is synthetic and has no `workspaces` row), so those map to the
 * "System" label here.
 */

/** Label for System-Workspace processes (workspace_id null + meta.system). */
export const SYSTEM_WORKSPACE_LABEL = 'System';

/** One process row for the Task Manager: spec + owning workspace + live status. */
export interface ProcessListItem {
    id: string;
    label: string;
    command: string;
    /** The spawning workspace's name, or "System" for system-workspace procs. */
    workspace: string;
    /** The spawning workspace's id, or null for system-workspace procs. */
    workspaceId: string | null;
    status: ProcessStatus;
    autostart: boolean;
}

/**
 * Pure join of process specs + workspace names + live statuses into the
 * Task Manager rows. Kept side-effect-free (the db/supervisor reads are passed
 * in) so it's unit-testable without electron.
 *
 * @param specs       Every terminal spec (filtered to 'process' here).
 * @param workspaceNames  workspace id → display name.
 * @param statuses    id → live status from the supervisor (default 'stopped').
 */
export function buildProcessList(
    specs: TerminalSpecRow[],
    workspaceNames: Map<string, string>,
    statuses: Record<string, ProcessStatus>,
): ProcessListItem[] {
    return specs
        .filter((s) => s.type === 'process')
        .map((s) => ({
            id: s.id,
            label: s.label,
            command: s.meta?.command ?? '',
            // A process with no workspace_id is a System-Workspace process; a
            // workspace_id with no matching name (a since-removed workspace)
            // also falls back to System rather than showing a dangling id.
            workspace: s.workspace_id
                ? workspaceNames.get(s.workspace_id) ?? SYSTEM_WORKSPACE_LABEL
                : SYSTEM_WORKSPACE_LABEL,
            workspaceId: s.workspace_id,
            status: statuses[s.id] ?? 'stopped',
            autostart: s.meta?.autostart === true,
        }));
}

/** Live Task Manager rows: every spawned process across every workspace. */
export function listAllProcesses(): ProcessListItem[] {
    const names = new Map<string, string>();
    for (const w of listWorkspaces()) names.set(w.id, w.project_name);
    return buildProcessList(listTerminalSpecs(), names, getProcessStatuses());
}
