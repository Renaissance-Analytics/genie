import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { V1Agent, V1Catalog, V1Workspace } from '../core/v1-import.js';
import { V1_OPEN_OPTIONS } from './v1-settings.js';

/**
 * READING GENIE 1's WORKSPACES AND AGENTS — read-only, through `node:sqlite`, exactly like
 * `readV1Settings`. v1 keeps `genie.db` in Chromium's userData (`%APPDATA%\genie`), in WAL mode;
 * the tables are `workspaces` (id, path, shape, tynn_project_name/project_name, …) and
 * `workspace_agents` (id, workspace_id, tui, name, persona_path, …). Columns Genie 2 does not use
 * are not read. Cannot-see is `null` (no file, not a database, no such tables); a database with the
 * tables and no rows is an empty catalog — the two are different claims.
 */
export function readV1Catalog(dbFile: string): V1Catalog | null {
    if (!existsSync(dbFile)) return null;
    let db: DatabaseSync | null = null;
    try {
        db = new DatabaseSync(dbFile, V1_OPEN_OPTIONS);
        const has = (table: string) => db!.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
        if (!has('workspaces')) return null;
        const workspaces: V1Workspace[] = [];
        for (const row of db.prepare('SELECT id, path, shape, tynn_project_name, project_name FROM workspaces ORDER BY sort_order, rowid').all() as Record<string, unknown>[]) {
            if (typeof row.id !== 'string' || typeof row.path !== 'string') continue;
            const name = typeof row.project_name === 'string' && row.project_name ? row.project_name : typeof row.tynn_project_name === 'string' ? row.tynn_project_name : row.id;
            workspaces.push({ id: row.id, path: row.path, name, shape: row.shape === 'simple' ? 'simple' : 'agi' });
        }
        const agents: V1Agent[] = [];
        if (has('workspace_agents')) {
            for (const row of db.prepare('SELECT id, workspace_id, tui, name, persona_path FROM workspace_agents ORDER BY created_at, rowid').all() as Record<string, unknown>[]) {
                if (typeof row.id !== 'string' || typeof row.workspace_id !== 'string' || typeof row.name !== 'string') continue;
                agents.push({
                    id: row.id,
                    workspaceId: row.workspace_id,
                    name: row.name,
                    tui: typeof row.tui === 'string' ? row.tui : null,
                    personaPath: typeof row.persona_path === 'string' && row.persona_path ? row.persona_path : null,
                });
            }
        }
        return { workspaces, agents };
    } catch {
        return null;
    } finally {
        try { db?.close(); } catch { /* already closed or never opened */ }
    }
}
