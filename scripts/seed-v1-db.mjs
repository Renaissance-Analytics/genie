#!/usr/bin/env node
/**
 * SEED A REAL v1 DATABASE with one workspace and two agents — for the upgrade proof in the test VM.
 *
 *   node scripts/seed-v1-db.mjs <path-to-v1-genie.db> <workspace-folder>
 *
 * The installed v1 (0.7.0-beta.342 / 2.0.0-beta.4) creates `%APPDATA%\genie\genie.db` with its own
 * migrations on first launch; this inserts rows the way v1 would have, using only the columns v1's
 * schema requires (every other column has a default — read from the owner's real database on
 * 2026-10-11). After the upgrade, Genie 2's first boot must import exactly these.
 */
import { DatabaseSync } from 'node:sqlite';

const [file, folder] = process.argv.slice(2);
if (!file || !folder) { console.error('usage: seed-v1-db.mjs <genie.db> <workspace-folder>'); process.exit(2); }

export const SEED_WORKSPACE_ID = '01seedv1workspace00000000a';
export const SEED_AGENTS = [
    { id: 'seed-agent-kai', tui: 'claude', name: 'kai', persona: `${folder}\\.agents\\kai\\AGENT.md` },
    { id: 'seed-agent-kai-slave', tui: 'codex', name: 'kai-slave', persona: null },
];

const db = new DatabaseSync(file);
const now = Date.now();
// Hibernated in v1 (hibernated_at set): Genie 2 must import it ASLEEP — 13 of the owner's 27 were, and beta.7 woke them all.
db.prepare(
    'INSERT OR REPLACE INTO workspaces (id, tynn_project_id, tynn_project_name, shape, path, backend, project_id, project_name, sort_order, hibernated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
).run(SEED_WORKSPACE_ID, 'seed-project', 'Seeded by the upgrade proof', 'agi', folder, 'none', 'seed-project', 'Seeded by the upgrade proof', 0, now);
for (const a of SEED_AGENTS) {
    db.prepare(
        'INSERT OR REPLACE INTO workspace_agents (id, workspace_id, tui, name, purpose, persona_path, role, reachability, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(a.id, SEED_WORKSPACE_ID, a.tui, a.name, 'seeded', a.persona, 'specialized', 'workspace', now, now);
}
const w = db.prepare('SELECT count(*) c FROM workspaces').get().c;
const n = db.prepare('SELECT count(*) c FROM workspace_agents').get().c;
db.close();
console.log(`seeded v1 db: workspace ${SEED_WORKSPACE_ID} at ${folder}; agents kai (claude), kai-slave (codex); now ${w} workspaces, ${n} agents in ${file}`);
