import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { V1AgentIdentity, V1Schedules } from '../core/v1-schedules.js';
import { readV1Processes } from './v1-processes.js';
import { V1_OPEN_OPTIONS } from './v1-settings.js';

/**
 * READING GENIE 1's SCHEDULED TASKS — read-only, through `node:sqlite`, like the other v1 readers.
 *
 * - The tasks are `terminal_specs` rows of type 'process' with a `meta_json.schedule` — read by
 *   `readV1Processes` (the background-process reader) and kept when they carry one.
 * - Who an `agent-nudge` task prompted: `workspace_agents` (id, workspace_id, name, terminal_spec_id), each
 *   agent with every id v1 used for it — its row id, its terminal, and that terminal's `meta_json.agent_id`.
 *
 * Cannot-see is `null` (no file, not a database, no `terminal_specs`); the table with no scheduled rows
 * is an empty list — the two are different claims.
 */
export function readV1Schedules(dbFile: string): V1Schedules | null {
    const processes = readV1Processes(dbFile);
    if (processes === null) return null;
    const specs = processes.filter((p) => {
        try {
            const meta = JSON.parse(p.meta) as Record<string, unknown> | null;
            return meta !== null && typeof meta === 'object' && typeof meta.schedule === 'string' && meta.schedule.trim() !== '';
        } catch {
            return false;
        }
    });
    return { specs, agents: specs.length > 0 && existsSync(dbFile) ? readV1Agents(dbFile) : [] };
}

function readV1Agents(dbFile: string): V1AgentIdentity[] {
    let db: DatabaseSync | null = null;
    try {
        db = new DatabaseSync(dbFile, V1_OPEN_OPTIONS);
        const has = (table: string) => db!.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
        if (!has('workspace_agents')) return [];
        const specAgent = new Map<string, string>();
        for (const row of db.prepare('SELECT id, meta_json FROM terminal_specs').all() as Record<string, unknown>[]) {
            let meta: unknown = null;
            try { meta = JSON.parse(typeof row.meta_json === 'string' ? row.meta_json : '{}'); } catch { meta = null; }
            const agentId = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).agent_id : undefined;
            if (typeof row.id === 'string' && typeof agentId === 'string' && agentId) specAgent.set(row.id, agentId);
        }
        const agents: V1AgentIdentity[] = [];
        for (const row of db.prepare('SELECT id, workspace_id, name, terminal_spec_id FROM workspace_agents ORDER BY created_at, rowid').all() as Record<string, unknown>[]) {
            if (typeof row.id !== 'string' || typeof row.workspace_id !== 'string' || typeof row.name !== 'string') continue;
            const terminal = typeof row.terminal_spec_id === 'string' ? row.terminal_spec_id : null;
            const inboxId = terminal ? specAgent.get(terminal) : undefined;
            agents.push({ workspaceId: row.workspace_id, name: row.name, keys: [row.id, ...(terminal ? [terminal] : []), ...(inboxId ? [inboxId] : [])] });
        }
        return agents;
    } catch {
        return [];
    } finally {
        try { db?.close(); } catch { /* already closed or never opened */ }
    }
}
