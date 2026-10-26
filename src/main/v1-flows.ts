import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { planV1FlowImport, type V1FlowRow } from '../core/v1-flows.js';
import type { FlowStore, V1FlowImportRecord } from './flow-store.js';
import { V1_OPEN_OPTIONS } from './v1-settings.js';

/**
 * READING GENIE 1's FLOWS (genie#1204) — read-only through `node:sqlite`, like the other v1 readers: the `flows` table
 * (main/db.ts migration v74 at v0.7.0-beta.342). Cannot-see is `null` (no file, not a database, no `flows` table); a table
 * with no rows is an empty list — the two are different claims.
 */
export function readV1Flows(dbFile: string): V1FlowRow[] | null {
    if (!existsSync(dbFile)) return null;
    let db: DatabaseSync | null = null;
    try {
        db = new DatabaseSync(dbFile, V1_OPEN_OPTIONS);
        if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'flows'").get() === undefined) return null;
        const cols = new Set((db.prepare('PRAGMA table_info(flows)').all() as Array<{ name: string }>).map((c) => c.name));
        // Before v74 `flows` was another thing (Genie 1's recipe system, or the app-only graph table): not this shape.
        if (!cols.has('scope_json') || !cols.has('graph_json')) return null;
        return (db.prepare('SELECT id, app_id, title, scope_json, graph_json FROM flows ORDER BY created_at, rowid').all() as Record<string, unknown>[])
            .filter((r) => typeof r.id === 'string')
            .map((r) => ({ id: r.id as string, appId: typeof r.app_id === 'string' ? r.app_id : null, title: typeof r.title === 'string' ? r.title : String(r.id), scopeJson: String(r.scope_json ?? ''), graphJson: String(r.graph_json ?? '') }));
    } catch {
        return null;
    } finally {
        try { db?.close(); } catch { /* already closed */ }
    }
}

/**
 * Genie 1's flows into the flow store, ONCE (FlowStore.importV1Flows records it in flows.json), DISARMED: an import is not
 * the person arming anything. At boot, before the scheduler plans. A failure is logged and not recorded, so the next boot
 * tries again.
 */
export async function runV1FlowImport(flows: FlowStore, input: { database: string; workspaces: readonly { id: string; path: string }[] }): Promise<V1FlowImportRecord> {
    const prior = flows.v1FlowImport();
    if (prior?.sawV1) return prior;
    const record = await flows.importV1Flows(planV1FlowImport(readV1Flows(input.database), { workspaces: input.workspaces }));
    if (record.sawV1) console.log(`[genie] v1 flows: ${record.imported ?? 0} imported, disarmed, ${record.alreadyHere ?? 0} already here${record.notes.length ? `; ${record.notes.length} noted: ${record.notes.join(' | ')}` : ''}`);
    return record;
}
