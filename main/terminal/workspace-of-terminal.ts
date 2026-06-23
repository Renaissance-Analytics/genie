import { getTerminalSpec, type TerminalSpecRow } from '../db';

/**
 * The synthetic System Workspace's id (mirrors the renderer's
 * `SYSTEM_WORKSPACE_ID` in `renderer/lib/genie.ts`). The System Workspace has
 * no `workspaces` row, so its terminal specs persist with `workspace_id: null`
 * + `meta.system === true`; everywhere a workspace id flows we substitute this
 * sentinel so the sidebar can recognise it.
 */
export const SYSTEM_WORKSPACE_ID = '__system__';

/**
 * Resolve a terminal spec to the workspace id it belongs to, for UI grouping:
 *   - a normal spec → its stored `workspace_id`;
 *   - a System-Workspace spec (`workspace_id: null` + `meta.system === true`)
 *     → the synthetic {@link SYSTEM_WORKSPACE_ID};
 *   - an unattached spec (null workspace, no system tag) → null.
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
