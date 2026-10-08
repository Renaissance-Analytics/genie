import type { TerminalSpecRow } from '../db';
import { SYSTEM_WORKSPACE_ROW_ID } from '../workspace/system-workspace-id';

export function workspaceIdOfSpec(spec: Pick<TerminalSpecRow, 'workspace_id'> & Partial<Pick<TerminalSpecRow, 'meta'>>): string | null {
    if (spec.workspace_id) return spec.workspace_id;
    if (spec.meta?.system === true) return SYSTEM_WORKSPACE_ROW_ID;
    return null;
}
