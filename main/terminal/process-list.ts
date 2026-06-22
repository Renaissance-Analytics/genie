import { terminalManager } from '@particle-academy/fancy-term-host';
import { listTerminalSpecs, listWorkspaces, type TerminalSpecRow } from '../db';
import { getProcessStatuses } from './process-supervisor';
import type { ProcessStatus } from './process-lifecycle';

/**
 * Cross-workspace task aggregation for the Task Manager — EVERYTHING Genie has
 * spawned across ALL workspaces plus the synthetic System Workspace: background
 * processes AND interactive terminals (every pty — shells, scratch terminals,
 * agent terminals). Each row is tagged with the workspace that spawned it.
 *
 * Tasks are `terminal_specs` of type 'process' (background) or 'terminal'
 * (interactive pty). 'code' specs are editor views — they execute nothing — so
 * they're excluded. The owning workspace is recorded on the spec
 * (`workspace_id`); a System-Workspace spec persists with `workspace_id: null`
 * + `meta.system === true` (the System Workspace is synthetic and has no
 * `workspaces` row), so those map to the "System" label here.
 */

/** Label for System-Workspace tasks (workspace_id null + meta.system). */
export const SYSTEM_WORKSPACE_LABEL = 'System';

/** One task row for the Task Manager: spec + owning workspace + live status. */
export interface ProcessListItem {
    id: string;
    /** Discriminates a background process from an interactive terminal/pty. */
    kind: 'process' | 'terminal';
    label: string;
    command: string;
    /** The spawning workspace's name, or "System" for system-workspace tasks. */
    workspace: string;
    /** The spawning workspace's id, or null for system-workspace tasks. */
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
    liveTerminalIds: ReadonlySet<string>,
): ProcessListItem[] {
    return specs
        .filter((s) => s.type === 'process' || s.type === 'terminal')
        .map((s): ProcessListItem => {
            const isProcess = s.type === 'process';
            return {
                id: s.id,
                kind: isProcess ? 'process' : 'terminal',
                label: s.label,
                // Processes carry a command; a terminal shows its shell + cwd.
                command: isProcess
                    ? s.meta?.command ?? ''
                    : [s.shell, s.live_cwd ?? s.cwd].filter(Boolean).join('  ·  '),
                // A spec with no workspace_id is a System-Workspace task; a
                // workspace_id with no matching name (a since-removed workspace)
                // also falls back to System rather than showing a dangling id.
                workspace: s.workspace_id
                    ? workspaceNames.get(s.workspace_id) ?? SYSTEM_WORKSPACE_LABEL
                    : SYSTEM_WORKSPACE_LABEL,
                workspaceId: s.workspace_id,
                // Processes report status via the supervisor; a terminal is
                // 'running' while its pty is live, else a saved-but-cold spec.
                status: isProcess
                    ? statuses[s.id] ?? 'stopped'
                    : liveTerminalIds.has(s.id)
                        ? 'running'
                        : 'stopped',
                autostart: s.meta?.autostart === true,
            };
        });
}

/** Live Task Manager rows: every spawned process + terminal across every workspace. */
export function listAllProcesses(): ProcessListItem[] {
    const names = new Map<string, string>();
    for (const w of listWorkspaces()) names.set(w.id, w.project_name);
    const liveTerminalIds = new Set(terminalManager().list().map((t) => t.id));
    return buildProcessList(listTerminalSpecs(), names, getProcessStatuses(), liveTerminalIds);
}
