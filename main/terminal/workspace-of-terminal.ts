import { getTerminalSpec, type TerminalSpecRow } from '../db';
import { SYSTEM_WORKSPACE_ROW_ID } from '../workspace/system-workspace-id';

/**
 * The System Workspace's id (mirrors the renderer's `SYSTEM_WORKSPACE_ID` in
 * `renderer/lib/genie.ts`).
 *
 * It is no longer a sentinel standing in for a missing row: `workspaces` holds a
 * real, protected row under this id, rooted at `~/.gosa`, and `getWorkspace` finds
 * it. ONE definition, in a leaf module both `db.ts` (which writes the row) and
 * this file (which every surface compares against) import — so the id a row is
 * written under and the id a guard checks cannot drift apart.
 */
export const SYSTEM_WORKSPACE_ID = SYSTEM_WORKSPACE_ROW_ID;

/**
 * Resolve a terminal spec to the workspace id it belongs to, for UI grouping.
 *
 * The `meta.system` fallback survives, and it is worth being precise about WHAT
 * it is for now that the workstation operator no longer needs it. It marks a spec
 * that belongs to the System Workspace but is deliberately UNATTACHED: an
 * editor/plugin panel that roots at its own `cwd` and reads the whole filesystem,
 * and a global background process whose cwd the user picked. Attaching those to
 * the row would be wrong — `CodePanel` resolves an attached panel's tabs against
 * the WORKSPACE path, so a panel rooted elsewhere would silently re-read
 * `<file dir>/<tab>` as `~/.gosa/<tab>`.
 *
 * What it is NOT for any more: the operator. Its spec carries a real
 * `workspace_id`, so it takes the first branch like every other agent.
 *
 * Pure (takes the spec) so it's unit-testable without electron/db.
 */
export function workspaceIdOfSpec(spec: TerminalSpecRow): string | null {
    if (spec.workspace_id) return spec.workspace_id;
    if (spec.meta?.system === true) return SYSTEM_WORKSPACE_ID;
    return null;
}

/** Look a terminal id up in the spec store and resolve its workspace id. */
export function workspaceIdOfTerminal(terminalId: string): string | null {
    const spec = getTerminalSpec(terminalId);
    return spec ? workspaceIdOfSpec(spec) : null;
}
