import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { V1ProcessSpec } from '../core/v1-processes.js';
import { V1_OPEN_OPTIONS } from './v1-settings.js';

/**
 * READING GENIE 1's BACKGROUND PROCESSES — read-only, through `node:sqlite`, exactly like
 * `readV1Catalog`: `terminal_specs` rows of type 'process' (id, workspace_id, label, cwd, shell,
 * enabled, meta_json). What each becomes is core/v1-processes.ts's decision; this only reads.
 * Cannot-see is `null` (no file, not a database, no `terminal_specs`); the table with no process
 * rows is an empty list — the two are different claims.
 */
export function readV1Processes(dbFile: string): V1ProcessSpec[] | null {
    if (!existsSync(dbFile)) return null;
    let db: DatabaseSync | null = null;
    try {
        db = new DatabaseSync(dbFile, V1_OPEN_OPTIONS);
        if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'terminal_specs'").get() === undefined) return null;
        const specs: V1ProcessSpec[] = [];
        for (const row of db.prepare("SELECT id, workspace_id, label, cwd, shell, enabled, meta_json FROM terminal_specs WHERE type = 'process' ORDER BY sort_order, rowid").all() as Record<string, unknown>[]) {
            if (typeof row.id !== 'string') continue;
            specs.push({
                id: row.id,
                workspaceId: typeof row.workspace_id === 'string' ? row.workspace_id : null,
                label: typeof row.label === 'string' ? row.label : '',
                cwd: typeof row.cwd === 'string' ? row.cwd : '',
                shell: typeof row.shell === 'string' ? row.shell : null,
                enabled: Number(row.enabled ?? 1) !== 0,
                meta: typeof row.meta_json === 'string' ? row.meta_json : '{}',
            });
        }
        return specs;
    } catch {
        return null;
    } finally {
        try { db?.close(); } catch { /* already closed or never opened */ }
    }
}
