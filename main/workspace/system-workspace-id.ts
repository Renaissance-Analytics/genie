/**
 * The PROTECTED System Workspace's id — the workstation operator's own row.
 *
 * A leaf module with no imports on purpose. Both `db.ts` (which WRITES the row
 * under this id) and `terminal/workspace-of-terminal.ts` (which every surface
 * compares against) need it, and they import each other, so the constant lives
 * where neither has to. One definition means the id a row is written under and
 * the id a guard checks cannot drift apart — which, given that the whole point of
 * this row is to stop surfaces inventing their own answer, is not a detail.
 */
export const SYSTEM_WORKSPACE_ROW_ID = '__system__';
