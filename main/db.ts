import Database from 'better-sqlite3';
import { tuiSettingDefaults } from './agents/registry';
import type { AgentTuiId, ProviderSettingKeys } from './agents/registry';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'node:crypto';
import { SYSTEM_WORKSPACE_ROW_ID } from './workspace/system-workspace-id';
// Pure (no store, no electron): the v68 audit has to resolve links both the old
// way and the new way, and importing the STORE here would be a cycle.
import { buildLegacyResolver, buildLinkResolver } from './knowledge/resolve';
import {
    devSiteIdFor,
    parseDevSites,
    parseDevSitesValue,
    sanitizeDevSitePatch,
    withoutPersistedEnv,
    type DevSiteConfig,
    type DevSites,
} from './dev-server/sites-config';
import { resolveDevSites, persistDevSites, type DevSitesStore } from './workspace/hosting-config';
import { isEnvelopeFolder } from './workspace/envelope';
import { readProjectJson, writeProjectJson } from './workspace/project-json';
import {
    devServiceIdFor,
    generateServicePassword,
    parseDevServices,
    sanitizeDevServicePatch,
    mergeDevServiceConfig,
    type DevServiceConfig,
    type DevServices,
} from './dev-server/services/services-config';
import { engineKeyFor, resolveEngineVersion, type ServiceEngine } from './dev-server/services/catalog';
import type { AgentInboxScope, WorkspaceAgentAccess } from './agentinbox/types';

/**
 * Local SQLite store. Two tables:
 *   - `workspaces` — one row per registered project (Story #152)
 *   - `settings`  — k/v for Settings window state (Story #151)
 *
 * Schema migrations are append-only. Read `schema_version` on boot, run any
 * pending migrations in order, write the new version. Never rewrite history.
 */

let db: Database.Database | null = null;
let resolvedDataDir: string | null = null;

/**
 * Open (once) the local SQLite store under `dataDir` and run pending migrations.
 * `dataDir` is REQUIRED for the GUI-free host-core (genie-cloud passes its data
 * volume); the desktop shell passes Electron's `app.getPath('userData')`. When
 * omitted it lazily falls back to that Electron path so the module stays usable
 * headless (electron is only required on the no-arg desktop path).
 */
export function initDatabase(dataDir?: string): Database.Database {
    if (db) return db;

    const dir =
        dataDir ??
        (require('electron') as typeof import('electron')).app.getPath('userData');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    resolvedDataDir = dir;
    const file = path.join(dir, 'genie.db');

    db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    runMigrations(db);
    return db;
}

export function getDb(): Database.Database {
    if (!db) throw new Error('Database not initialised. Call initDatabase().');
    return db;
}

/**
 * The directory genie.db lives in — Electron's `userData` on the desktop, the
 * data volume on the headless host. Recorded by {@link initDatabase} so sibling
 * stores (e.g. the AgentInbox attachment blobs) land next to the database on BOTH
 * shells without a second wiring step in each one.
 */
export function getDataDir(): string {
    if (!resolvedDataDir) throw new Error('Database not initialised. Call initDatabase().');
    return resolvedDataDir;
}

/**
 * Commands a provider USED to ship that are not commands at all.
 *
 * These are cleared out of the two caches that outrank the registry (the
 * `agent_command_<id>` setting and a spec's `meta.agent_command`) by migration
 * v58, so a corrected registry default can actually reach an existing install.
 * Add to this ONLY for a value that was never a working binary -- an entry here
 * silently discards whatever a user had stored.
 */
export const RETIRED_AGENT_COMMANDS: Record<string, string[]> = {
    // Never existed. The Genie TUI's binary is `genie`.
    genie: ['genie-tui'],
};

/** What a migration pass has to report back to whoever ran it. */
export interface MigrationResult {
    /** The versions applied in THIS pass (empty when the db was already current). */
    applied: number[];
    /**
     * v68's one-time link audit: how many `[[wikilinks]]` used to resolve by
     * last-row-wins and now resolve to nothing (spec §6.5). Null when v68 did not
     * run in this pass.
     *
     * It rides out on the result rather than living only in
     * `knowledge_link_audit` so the count can be SAID -- a graph that quietly got
     * sparser is the failure the audit exists to prevent, and an audit nobody
     * hears is the same silence one table further along.
     */
    ambiguousLinks: number | null;
}

/**
 * Whether `db` has a table by this name.
 *
 * Migrations are append-only and normally need no such question -- `IF NOT
 * EXISTS` answers it inside the statement. `ALTER TABLE ... RENAME TO` has no
 * such clause, so v67 (which renames two tables) and v47 (whose table v67
 * renamed) ask it out loud instead.
 */
function migrationHasTable(db: Database.Database, name: string): boolean {
    return (
        (db
            .prepare<[string], { n: number }>(
                `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`,
            )
            .get(name)?.n ?? 0) > 0
    );
}

/**
 * Run all pending append-only migrations against `d`. Exported so the
 * migration suite can exercise the runner against a fresh `:memory:`
 * database without the Electron `app.getPath` singleton path.
 */
export function runMigrations(d: Database.Database): MigrationResult {
    d.exec(`CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
    )`);
    const row = d
        .prepare<[], { version: number } | undefined>(
            'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1',
        )
        .get();
    const current = row?.version ?? 0;
    const applied: number[] = [];
    let ambiguousLinks: number | null = null;

    const migrations: Array<{ version: number; runner: (db: Database.Database) => void }> = [
        {
            version: 1,
            runner: (db) =>
                db.exec(`
                    CREATE TABLE workspaces (
                        id                TEXT PRIMARY KEY,
                        tynn_project_id   TEXT NOT NULL,
                        tynn_project_name TEXT NOT NULL,
                        shape             TEXT NOT NULL CHECK (shape IN ('agi','simple')),
                        path              TEXT NOT NULL,
                        editor            TEXT,
                        editor_cmd        TEXT,
                        start_cmd         TEXT,
                        env_file          TEXT,
                        last_opened_at    TEXT,
                        created_by_genie  INTEGER NOT NULL DEFAULT 0
                    );
                    CREATE INDEX idx_workspaces_last_opened ON workspaces(last_opened_at DESC);

                    CREATE TABLE settings (
                        key   TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    );
                `),
        },
        {
            // v2 — backend-agnostic columns. Idempotent: if a previous
            // attempt partially applied (column exists but schema_version
            // wasn't bumped), each ADD COLUMN no-ops via column-exists check
            // so we converge to the v2 state without throwing.
            version: 2,
            runner: (db) => {
                const ws = workspaceColumns(db);
                if (!ws.has('backend')) {
                    // No CHECK constraint here — SQLite versions before 3.25
                    // reject CHECK on ALTER ADD COLUMN. We enforce the
                    // ('tynn','aionima') set at the app layer in addWorkspace.
                    db.exec(
                        `ALTER TABLE workspaces ADD COLUMN backend TEXT NOT NULL DEFAULT 'tynn'`,
                    );
                }
                if (!ws.has('project_id')) {
                    db.exec(`ALTER TABLE workspaces ADD COLUMN project_id   TEXT`);
                }
                if (!ws.has('project_name')) {
                    db.exec(`ALTER TABLE workspaces ADD COLUMN project_name TEXT`);
                }
                db.exec(`
                    UPDATE workspaces SET project_id   = tynn_project_id   WHERE project_id   IS NULL;
                    UPDATE workspaces SET project_name = tynn_project_name WHERE project_name IS NULL;
                `);
                db.exec(`
                    CREATE TABLE IF NOT EXISTS backend_connections (
                        backend  TEXT PRIMARY KEY CHECK (backend IN ('tynn', 'aionima')),
                        host     TEXT,
                        token    TEXT,
                        updated_at TEXT NOT NULL
                    )
                `);
            },
        },
        {
            // v3 — persistent terminal specs for the master workspace view.
            // Spec = the saved definition of a terminal (label, cwd, shell);
            // distinct from the in-memory PTY which lives in TerminalManager.
            // workspace_id FK is optional so a spec can be unattached (the
            // "scratch" / cross-project case).
            version: 3,
            runner: (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS terminal_specs (
                        id            TEXT PRIMARY KEY,
                        workspace_id  TEXT,
                        label         TEXT NOT NULL,
                        cwd           TEXT NOT NULL,
                        shell         TEXT,
                        args_json     TEXT NOT NULL DEFAULT '[]',
                        env_json      TEXT NOT NULL DEFAULT '{}',
                        sort_order    INTEGER NOT NULL DEFAULT 0,
                        created_at    TEXT NOT NULL,
                        last_opened_at TEXT,
                        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_terminal_specs_workspace ON terminal_specs(workspace_id, sort_order);
                `);
            },
        },
        {
            // v4 — view-typed specs. A spec is no longer always a terminal:
            // `type` distinguishes 'terminal' from 'code' (a fancy-code
            // editor view), and `meta_json` carries per-type state (code
            // views store {"file_path":"…"}). Idempotent ADD COLUMN like
            // v2's `backend` — re-running on a partially-applied DB no-ops
            // via the column-exists check. No CHECK on ALTER (SQLite < 3.25
            // rejects it); the 'terminal'|'code' set is enforced app-layer.
            version: 4,
            runner: (db) => {
                const cols = terminalSpecColumns(db);
                if (!cols.has('type')) {
                    db.exec(
                        `ALTER TABLE terminal_specs ADD COLUMN type TEXT NOT NULL DEFAULT 'terminal'`,
                    );
                }
                if (!cols.has('meta_json')) {
                    db.exec(
                        `ALTER TABLE terminal_specs ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}'`,
                    );
                }
            },
        },
        {
            // v5 — terminal session-persistence pointers (Tier 1). The actual
            // snapshot bytes live encrypted on disk under
            // userData/sessions/<id>.snap; these columns are just metadata
            // pointers so the renderer can know a snapshot exists and where
            // the shell was last running:
            //   snapshot_at    — epoch ms of the last written snapshot (NULL = none)
            //   snapshot_bytes — on-disk encrypted size, for surfacing/limits
            //   live_cwd       — last cwd reported by the shell via OSC-7 (NULL = unknown)
            // Idempotent ADD COLUMN like v2/v4 — re-running on a partially
            // applied DB no-ops via the column-exists check. Pre-existing rows
            // read back NULL for all three, which the app treats as "no
            // snapshot / cwd unknown" and degrades to the static cwd.
            version: 5,
            runner: (db) => {
                const cols = terminalSpecColumns(db);
                if (!cols.has('snapshot_at')) {
                    db.exec(
                        `ALTER TABLE terminal_specs ADD COLUMN snapshot_at INTEGER`,
                    );
                }
                if (!cols.has('snapshot_bytes')) {
                    db.exec(
                        `ALTER TABLE terminal_specs ADD COLUMN snapshot_bytes INTEGER`,
                    );
                }
                if (!cols.has('live_cwd')) {
                    db.exec(
                        `ALTER TABLE terminal_specs ADD COLUMN live_cwd TEXT`,
                    );
                }
            },
        },
        {
            // v6 — Tier 2 retained-terminal state. `enabled` distinguishes a
            // live/visible terminal (1) from a disabled-but-retained one (0):
            // disabling keeps the spec AND (while the app is open) its running
            // pty, so re-enabling resumes the live session. Pre-existing rows
            // default to 1 (enabled) so nothing disappears on upgrade.
            // Idempotent ADD COLUMN like v2/v4/v5 — re-running no-ops via the
            // column-exists check.
            version: 6,
            runner: (db) => {
                const cols = terminalSpecColumns(db);
                if (!cols.has('enabled')) {
                    db.exec(
                        `ALTER TABLE terminal_specs ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`,
                    );
                }
            },
        },
        {
            // v7 — Tier 3 detached pty-host mapping. `host_session_id` records
            // the host-side pty key for this spec so a spec can be re-associated
            // with its still-running shell in the detached host across an app
            // restart. NULL = no host session (in-process backend, or never
            // started under the host). Idempotent ADD COLUMN like v2/v4/v5/v6 —
            // re-running no-ops via the column-exists check. Pre-v7 rows read
            // back NULL, which the app treats as "no host session".
            version: 7,
            runner: (db) => {
                const cols = terminalSpecColumns(db);
                if (!cols.has('host_session_id')) {
                    db.exec(
                        `ALTER TABLE terminal_specs ADD COLUMN host_session_id TEXT`,
                    );
                }
            },
        },
        {
            // v8: user-defined workspace ordering for the sidebar (alpha.47).
            // Default 0 → pre-v8 rows keep their last-opened ordering until the
            // user drags one; reorderWorkspaces() then writes explicit indices.
            // Idempotent ADD COLUMN like v2/v4/v5/v6/v7.
            version: 8,
            runner: (db) => {
                const cols = workspaceColumns(db);
                if (!cols.has('sort_order')) {
                    db.exec(
                        `ALTER TABLE workspaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`,
                    );
                }
            },
        },
        {
            // v9: per-workspace agent-integration MCP toggle (alpha.47). Default
            // 0 (OFF) — terminals in a workspace only get the Genie MCP endpoint
            // + GENIE_MCP_URL env once the user opts the workspace in. Idempotent.
            version: 9,
            runner: (db) => {
                const cols = workspaceColumns(db);
                if (!cols.has('mcp_enabled')) {
                    db.exec(
                        `ALTER TABLE workspaces ADD COLUMN mcp_enabled INTEGER NOT NULL DEFAULT 0`,
                    );
                }
            },
        },
        {
            // v10: heal Process specs mis-stored as 'terminal'. createTerminalSpec
            // clamped the written type to 'code'|'terminal' (the 'process' case
            // was missed), so processes added before that fix landed as type
            // 'terminal' with a meta.command — which only Process specs ever set.
            // Reclassify those rows so they show in the Processes manager, not the
            // view list. Idempotent: re-running matches nothing once converted.
            version: 10,
            runner: (db) => {
                db.exec(
                    `UPDATE terminal_specs SET type = 'process'
                     WHERE type = 'terminal' AND meta_json LIKE '%"command"%'`,
                );
            },
        },
        {
            // v11: enable the agent-integration MCP for ALL workspaces by
            // default (alpha.53). v9 shipped it OFF + opt-in; we now want the
            // Genie MCP (imDone, ForceTheQuestion, …) available everywhere out
            // of the box. One-time backfill — runs once, so a user who later
            // toggles a workspace off stays off. New workspaces default ON via
            // addWorkspace. The startup loop in background.ts writes each
            // enabled workspace's Claude/Cursor .mcp.json on the next launch.
            version: 11,
            runner: (db) => {
                db.exec(`UPDATE workspaces SET mcp_enabled = 1`);
            },
        },
        {
            // v12: Issue Watch (alpha.63). Per (workspace, owner/repo) watch row:
            // whether it's actively watched (default ON for auto-detected repos)
            // and `seen_at` — the high-water timestamp; an item is "unread" when
            // its updatedAt > seen_at. Marking the feed seen bumps seen_at.
            version: 12,
            runner: (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS issue_watches (
                        workspace_id TEXT NOT NULL,
                        owner        TEXT NOT NULL,
                        repo         TEXT NOT NULL,
                        enabled      INTEGER NOT NULL DEFAULT 1,
                        seen_at      TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
                        PRIMARY KEY (workspace_id, owner, repo)
                    )
                `);
            },
        },
        {
            // v13: per-workspace "Background process approval" gate. When ON
            // (the safe default), an agent creating/starting a background
            // process via the manageProcess MCP tool must be approved by the
            // user first; OFF runs it immediately (pre-v13 behavior). Default 1
            // so agents can't silently spawn processes out of the box.
            version: 13,
            runner: (db) => {
                const cols = workspaceColumns(db);
                if (!cols.has('process_approval')) {
                    db.exec(
                        `ALTER TABLE workspaces ADD COLUMN process_approval INTEGER NOT NULL DEFAULT 1`,
                    );
                }
            },
        },
        {
            // v14: per-workspace "Terminal & agent approval" gate. Higher-power
            // sibling of process_approval (v13). When ON (the safe default), an
            // agent that spawns a terminal / writes to one / launches or drives a
            // coding agent via the manageTerminals + runAgent MCP tools must be
            // approved by the user first; OFF runs it immediately. Default 1 so an
            // agent can't silently execute arbitrary commands or start sub-agents
            // out of the box. Distinct from process_approval because this is
            // strictly higher-power (arbitrary code execution + autonomous agent
            // spawning), so it gets its own toggle.
            version: 14,
            runner: (db) => {
                const cols = workspaceColumns(db);
                if (!cols.has('terminal_approval')) {
                    db.exec(
                        `ALTER TABLE workspaces ADD COLUMN terminal_approval INTEGER NOT NULL DEFAULT 1`,
                    );
                }
            },
        },
        {
            // v15: per-workspace IssueWatch remediation policy. How agents should
            // act on this workspace's IssueWatch pings (checkIssues / the imDone
            // sec: count) — 'surface' (default) | 'fix' | 'fix-and-ship'. Was a
            // single GLOBAL setting (agent_issuewatch_policy); a NULL column reads
            // as the 'surface' default, so existing workspaces keep that behaviour.
            version: 15,
            runner: (db) => {
                const cols = workspaceColumns(db);
                if (!cols.has('issuewatch_policy')) {
                    db.exec(
                        `ALTER TABLE workspaces ADD COLUMN issuewatch_policy TEXT`,
                    );
                }
            },
        },
        {
            // v16: fork → upstream cache (IssueWatch upstream-for-forks). A repo's
            // fork status + its parent ("upstream") rarely changes, so we cache the
            // GET /repos/{owner}/{repo} lookup here keyed by owner/repo: `is_fork`
            // (1/0) plus the upstream owner/repo (NULL for a non-fork or an orphan
            // fork whose parent was deleted). `checked_at` lets the resolver
            // re-resolve only when the entry is stale (~7 days), so upstream
            // watching costs one metadata read per repo per week, not per poll.
            version: 16,
            runner: (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS fork_upstream (
                        owner          TEXT NOT NULL,
                        repo           TEXT NOT NULL,
                        is_fork        INTEGER NOT NULL DEFAULT 0,
                        upstream_owner TEXT,
                        upstream_repo  TEXT,
                        checked_at     TEXT NOT NULL,
                        PRIMARY KEY (owner, repo)
                    )
                `);
            },
        },
        {
            // v17: per-workspace IssueWatch granularity. A JSON blob controlling
            // WHAT IssueWatch watches + pings about for this workspace:
            //   { own: { issues, pulls, security }, upstream: 'none'|'issues'|'issues+prs' }
            // NULL/absent reads as the defaults (all own kinds ON + upstream
            // issues+prs), so existing workspaces keep the prior behaviour AND gain
            // upstream watching. Stored as TEXT JSON (one structured setting) rather
            // than a fan of columns. Resolved + defaulted by
            // getWorkspaceIssuewatchGranularity. Idempotent ADD COLUMN.
            version: 17,
            runner: (db) => {
                const cols = workspaceColumns(db);
                if (!cols.has('issuewatch_granularity')) {
                    db.exec(
                        `ALTER TABLE workspaces ADD COLUMN issuewatch_granularity TEXT`,
                    );
                }
            },
        },
        {
            // v18: per-workspace IssueWatch remediation policy PER BUCKET. A JSON
            // blob { security, issue, pr } → 'surface'|'fix'|'fix-and-ship' each,
            // so the user can (e.g.) fix-and-ship security immediately but hold
            // regular issues. NULL/absent falls back to the legacy single
            // `issuewatch_policy` column for ALL three buckets (see
            // parsePolicyBuckets), so existing per-workspace settings survive
            // untouched. Stored as TEXT JSON (one structured setting), resolved +
            // defaulted by getWorkspaceIssuewatchPolicyBuckets. Idempotent ADD COLUMN.
            version: 18,
            runner: (db) => {
                const cols = workspaceColumns(db);
                if (!cols.has('issuewatch_policy_buckets')) {
                    db.exec(
                        `ALTER TABLE workspaces ADD COLUMN issuewatch_policy_buckets TEXT`,
                    );
                }
            },
        },
        {
            // v19: per-workspace LOCAL-SITE TUNNEL settings — RETIRED.
            //
            // This column held the hosts-file `.gen` allowlist: which of the
            // machine's loopback `*.test` vhosts (Herd, Valet, a stray `npm run
            // dev`) were tunnelled under a derived `.gen` name. The container Dev
            // Server (#234) replaced that source outright — a `.gen` site is a
            // container Genie started, never something found in a hosts file — so
            // NOTHING reads or writes `tunnel_sites` any more.
            //
            // The migration STAYS, and so does the column. Migrations are an
            // append-only chain replayed from v1 on every existing database:
            // removing this step would renumber nothing but would leave older
            // installs having applied a v19 that no longer exists, and dropping
            // the column would destroy a user's stored config to reclaim a few
            // bytes of a value nobody reads. An orphaned column is the cheap,
            // reversible option; deleting data is not.
            version: 19,
            runner: (db) => {
                const cols = workspaceColumns(db);
                if (!cols.has('tunnel_sites')) {
                    db.exec(`ALTER TABLE workspaces ADD COLUMN tunnel_sites TEXT`);
                }
            },
        },
        {
            // v20 — the Plugin System (Phase 0). Two fresh tables (so CHECK
            // constraints are safe here — unlike an ALTER ADD COLUMN):
            //   - `plugin_marketplaces` — a git repo that INDEXES many plugins.
            //     The user adds one by pasting its repo URL; Genie caches the
            //     parsed `genie-marketplace.json` index in `manifest_json`.
            //   - `plugins` — one installed plugin. Tracks its SOURCE (repo URL +
            //     pinned ref, or a local dev folder), which marketplace it came
            //     from (nullable), the ENABLED flag (fail-closed default 0), the
            //     validated manifest snapshot, and the GRANULAR granted
            //     permissions blob (§12.1 — each fs scope / network host / Genie
            //     API is an independent, user-toggleable grant). `integrity` +
            //     `signature` + `publisher_key_id` are signing-ready columns
            //     (populated for the curated/Official path in Phase 3; NULL on
            //     the dev repo-URL/folder path).
            //     (Renumbered v19→v20: serve-local-sites owns v19.)
            version: 20,
            runner: (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS plugin_marketplaces (
                        id            TEXT PRIMARY KEY,
                        name          TEXT NOT NULL,
                        url           TEXT NOT NULL,
                        ref           TEXT,
                        official      INTEGER NOT NULL DEFAULT 0,
                        manifest_json TEXT,
                        added_at      TEXT NOT NULL,
                        updated_at    TEXT NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS plugins (
                        id                TEXT PRIMARY KEY,
                        namespace         TEXT NOT NULL,
                        name              TEXT NOT NULL,
                        version           TEXT NOT NULL,
                        source_type       TEXT NOT NULL CHECK (source_type IN ('repo','folder','marketplace')),
                        source_url        TEXT,
                        source_ref        TEXT,
                        install_path      TEXT NOT NULL,
                        marketplace_id    TEXT,
                        enabled           INTEGER NOT NULL DEFAULT 0,
                        manifest_json     TEXT NOT NULL,
                        granted_json      TEXT NOT NULL DEFAULT '{}',
                        integrity         TEXT,
                        signature         TEXT,
                        publisher_key_id  TEXT,
                        installed_at      TEXT NOT NULL,
                        updated_at        TEXT NOT NULL,
                        FOREIGN KEY (marketplace_id) REFERENCES plugin_marketplaces(id) ON DELETE SET NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_plugins_enabled ON plugins(enabled);
                `);
            },
        },
        {
            // v21 — Plugin System Phase 3 (signed registry + trust). Adds the
            // provenance/trust cache columns to the (unshipped) v20 tables via
            // idempotent guarded ALTERs, so a dev DB already at v20 converges:
            //   - plugins.trust        — last evaluated verdict
            //                            ('trusted'|'unsigned'|'untrusted'); the
            //                            fail-closed default is 'unsigned'.
            //   - plugins.dev_approved — the user knowingly enabled an UNSIGNED
            //                            plugin under Developer Mode (default 0).
            //   - plugin_marketplaces.signature / .publisher_key_id — a signed
            //                            marketplace index's provenance.
            // The columns are a CACHE: trust is still re-evaluated against the live
            // trust store at enable + on a revalidation sweep (removing a key
            // revokes). The runtime surface gate reads these columns (fail-closed).
            version: 21,
            runner: (db) => {
                const p = tableColumns(db, 'plugins');
                if (!p.has('trust')) {
                    db.exec(`ALTER TABLE plugins ADD COLUMN trust TEXT NOT NULL DEFAULT 'unsigned'`);
                }
                if (!p.has('dev_approved')) {
                    db.exec(`ALTER TABLE plugins ADD COLUMN dev_approved INTEGER NOT NULL DEFAULT 0`);
                }
                const m = tableColumns(db, 'plugin_marketplaces');
                if (!m.has('signature')) {
                    db.exec(`ALTER TABLE plugin_marketplaces ADD COLUMN signature TEXT`);
                }
                if (!m.has('publisher_key_id')) {
                    db.exec(`ALTER TABLE plugin_marketplaces ADD COLUMN publisher_key_id TEXT`);
                }
            },
        },
        {
            // v22 — Workstation Knowledge Graph (Wish #87). A workstation-wide,
            // local knowledge/memory store shared across EVERY workspace on this
            // Genie instance (it lives in the shared genie.db, not per-workspace):
            //   - knowledge_nodes      — one markdown "memory" per row.
            //   - knowledge_nodes_fts  — FTS5 index over title/body/tags for the
            //                            keyword retrieval floor (kept in sync by
            //                            the store's writes, not triggers, so the
            //                            id column can stay UNINDEXED).
            //   - knowledge_edges      — a node's outbound links. `to_ref` is a raw
            //                            reference (a node id, title, or slug from a
            //                            `[[wikilink]]` or an explicit link),
            //                            resolved to a node id at read time; `kind`
            //                            ('wiki'|'explicit') lets an update to the
            //                            body vs the explicit links recompute one
            //                            without clobbering the other. from_id
            //                            cascades on node delete.
            version: 22,
            runner: (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS knowledge_nodes (
                        id         TEXT PRIMARY KEY,
                        title      TEXT NOT NULL DEFAULT '',
                        slug       TEXT NOT NULL DEFAULT '',
                        body       TEXT NOT NULL DEFAULT '',
                        tags       TEXT NOT NULL DEFAULT '[]',
                        source     TEXT NOT NULL DEFAULT 'user'
                                   CHECK (source IN ('agent', 'user')),
                        created_at INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_updated
                        ON knowledge_nodes(updated_at DESC);
                    CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_slug
                        ON knowledge_nodes(slug);

                    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_nodes_fts USING fts5(
                        id UNINDEXED, title, body, tags
                    );

                    CREATE TABLE IF NOT EXISTS knowledge_edges (
                        from_id TEXT NOT NULL,
                        to_ref  TEXT NOT NULL,
                        kind    TEXT NOT NULL DEFAULT 'wiki'
                                CHECK (kind IN ('wiki', 'explicit')),
                        PRIMARY KEY (from_id, to_ref, kind),
                        FOREIGN KEY (from_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE
                    );
                    CREATE INDEX IF NOT EXISTS idx_knowledge_edges_to
                        ON knowledge_edges(to_ref);
                `);
            },
        },
        {
            // v23 — AgentInbox durable inbox. Messages were in-memory only (lost on
            // restart, silently dropped past the 200 cap). Persist every message +
            // a per-agent ACK cursor so a queued message survives a restart, the
            // human panel keeps its history, and unACKed-urgent escalation (Track C)
            // has a durable position to check. `seq` is the broker's monotonic global
            // sequence (resumed from MAX(seq) on boot so cursors stay valid).
            // BACK-COMPAT: the `whisper_messages` / `whisper_cursors` table + index
            // names are RETAINED after the WhisperChat → AgentInbox rename — they are
            // shipped schema, so renaming them would need a data migration.
            version: 23,
            runner: (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS whisper_messages (
                        id          TEXT PRIMARY KEY,
                        seq         INTEGER NOT NULL,
                        kind        TEXT NOT NULL CHECK (kind IN ('dm', 'channel')),
                        from_id     TEXT NOT NULL,
                        from_label  TEXT NOT NULL DEFAULT '',
                        to_id       TEXT,
                        channel_key TEXT,
                        text        TEXT NOT NULL DEFAULT '',
                        ts          INTEGER NOT NULL,
                        interrupt   INTEGER NOT NULL DEFAULT 0
                    );
                    CREATE INDEX IF NOT EXISTS idx_whisper_messages_seq
                        ON whisper_messages(seq);
                    CREATE INDEX IF NOT EXISTS idx_whisper_messages_dm
                        ON whisper_messages(to_id, seq);
                    CREATE INDEX IF NOT EXISTS idx_whisper_messages_channel
                        ON whisper_messages(channel_key, seq);

                    CREATE TABLE IF NOT EXISTS whisper_cursors (
                        agent_id  TEXT PRIMARY KEY,
                        acked_seq INTEGER NOT NULL DEFAULT 0
                    );
                `);
            },
        },
        {
            // v24 — workspace-assignment DEPROVISION marker. `assignment_managed`
            // flags a workspace that this headless host provisioned FROM a Tynn
            // `WorkspaceAssigned` push. It is the discriminator the convergent
            // reconcile keys off to safely REMOVE a workspace Tynn no longer
            // assigns: ops-provisioned and user-local workspaces register with
            // identical backend/created_by_genie, so those fields can't tell them
            // apart — only rows the assignment flow set to 1 are ever torn down.
            // Idempotent ADD COLUMN like v2's `backend` (no CHECK on ALTER for
            // SQLite < 3.25); pre-existing rows read back 0 (not managed).
            version: 24,
            runner: (db) => {
                const ws = workspaceColumns(db);
                if (!ws.has('assignment_managed')) {
                    db.exec(
                        `ALTER TABLE workspaces ADD COLUMN assignment_managed INTEGER NOT NULL DEFAULT 0`,
                    );
                }
            },
        },
        {
            // v25 — tynn-cli was removed from Genie. Drop its retired toggles so
            // remote settings payloads and future diagnostics cannot resurrect
            // stale product state from pre-removal builds.
            version: 25,
            runner: (db) => {
                db.prepare(
                    `DELETE FROM settings WHERE key IN ('cli_tools_in_terminals', 'cli_install_systemwide')`,
                ).run();
            },
        },
        {
            // v26 — per-workspace IssueWatch DESIGNATED handler set. A JSON array of
            // agent terminal ids that should receive this workspace's IssueWatch
            // pings; NULL/absent (the default) means "not designated" and the ping
            // fans out to every `issuewatch_handle` agent instead (see
            // getWorkspaceIssuewatchHandlers + resolveIssueWatchRecipients). The
            // per-agent opt-in itself rides terminal_specs.meta_json (no migration).
            // Idempotent ADD COLUMN like v24's `assignment_managed` (no CHECK on
            // ALTER for SQLite < 3.25); pre-existing rows read back NULL.
            version: 26,
            runner: (db) => {
                const ws = workspaceColumns(db);
                if (!ws.has('issuewatch_handlers')) {
                    db.exec(`ALTER TABLE workspaces ADD COLUMN issuewatch_handlers TEXT`);
                }
            },
        },
        {
            // v27 — per-workspace AGENT ACCESS: the OUTER tier of AgentInbox access
            // control (the workspace's front door). Governs whether agents from
            // ANOTHER workspace may reach into this one — join/post to its channels
            // and discover/DM its agents. The per-agent `whisper_scope` (inner tier,
            // in terminal_specs.meta) still decides who may DM a given agent; a
            // caller must clear BOTH.
            //
            // DEFAULT IS 'all' — deliberately permissive. Channels were previously
            // UNGOVERNED (any agent could join and broadcast into any workspace's
            // room), so defaulting to anything stricter would silently sever working
            // cross-workspace setups on upgrade. Users tighten per workspace.
            version: 27,
            runner: (db) => {
                const ws = workspaceColumns(db);
                if (!ws.has('agent_access')) {
                    db.exec(
                        `ALTER TABLE workspaces ADD COLUMN agent_access TEXT NOT NULL DEFAULT 'all'`,
                    );
                }
                if (!ws.has('agent_access_workspaces')) {
                    db.exec(`ALTER TABLE workspaces ADD COLUMN agent_access_workspaces TEXT`);
                }
            },
        },
        {
            // v28: per-workspace "Scheduled task approval" gate — the third
            // sibling of process_approval (v13) and terminal_approval (v14).
            // When ON (the safe default), an agent that arms a SCHEDULED task
            // (a process spec carrying `meta.schedule`) must be approved by the
            // user first; OFF arms it immediately. Its own toggle because a
            // schedule is qualitatively different from a one-off process: it
            // runs unattended, on the Host, forever — so the user should get to
            // see the recurrence before it starts, even in a workspace where
            // they've already loosened plain process approval.
            version: 28,
            runner: (db) => {
                const cols = workspaceColumns(db);
                if (!cols.has('schedule_approval')) {
                    db.exec(
                        `ALTER TABLE workspaces ADD COLUMN schedule_approval INTEGER NOT NULL DEFAULT 1`,
                    );
                }
            },
        },
        {
            // v29: per-workspace HOSTED SITES (Genie's own hosting runtime,
            // Tynn #232 P2). A JSON blob mapping the opaque per-site id → its
            // hosting config: { [siteId]: { enabled, hostname, kind, docroot } }.
            //
            // Deliberately a SIBLING of the (now retired) `tunnel_sites` (v19)
            // rather than more fields on it, because the two expressed opposite
            // things: a tunnel_sites row said "something else on this machine
            // already serves this site — carry it", while a hosted_sites row
            // says "Genie serves this site itself".
            //
            // NULL/absent reads as {} (nothing hosted), so existing workspaces
            // gain the column with the safe default. Resolved by
            // getWorkspaceHostedSites — never parsed here.
            version: 29,
            runner: (db) => {
                const cols = workspaceColumns(db);
                if (!cols.has('hosted_sites')) {
                    db.exec(`ALTER TABLE workspaces ADD COLUMN hosted_sites TEXT`);
                }
            },
        },
        {
            // v30: per-workspace BACKING SERVICES (Tynn #232 P3). A JSON blob
            // mapping the opaque per-service id → its config:
            // { [serviceId]: { enabled, kind, password?, database? } }.
            //
            // The companion of v29: `hosted_sites` says what Genie SERVES, this
            // says what those sites CONNECT TO. Separate columns rather than one
            // nested blob because their lifecycles differ — a workspace can run
            // a database for `artisan` and its own tooling without hosting any
            // site at all, and disabling a site must not tear down the data.
            //
            // Holds the generated database password. That is deliberate; see
            // `main/hosting/services/config.ts` for why encrypting a credential
            // whose entire purpose is to be written into a plaintext `.env` two
            // directories away would buy nothing.
            //
            // NULL/absent reads as {} (no services). Resolved by
            // getWorkspaceServices — never parsed here.
            version: 30,
            runner: (db) => {
                const cols = workspaceColumns(db);
                if (!cols.has('workspace_services')) {
                    db.exec(`ALTER TABLE workspaces ADD COLUMN workspace_services TEXT`);
                }
            },
        },
        {
            // v31: per-workspace DEV SITES (the container Dev Server, Tynn #234
            // P2). A JSON blob mapping the opaque per-site id → its definition:
            // { [siteId]: { name, genName, repo, runMode, image?, command?,
            //   port?, env?, kind, enabled } }.
            //
            // A THIRD column rather than a rename of v29's `hosted_sites`,
            // because the two name different substrates and both are live: a
            // hosted_sites row is served by the beta.218 host-NATIVE runtime
            // (FrankenPHP, PHP-first), a dev_sites row by a container in the
            // workspace sandbox (any stack). P4 retires the former; folding them
            // together now would make that retirement a data migration instead
            // of a deletion.
            //
            // NULL/absent reads as {} (nothing defined), so existing workspaces
            // gain the column with the safe default. Resolved by
            // getWorkspaceDevSites — never parsed here.
            version: 31,
            runner: (db) => {
                const cols = workspaceColumns(db);
                if (!cols.has('dev_sites')) {
                    db.exec(`ALTER TABLE workspaces ADD COLUMN dev_sites TEXT`);
                }
            },
        },
        {
            // v32: per-workspace DEV SERVICES (the container Dev Server, Tynn
            // #234 P3). A JSON blob mapping the opaque per-service id → what
            // this workspace wants: { [serviceId]: { engine, version, dedicated,
            //   password, image?, port?, env?, enabled } }.
            //
            // A FOURTH column rather than a reuse of v30's `workspace_services`,
            // for exactly the reason v31 gave for `dev_sites`: a v30 row
            // describes a HOST-NATIVE Postgres fetched onto the user's machine
            // (the beta.218 path), this one describes a workspace's slice of a
            // SHARED container. Both are live until P4 retires the former, and
            // folding them together now would make that retirement a data
            // migration instead of a deletion.
            //
            // Holds the workspace's generated credential in the clear. Same
            // reasoning as v30's: its purpose is to reach a `.env` and a
            // container environment in the clear, because that is the only way
            // the app can use it.
            //
            // NULL/absent reads as {} (nothing configured). Resolved by
            // getWorkspaceDevServices — never parsed here.
            version: 32,
            runner: (db) => {
                const cols = workspaceColumns(db);
                if (!cols.has('dev_services')) {
                    db.exec(`ALTER TABLE workspaces ADD COLUMN dev_services TEXT`);
                }
            },
        },
        {
            // v33: the SHARED service engines themselves (#234 P3).
            //
            // A machine-scoped table rather than a workspace column, because a
            // shared engine IS machine-scoped: one `postgres:16` container
            // serves every workspace pinned to Postgres 16, so its superuser
            // credential cannot live in any one workspace's row.
            //
            // `key` is the container's identity: `postgres-16` for the shared
            // engine, `postgres-16@<workspaceId>` for a workspace's opt-in
            // dedicated one. The admin password is minted ONCE per key and never
            // regenerated — every engine image bakes the credential into its
            // data directory on first init and ignores the environment
            // afterwards, so a new password would simply lock Genie out of the
            // engine it created.
            version: 33,
            runner: (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS dev_service_engines (
                        key TEXT PRIMARY KEY,
                        engine TEXT NOT NULL,
                        version TEXT NOT NULL,
                        workspace_id TEXT,
                        admin_user TEXT NOT NULL,
                        admin_password TEXT NOT NULL,
                        created_at INTEGER NOT NULL
                    )
                `);
            },
        },
        {
            // v34: DROP the beta.218 native-hosting columns (#234 P4).
            //
            // `hosted_sites` (v29) and `workspace_services` (v30) described the
            // host-NATIVE hosting runtime — FrankenPHP, and Postgres/Redis
            // fetched onto the user's machine — which P4 deletes. v31/v32 were
            // deliberately NEW columns rather than reuses of these two, and this
            // is the migration that collects on that decision: there is nothing
            // to copy, because nothing was ever shared. A `dev_sites` row is not
            // a converted `hosted_sites` row; a workspace that had native
            // hosting configured simply no longer has it, and its Site Manager
            // now offers the container path instead.
            //
            // Every earlier version is left exactly as it was, including the two
            // ALTERs that add these columns. Rewriting v29/v30 into no-ops would
            // make the chain lie about what it did, and it would mean a fresh
            // database never exercises this DROP at all — so the one code path
            // that has to work on every existing machine would be the one no
            // test run ever touched.
            //
            // `ALTER TABLE ... DROP COLUMN` needs SQLite ≥ 3.35 (better-sqlite3
            // ships far newer) and refuses a column that is indexed, unique, a
            // primary key, or named in a CHECK/generated column. Both of these
            // are plain unconstrained TEXT blobs, so neither restriction bites.
            version: 34,
            runner: (db) => {
                const cols = workspaceColumns(db);
                if (cols.has('hosted_sites')) {
                    db.exec(`ALTER TABLE workspaces DROP COLUMN hosted_sites`);
                }
                if (cols.has('workspace_services')) {
                    db.exec(`ALTER TABLE workspaces DROP COLUMN workspace_services`);
                }
            },
        },
        {
            // v35 — AgentInbox FILE ATTACHMENTS (metadata).
            //
            // The BYTES are deliberately NOT here: they live in a
            // content-addressed directory beside this database
            // (`agentinbox-attachments/<sha>` — see agentinbox/attachments.ts).
            // genie.db is on the hot path for every spec, message and cursor and
            // is WAL-journalled; pushing tens of megabytes of opaque payload
            // through it would bloat the WAL and slow every unrelated write, and
            // a blob column can't dedup. What lives here is the part worth
            // querying and joining: which files rode which message.
            //
            // `ON DELETE CASCADE` off `whisper_messages` is the point of the FK —
            // the human's existing conversation wipes (v23's table, genie #64/#66)
            // must take the attachment metadata with them rather than leave rows
            // pointing at a message that no longer exists. The blobs are
            // content-addressed and possibly shared, so reclaiming THOSE is a
            // separate sweep, not a cascade.
            version: 35,
            runner: (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS agentinbox_attachments (
                        id         TEXT PRIMARY KEY,
                        message_id TEXT NOT NULL,
                        filename   TEXT NOT NULL,
                        bytes      INTEGER NOT NULL DEFAULT 0,
                        mime       TEXT NOT NULL DEFAULT '',
                        sha256     TEXT NOT NULL,
                        created_at INTEGER NOT NULL,
                        FOREIGN KEY (message_id) REFERENCES whisper_messages(id) ON DELETE CASCADE
                    );
                    CREATE INDEX IF NOT EXISTS idx_agentinbox_attachments_message
                        ON agentinbox_attachments(message_id);
                    CREATE INDEX IF NOT EXISTS idx_agentinbox_attachments_sha
                        ON agentinbox_attachments(sha256);
                `);
            },
        },
        {
            // v36: WORKSTATION OPERATOR (Tynn #248). One workspace on a machine may
            // be designated the operator, letting its agent act on EVERY workspace
            // on that workstation — not only the child projects an Ops project
            // governs. It exists because a hosting failure lands in whichever
            // workspace owns the site, while the agent with the context is in
            // another, and without this there is no site list, status or log to
            // read from the place that could fix it.
            //
            // Defaults to 0 and stays 0 on upgrade: this is authority ACROSS
            // workspace boundaries, so it is granted by an explicit act, never
            // inherited by a migration.
            version: 36,
            runner: (db) => {
                if (!workspaceColumns(db).has('workstation_operator')) {
                    db.exec(
                        `ALTER TABLE workspaces ADD COLUMN workstation_operator INTEGER NOT NULL DEFAULT 0`,
                    );
                }
            },
        },
        {
            // v37: GENIE APPS (Tynn #250). A workspace created by installing a
            // GApp is an ordinary envelope whose sites/services the installer
            // wrote — this column is what marks it as one, so the UI can present
            // it as an App rather than a project and the runtime can find the app
            // a window belongs to.
            //
            // A separate column rather than a new `shape`: `shape` carries a CHECK
            // constraint (`IN ('agi','simple')`), and SQLite cannot alter a CHECK
            // without rebuilding the table. Rebuilding `workspaces` — the primary
            // table every other feature keys off — is the wrong risk to take for a
            // label. NULL for every existing workspace, and for every workspace a
            // person creates by hand.
            version: 37,
            runner: (db) => {
                if (!workspaceColumns(db).has('app_kind')) {
                    db.exec(`ALTER TABLE workspaces ADD COLUMN app_kind TEXT`);
                }
            },
        },
        {
            // v38: MEMORY CLASSES on knowledge nodes (Tynn #250).
            //
            // The store answered one question — "find a node matching this text" —
            // which collapses four different retrieval problems into one. A node
            // now says which memory it is: profile / episodic / procedural /
            // knowledge.
            //
            // Every existing node becomes `knowledge`, which is what they all are:
            // documents and notes. That is also the safe direction — a note filed
            // as knowledge stays findable, whereas one mis-filed as `profile`
            // would start answering "what does the user prefer?".
            version: 38,
            runner: (db) => {
                const cols = new Set(
                    db
                        .prepare<[], { name: string }>(`PRAGMA table_info(knowledge_nodes)`)
                        .all()
                        .map((r) => r.name),
                );
                if (!cols.has('class')) {
                    db.exec(
                        `ALTER TABLE knowledge_nodes ADD COLUMN class TEXT NOT NULL DEFAULT 'knowledge'`,
                    );
                }
            },
        },
        {
            // v39: GENIE APP GRANTS (Tynn #250) — what the user consented to when
            // they installed an app, which is the record the bridge enforces on
            // every call it makes.
            //
            // Separate from `plugins` on purpose. A plugin extends Genie's own
            // surfaces; a GApp is a whole application with a workspace, hosting and
            // an authority scope, and folding the two into one table would mean one
            // shape trying to answer two different questions about trust.
            //
            // The row IS the authority, so the schema refuses what the model does
            // not have rather than trusting readers to interpret it: `scope` is
            // CHECKed, `app_id` is the primary key (two grants for one app would be
            // two answers to "what may this app do?"), and `revoked` defaults to 0
            // but is honoured as total — a revoked app's every call fails closed.
            version: 39,
            runner: (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS app_grants (
                        app_id            TEXT PRIMARY KEY,
                        workspace_id      TEXT NOT NULL,
                        name              TEXT NOT NULL,
                        version           TEXT NOT NULL,
                        slug              TEXT NOT NULL,
                        scope             TEXT NOT NULL CHECK (scope IN ('self','workspaces','workstation')),
                        workspaces_json   TEXT NOT NULL DEFAULT '[]',
                        capabilities_json TEXT NOT NULL DEFAULT '[]',
                        manifest_json     TEXT NOT NULL,
                        install_path      TEXT NOT NULL,
                        revoked           INTEGER NOT NULL DEFAULT 0,
                        installed_at      TEXT NOT NULL,
                        updated_at        TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_app_grants_workspace
                        ON app_grants(workspace_id);
                `);
            },
        },
        {
            // v40: an app someone is BUILDING (Tynn #250, P2).
            //
            // A dev-mode app runs from the developer's OWN folder rather than a
            // copy — the only way an edit is visible without reinstalling — and
            // its window gets dev tools. Both are weaker than a normal install, so
            // the state is STORED rather than inferred from a path: the window and
            // the Apps panel both have to say so, and a flag is harder to lose
            // than a heuristic.
            //
            // Defaults to 0 and stays 0 on upgrade. Nobody's installed apps should
            // acquire dev tools and an uncontrolled source folder by upgrading.
            version: 40,
            runner: (db) => {
                const cols = new Set(
                    db
                        .prepare<[], { name: string }>(`PRAGMA table_info(app_grants)`)
                        .all()
                        .map((r) => r.name),
                );
                if (!cols.has('dev_mode')) {
                    db.exec(
                        `ALTER TABLE app_grants ADD COLUMN dev_mode INTEGER NOT NULL DEFAULT 0`,
                    );
                }
            },
        },
        {
            // v41: WHERE an installed app came from (Tynn #250).
            //
            // The GitHub review is a screen that closes. "What is this thing on my
            // machine, and who gave it to me?" is a question asked weeks later, and
            // an app that cannot answer it is an app nobody can audit.
            //
            // It is also what lets an install notice that an app id already in use
            // is being replaced from a DIFFERENT origin — a stranger's fork
            // stepping into the shoes of something the user installed on purpose.
            //
            // NULL for apps installed before this, which is honest: Genie does not
            // know where they came from, and guessing would be worse than saying so.
            version: 41,
            runner: (db) => {
                const cols = new Set(
                    db
                        .prepare<[], { name: string }>(`PRAGMA table_info(app_grants)`)
                        .all()
                        .map((r) => r.name),
                );
                if (!cols.has('source_kind')) {
                    db.exec(`ALTER TABLE app_grants ADD COLUMN source_kind TEXT`);
                }
                if (!cols.has('source_origin')) {
                    db.exec(`ALTER TABLE app_grants ADD COLUMN source_origin TEXT`);
                }
                if (!cols.has('source_commit')) {
                    db.exec(`ALTER TABLE app_grants ADD COLUMN source_commit TEXT`);
                }
            },
        },
        {
            // v42: data KEPT when a GApp is uninstalled (Tynn #250, owner-directed).
            //
            // Uninstall asks whether to keep the app's data and settings, and a
            // reinstall from the SAME origin restores them. Losing everything
            // because you removed an app for a fortnight is hostile.
            //
            // The origin is the whole reason this table has a second column. An
            // app id is claimed by whoever writes the manifest, so data is kept for
            // an app FROM A PARTICULAR PLACE — come back from the same one and it
            // is restored; arrive from anywhere else and it is wiped, because that
            // is not the same app, it merely claims the same name.
            version: 42,
            runner: (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS app_retained_data (
                        app_id        TEXT PRIMARY KEY,
                        source_origin TEXT NOT NULL,
                        retained_at   TEXT NOT NULL
                    );
                `);
            },
        },
        {
            // v43: the service env BAKED into a terminal at spawn (genie#222).
            //
            // SUPERSEDED, and dropped again by v46 — kept only so an old database
            // replays the same sequence. See v46 for why the whole idea went away.
            //
            // A shell's environment is fixed once it starts, so when an engine's
            // published port moves, every terminal opened before the change carries
            // a port that no longer exists — and in a framework whose dotenv is
            // immutable, that stale value BEATS the app's own .env. The remedy is a
            // new terminal, and nothing told anybody so.
            //
            // PERSISTED rather than kept in memory, precisely because a Genie
            // restart is one of the things that moves a port: an in-memory record
            // would be lost at the exact moment it became worth having, while the
            // terminal itself survives in the pty host.
            version: 43,
            runner: (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS terminal_service_env (
                        terminal_id TEXT PRIMARY KEY,
                        env_json    TEXT NOT NULL,
                        injected_at TEXT NOT NULL
                    );
                `);
            },
        },
        {
            // v44: where THIS app's backups go (Tynn #250, step 4).
            //
            // The workstation setting is the default and lives in `settings`; this
            // is the per-app OVERRIDE the owner asked for, and it is resolved per
            // FIELD (`services/backup.ts`) so an app that wants a different folder
            // does not have to restate retention to get one.
            //
            // NULL means no override, which is the only honest default: an app
            // installed before this had no opinion about where its dumps land, and
            // inventing one would move somebody's backups.
            version: 44,
            runner: (db) => {
                const cols = new Set(
                    db
                        .prepare<[], { name: string }>(`PRAGMA table_info(app_grants)`)
                        .all()
                        .map((r) => r.name),
                );
                if (!cols.has('backup_json')) {
                    db.exec(`ALTER TABLE app_grants ADD COLUMN backup_json TEXT`);
                }
            },
        },
        {
            // v45: how many agent terminals this workspace may run (Tynn #117).
            //
            // An orchestrating agent fanned out six agent terminals in one session
            // and nothing would have stopped it at sixteen. Each is a pty, a model
            // session, and a share of the owner's attention.
            //
            // This is the workspace OVERRIDE; the default lives in `settings`
            // (`max_agent_terminals`). NULL means inherit, which is the only honest
            // default — a workspace that predates this expressed no opinion, and
            // stamping one on it would either loosen or tighten a limit nobody set.
            //
            // Deliberately NOT added to `updateWorkspace`'s allowlist, and its
            // setter is never imported into `main/mcp/`. An agent that can raise its
            // own cap has no cap, so the limit is reachable only from the IPC a
            // person's window calls — the same structural rule as
            // `workstation_operator` (v36).
            version: 45,
            runner: (db) => {
                if (!workspaceColumns(db).has('max_agent_terminals')) {
                    db.exec(
                        `ALTER TABLE workspaces ADD COLUMN max_agent_terminals INTEGER`,
                    );
                }
            },
        },
        {
            // v46: drop v43's `terminal_service_env` (genie#242).
            //
            // v43 recorded what Genie baked into each pty so a later read could
            // notice the values had moved and tell the user to open a new terminal.
            // That was a signal ABOUT a bug — the app's configuration living in a
            // shell's environment instead of in the `.env` the app reads — and the
            // bug is now fixed at the source: Genie writes the connection into the
            // repo's `.env` and keeps it current, and a terminal no longer carries
            // any name a framework reads. There is nothing left to drift, so there
            // is nothing to record. Dropped rather than left inert: a table nothing
            // writes is a question for whoever reads the schema next.
            version: 46,
            runner: (db) => {
                db.exec(`DROP TABLE IF EXISTS terminal_service_env;`);
            },
        },
        {
            // v47: fancy-flow workflows owned by a Genie App.
            //
            // RENAMED to `gapp_flows` by v67 (genie#394), which gave the general
            // name `flows` to the general automation system.
            //
            // The row is stored graph JSON that Genie will later EXECUTE, so two
            // things live in the SCHEMA rather than in whoever writes to it:
            //
            //   `app_id` is NOT NULL and a foreign key ON DELETE CASCADE. There is
            //   no ownerless flow, because a flow with no owner has no grant to be
            //   bounded by and the run path would have nothing to ask
            //   `decideAppCall` about. And uninstalling an app takes its flows with
            //   it — a scheduled flow outliving its app is exactly the thing that
            //   keeps firing after the user thought they had removed it.
            //
            // `enabled` is how a schedule is stopped without deleting the flow.
            // The graph itself carries the trigger, so there is nothing else to
            // turn off.
            version: 47,
            runner: (db) => {
                // v67 moved this table to `gapp_flows` and gave the name `flows`
                // to Genie's own automation system, whose rows have no `app_id`
                // at all. On a REPLAY -- the suite rewinds `schema_version` to
                // exercise an earlier migration and walks the tail again -- the
                // `CREATE TABLE IF NOT EXISTS` below would find that other table
                // sitting under the name and then index a column it does not
                // have. The canvas table's presence under its later name is what
                // says there is nothing to create here.
                if (migrationHasTable(db, 'gapp_flows')) return;
                db.exec(`
                    CREATE TABLE IF NOT EXISTS flows (
                        id         TEXT PRIMARY KEY,
                        app_id     TEXT NOT NULL REFERENCES app_grants(app_id) ON DELETE CASCADE,
                        name       TEXT NOT NULL,
                        graph_json TEXT NOT NULL,
                        enabled    INTEGER NOT NULL DEFAULT 1,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_flows_app ON flows(app_id);
                `);
            },
        },
        {
            // v48: the host port each engine surface is PUBLISHED on (genie#242
            // follow-up).
            //
            // Engine containers were published with no host port, so the runtime
            // picked a fresh one every time one was created — and a Genie restart
            // creates one. v46 removed the machinery for TELLING people the number
            // had moved; this is the machinery for it not moving.
            //
            // The number is derived first (`services/service-ports.ts`), so the
            // common case needs no row at all and a forgotten database still lands
            // on the same port. This table exists for the case derivation cannot
            // cover: when the preferred port was occupied and Genie had to pick
            // another, re-deriving later would hop BACK the day the squatter went
            // away — a move, which is the whole thing being fixed. So what was
            // actually used is remembered and re-requested.
            //
            // Keyed like `dev_service_engines`: the engine RECORD (engine+version,
            // plus the workspace for a dedicated one), because that is the unit a
            // container and its publication belong to — not the workspace, which
            // may be one of several sharing it.
            version: 48,
            runner: (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS dev_service_ports (
                        record_key TEXT NOT NULL,
                        port_name TEXT NOT NULL,
                        host_port INTEGER NOT NULL,
                        created_at INTEGER NOT NULL,
                        PRIMARY KEY (record_key, port_name)
                    )
                `);
            },
        },
        {
            // GApp Development Workspace (genie#245 / tynn.ai#204): the linked
            // Tynn project is marked `is_gapp`, so this is where a GApp is BUILT.
            //
            // A SEPARATE column from `app_kind` deliberately. `app_kind` is INSTALL
            // identity — Genie created or adopted this workspace to RUN a GApp, and
            // `apps/manage.ts` clears it to NULL on uninstall. This is DEVELOPMENT
            // identity, mirrored from a flag a human sets in Tynn. One column for
            // both would mean an uninstall silently un-marking somebody's dev
            // workspace, with "last writer wins" standing in for a precedence rule
            // nobody wrote down. Precedence is instead explicit and tested, in
            // renderer/lib/workspace-kind.ts.
            //
            // Nullable with no default: a pre-existing workspace is not retroactively
            // a GDW, and the first sync against Tynn decides.
            version: 49,
            runner: (db) => {
                if (!workspaceColumns(db).has('gapp_dev')) {
                    db.exec(`ALTER TABLE workspaces ADD COLUMN gapp_dev INTEGER`);
                }
            },
        },
        {
            // v50 — AMS makes an agent a durable configuration of its own.
            // A terminal is the TUI an agent may be running in, not the record
            // that makes the agent exist. This separation is what allows every
            // workspace to have a dormant Workspace Agent before its first boot,
            // and preserves identity/readiness while a terminal is restarted.
            version: 50,
            runner: (db) => {
                // The table this creates names the driver `provider`. On a
                // REPLAY against a current database it already exists as `tui`
                // (v63), and CREATE TABLE IF NOT EXISTS is then a no-op -- so
                // the INSERTs below have to name whichever one is actually
                // there. On a real upgrade that is `provider`, every time.
                const drv = driverColumn(db, 'workspace_agents');
                db.exec(`
                    CREATE TABLE IF NOT EXISTS workspace_agents (
                        id               TEXT PRIMARY KEY,
                        workspace_id     TEXT NOT NULL,
                        provider         TEXT,
                        name             TEXT NOT NULL,
                        purpose          TEXT NOT NULL DEFAULT '',
                        avatar           TEXT,
                        boot_cwd         TEXT,
                        persona_path     TEXT,
                        role             TEXT NOT NULL DEFAULT 'specialized'
                                         CHECK (role IN ('workspace','specialized','gapp')),
                        parent_agent_id  TEXT,
                        terminal_spec_id TEXT,
                        reachability     TEXT NOT NULL DEFAULT 'workspace'
                                         CHECK (reachability IN ('workspace','workstation','hidden')),
                        wake_on_dm       INTEGER NOT NULL DEFAULT 1,
                        ready_at         INTEGER,
                        created_at       INTEGER NOT NULL,
                        updated_at       INTEGER NOT NULL,
                        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
                        FOREIGN KEY (parent_agent_id) REFERENCES workspace_agents(id) ON DELETE SET NULL,
                        FOREIGN KEY (terminal_spec_id) REFERENCES terminal_specs(id) ON DELETE SET NULL
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_agents_key
                        ON workspace_agents(workspace_id, ${drv}, name);
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_agents_terminal
                        ON workspace_agents(terminal_spec_id) WHERE terminal_spec_id IS NOT NULL;
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_agents_master
                        ON workspace_agents(workspace_id) WHERE role = 'workspace';
                    CREATE INDEX IF NOT EXISTS idx_workspace_agents_parent
                        ON workspace_agents(parent_agent_id);

                    INSERT OR IGNORE INTO workspace_agents
                        (id, workspace_id, ${drv}, name, purpose, role, reachability,
                         wake_on_dm, created_at, updated_at)
                    SELECT 'workspace:' || id, id, NULL, 'workspace',
                           'Drive this workspace and coordinate its agents.',
                           'workspace', 'workspace', 1,
                           CAST(strftime('%s','now') AS INTEGER) * 1000,
                           CAST(strftime('%s','now') AS INTEGER) * 1000
                    FROM workspaces;

                    INSERT OR IGNORE INTO workspace_agents
                        (id, workspace_id, ${drv}, name, purpose, boot_cwd,
                         persona_path, role, parent_agent_id, terminal_spec_id,
                         reachability, wake_on_dm, created_at, updated_at)
                    SELECT
                        'agent:' || t.id,
                        t.workspace_id,
                        json_extract(t.meta_json, '$.agent'),
                        COALESCE(NULLIF(json_extract(t.meta_json, '$.whisper_purpose'), ''),
                                 NULLIF(t.label, ''), 'agent'),
                        COALESCE(NULLIF(json_extract(t.meta_json, '$.whisper_purpose'), ''),
                                 NULLIF(t.label, ''), 'Agent'),
                        t.cwd,
                        json_extract(t.meta_json, '$.gapp_persona'),
                        'specialized',
                        'workspace:' || t.workspace_id,
                        t.id,
                        CASE json_extract(t.meta_json, '$.whisper_scope')
                            WHEN 'all' THEN 'workstation'
                            WHEN 'hidden' THEN 'hidden'
                            ELSE 'workspace'
                        END,
                        1,
                        CAST(strftime('%s','now') AS INTEGER) * 1000,
                        CAST(strftime('%s','now') AS INTEGER) * 1000
                    FROM terminal_specs t
                    WHERE t.workspace_id IS NOT NULL
                      AND json_valid(t.meta_json)
                      AND json_type(t.meta_json, '$.agent') = 'text';
                `);
            },
        },
        {
            // v51 — AMS short-term workflow lists. These are intentionally
            // bounded and separate from roadmap/project management in Tynn.
            version: 51,
            runner: (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS workspace_todos (
                        id           TEXT PRIMARY KEY,
                        workspace_id TEXT NOT NULL,
                        agent_id     TEXT,
                        kind         TEXT NOT NULL CHECK (kind IN ('user','agent')),
                        text         TEXT NOT NULL,
                        status       TEXT NOT NULL DEFAULT 'open'
                                     CHECK (status IN ('open','thrown_back','refused','done')),
                        created_at   INTEGER NOT NULL,
                        updated_at   INTEGER NOT NULL,
                        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
                        FOREIGN KEY (agent_id) REFERENCES workspace_agents(id) ON DELETE SET NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_workspace_todos_open
                        ON workspace_todos(workspace_id, kind, status, created_at);

                    CREATE TABLE IF NOT EXISTS workspace_todo_events (
                        id         TEXT PRIMARY KEY,
                        todo_id    TEXT NOT NULL,
                        action     TEXT NOT NULL CHECK (action IN ('thrown_back','refused','done')),
                        comment    TEXT NOT NULL,
                        created_at INTEGER NOT NULL,
                        FOREIGN KEY (todo_id) REFERENCES workspace_todos(id) ON DELETE CASCADE
                    );
                    CREATE INDEX IF NOT EXISTS idx_workspace_todo_events_todo
                        ON workspace_todo_events(todo_id, created_at);
                `);
            },
        },
        {
            // v52 — an AMS agent is not ready until its harness-native message
            // transport has completed its own handshake. PTY input is never an
            // AgentInbox transport.
            version: 52,
            runner: (db) => {
                const columns = new Set(
                    db.prepare<[], { name: string }>('PRAGMA table_info(workspace_agents)')
                        .all()
                        .map((row) => row.name),
                );
                if (!columns.has('transport')) {
                    db.exec(`ALTER TABLE workspace_agents ADD COLUMN transport TEXT
                        CHECK (transport IN ('claude-channel','codex-app-server'))`);
                }
                if (!columns.has('transport_verified_at')) {
                    db.exec('ALTER TABLE workspace_agents ADD COLUMN transport_verified_at INTEGER');
                }
                if (!columns.has('transport_error')) {
                    db.exec('ALTER TABLE workspace_agents ADD COLUMN transport_error TEXT');
                }
            },
        },
        {
            // v53 — Kiwi and the Genie TUI are native AMS harnesses too. The
            // v52 `transport` column has a two-value SQLite CHECK that cannot be
            // widened in place without retargeting every foreign key. Preserve
            // it for old readers and add the unconstrained canonical column.
            version: 53,
            runner: (db) => {
                const columns = new Set(
                    db.prepare<[], { name: string }>('PRAGMA table_info(workspace_agents)')
                        .all()
                        .map((row) => row.name),
                );
                if (!columns.has('native_transport')) {
                    db.exec('ALTER TABLE workspace_agents ADD COLUMN native_transport TEXT');
                    db.exec('UPDATE workspace_agents SET native_transport = transport');
                }
            },
        },
        {
            // ONE AGENT, ONE ID. Migration 51 keyed terminal-backed AMS rows as
            // `agent:<terminalSpecId>` while AgentInbox keys the SAME agent on
            // `terminal_specs.meta.agent_id`. Nothing reconciled them, so an agent
            // could be READY in AMS and INVISIBLE to the inbox at once — observed
            // live: `thumbsUp` set `ready_at` while `agentinbox list` returned no
            // `self`, both calls reporting ok.
            //
            // The INBOX id wins: it already keys durable messages, receipts and
            // peer addressing, so renaming it would break message history and every
            // saved reference. The AMS row moves instead — nothing outside AMS
            // points at its id.
            //
            // Workspace rows (`workspace:<id>`) are untouched: they are not
            // terminal-backed, have no inbox identity to adopt, and are the target
            // of `parent_agent_id`.
            version: 54,
            runner: (db) => {
                const rows = db
                    .prepare<[], { id: string; inbox_agent_id: string | null }>(
                        `SELECT wa.id AS id,
                                json_extract(ts.meta_json, '$.agent_id') AS inbox_agent_id
                           FROM workspace_agents wa
                           JOIN terminal_specs ts ON ts.id = wa.terminal_spec_id
                          WHERE wa.terminal_spec_id IS NOT NULL`,
                    )
                    .all();
                const rename = db.prepare(
                    'UPDATE workspace_agents SET id = ?, updated_at = ? WHERE id = ?',
                );
                const now = Date.now();
                for (const row of rows) {
                    const next = String(row.inbox_agent_id ?? '').trim();
                    // Skip when there is nothing to adopt, when they already agree
                    // (so re-running is a true no-op and does not churn
                    // updated_at), and when the target id is somehow already taken
                    // — a collision must not destroy the row that holds it.
                    if (!next || next === row.id) continue;
                    const taken = db
                        .prepare<[string], { c: number }>(
                            'SELECT COUNT(*) AS c FROM workspace_agents WHERE id = ?',
                        )
                        .get(next);
                    if (taken && taken.c > 0) continue;
                    rename.run(next, now, row.id);
                }
            },
        },
        {
            // v55 — AN AGENT IS NOT ITS TUI.
            //
            // `UNIQUE (workspace_id, provider, name)` made the driver part of an
            // agent's IDENTITY: `claude:tynn` and `codex:tynn` were two agents,
            // and switching driver meant becoming someone else. The sibling
            // `UNIQUE (terminal_spec_id)` allowed at most ONE terminal per agent,
            // which forbids sidecars outright.
            //
            // So the record splits. `workspace_agents` keeps identity -- name,
            // purpose, scope, persona -- and `agent_runtimes` holds each TUI it
            // may run under, at most one of them fronted.
            //
            // `workspace_agents.provider` and `.terminal_spec_id` are KEPT, as a
            // cached mirror of the fronted runtime. A great deal of code reads
            // them, and mirroring is what makes this a staged migration rather
            // than a flag day.
            version: 55,
            runner: (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS agent_runtimes (
                        id TEXT PRIMARY KEY,
                        agent_id TEXT NOT NULL,
                        provider TEXT NOT NULL,
                        terminal_spec_id TEXT,
                        chat_session_id TEXT,
                        transport TEXT,
                        native_transport TEXT,
                        transport_verified_at INTEGER,
                        transport_error TEXT,
                        ready_at INTEGER,
                        fronted INTEGER NOT NULL DEFAULT 0,
                        created_at INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL,
                        FOREIGN KEY (agent_id) REFERENCES workspace_agents(id) ON DELETE CASCADE,
                        FOREIGN KEY (terminal_spec_id) REFERENCES terminal_specs(id) ON DELETE SET NULL
                    );
                    -- One terminal backs one runtime. Moved off workspace_agents,
                    -- where it also meant "one terminal per AGENT" and blocked sidecars.
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runtimes_spec
                        ON agent_runtimes(terminal_spec_id) WHERE terminal_spec_id IS NOT NULL;
                    -- At most one VISIBLE TUI per agent: flipping is a swap, not an add.
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runtimes_fronted
                        ON agent_runtimes(agent_id) WHERE fronted = 1;
                    -- One runtime per TUI per agent.
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runtimes_provider
                        ON agent_runtimes(agent_id, provider);
                    CREATE INDEX IF NOT EXISTS idx_agent_runtimes_agent
                        ON agent_runtimes(agent_id);
                `);
                if (!tableColumns(db, 'workspace_agents').has('collision_group')) {
                    db.exec('ALTER TABLE workspace_agents ADD COLUMN collision_group TEXT');
                }
                backfillRuntimes(db);
            },
        },
        {
            // v56 — a workspace can carry its OWN icon.
            //
            // Every `.agi` workspace drew the same generic cube, so a rail of six
            // was six identical glyphs -- an icon that identifies nothing, in the
            // exact spot the identifying mark belongs. The default is now the
            // workspace's initials (derived, so they differ by construction) and
            // this column is the override a human sets, in Genie or from Tynn.
            //
            // TEXT and free-form on purpose: an emoji today, a path or a URL
            // later, without another migration to widen it.
            version: 56,
            runner: (db) => {
                if (!workspaceColumns(db).has('icon')) {
                    db.exec('ALTER TABLE workspaces ADD COLUMN icon TEXT');
                }
            },
        },
        {
            // v57 — THE WORKSPACE AGENT IS A DESIGNATION, NOT A PLACEHOLDER ROW.
            //
            // v50 seeded one agent per workspace named 'workspace' with
            // provider NULL, and nothing ever gave it a driver, a terminal or a
            // purpose. Once the renderer started drawing registered agents,
            // those inert rows became squares labelled "works..." that click
            // into nothing -- a phantom agent in every workspace on the estate.
            //
            // The concept was wrong, not just the rendering. A workspace agent
            // is whichever of a workspace's REAL agents is designated the
            // default and boots from the workspace root: a property OF an agent,
            // chosen by the owner. `role = 'workspace'` plus the existing
            // `UNIQUE (workspace_id) WHERE role = 'workspace'` index already
            // says exactly that; the placeholders were the only thing occupying
            // the slot.
            //
            // Only INERT ones go -- no provider, no terminal, no runtime.
            // Inertness is the test, not the name: deleting a row that owns a
            // live terminal would strand the terminal.
            //
            // NOTHING is auto-designated. A workspace whose agents were never
            // ranked has no default until someone says so; choosing here would
            // put an agent in the boots-from-root position on a migration's
            // guess. `parent_agent_id` references these rows and is
            // ON DELETE SET NULL, so the children survive un-parented.
            version: 57,
            runner: (db) => {
                const drv = driverColumn(db, 'workspace_agents');
                db.prepare(
                    `DELETE FROM workspace_agents
                      WHERE role = 'workspace'
                        AND ${drv} IS NULL
                        AND terminal_spec_id IS NULL
                        AND id NOT IN (SELECT agent_id FROM agent_runtimes)`,
                ).run();
            },
        },
        {
            // v58 -- A RETIRED COMMAND MUST NOT SURVIVE IN THE CACHES THAT
            // OUTRANK THE REGISTRY.
            //
            // `resolveAgentCommand` reads, in order: the spec's own
            // `meta.agent_command`, the owner's `agent_command_<id>` SETTING,
            // then the registry default. The Genie TUI shipped with a default of
            // `genie-tui`, which is not a binary -- selecting it produced
            // `bash: genie-tui: command not found`.
            //
            // Correcting the registry fixed nothing on any machine that had
            // already run Genie: both higher-precedence copies had the dead
            // string baked in, so the fix could not reach an existing install
            // and the agent kept failing after the release said it was repaired.
            //
            // The defect is that a DEFAULT was persisted into two caches. This
            // clears them wherever they hold a value that is no longer any
            // provider's command, so resolution falls through to the registry --
            // the one place the default belongs.
            //
            // EXACT matches only. A command the owner actually chose survives
            // untouched, or the repair becomes a worse bug than the one it fixes.
            version: 58,
            runner: (db) => {
                for (const [provider, retired] of Object.entries(RETIRED_AGENT_COMMANDS)) {
                    for (const dead of retired) {
                        db.prepare(
                            `UPDATE settings SET value = ''
                              WHERE key = ? AND value = ?`,
                        ).run(`agent_command_${provider}`, dead);
                        db.prepare(
                            `UPDATE terminal_specs
                                SET meta_json = json_remove(meta_json, '$.agent_command')
                              WHERE json_extract(meta_json, '$.agent') = ?
                                AND json_extract(meta_json, '$.agent_command') = ?`,
                        ).run(provider, dead);
                    }
                }
            },
        },
        {
            // v59 -- THE INTERACTIVE CHANNEL FLAG MUST NOT SURVIVE IN A STORED
            // COMMAND.
            //
            // genie#324 stopped Genie ADDING
            // `--dangerously-load-development-channels`, which makes Claude Code
            // stop and ask permission on EVERY launch. But a spec written before
            // that has the flag baked into `meta_json.agent_command`, and a
            // revive replays the stored command verbatim (terminal/ipc.ts) — the
            // builder, and the strip inside it, never run. Those agents would
            // keep prompting forever while the fix sat unused.
            //
            // The same shape as v58 above: a value persisted into a cache that
            // outranks the corrected default. Same remedy — REMOVE the stored
            // command so resolution falls through to the builder, rather than
            // editing a string inside JSON.
            //
            // Only specs that actually carry the flag are touched. A command the
            // owner chose survives untouched, or the repair is worse than the bug.
            version: 59,
            runner: (db) => {
                db.prepare(
                    `UPDATE terminal_specs
                        SET meta_json = json_remove(meta_json, '$.agent_command')
                      WHERE json_extract(meta_json, '$.agent_command')
                            LIKE '%--dangerously-load-development-channels%'`,
                ).run();
            },
        },
        {
            // v60 -- THE TUI IS PART OF AN AGENT'S IDENTITY AGAIN.
            //
            // The owner's rule: *"provider should be tui because the tui is what
            // determines the provider and supports TUIs that can use any
            // provider, so provider itself is not important for agent identity.
            // Unique should be on workspace, tui, name."*
            //
            // v55 went the other way -- it collapsed (workspace, provider, name)
            // to (workspace, name) on the reasoning that an agent switching
            // driver is the same agent. The cost was `collision_group`: a partial
            // index escape hatch for every pair that clashed on the way down,
            // left for a human to settle by hand. On this workstation that
            // stranded `codex:moic-slave` against `genie:moic-slave`
            // indefinitely. Under (workspace, tui, name) that pair is simply two
            // agents, and the collision stops existing rather than waiting to be
            // resolved.
            //
            // VERIFIED AGAINST THE LIVE DATABASE BEFORE WRITING THIS: all 29
            // agents already satisfy the new key -- zero duplicate
            // (workspace, provider, name) groups, zero NULL providers among
            // them. So this renames nothing, merges nothing and drops nothing.
            // That is the only reason it is safe to tighten a key on real rows.
            //
            // The index is still PARTIAL on `collision_group IS NULL` for the
            // same reason v55 made it so: a plain UNIQUE would FAIL TO BUILD on
            // a profile that does hold a duplicate and take the whole upgrade
            // down with it. Marks are cleared first, and only re-applied to rows
            // that still clash under the WIDER key -- which is strictly fewer.
            version: 60,
            runner: (db) => {
                const drv = driverColumn(db, 'workspace_agents');
                // DROP THE NARROW KEY FIRST. v55's `idx_workspace_agents_name` is
                // UNIQUE (workspace_id, name) WHERE collision_group IS NULL, and
                // the MARK is the only thing keeping a colliding pair out of it.
                // Clearing the marks while that index is still live puts both
                // halves straight back into it, and the upgrade dies on
                // `UNIQUE constraint failed: workspace_agents.workspace_id,
                // workspace_agents.name` before it can widen anything.
                //
                // Found by running the ladder against a COPY OF THE LIVE
                // DATABASE: `codex:moic-slave` and `genie:moic-slave`, marked,
                // in one workspace -- exactly the pair this migration exists to
                // dissolve. It reproduces nowhere else, because every migration
                // fixture is built on a FRESH database where no row is marked.
                db.exec('DROP INDEX IF EXISTS idx_workspace_agents_name');
                // A row with no TUI cannot be keyed by one. `role='workspace'`
                // rows carry a NULL driver by design, and SQLite treats NULLs as
                // distinct in a unique index, so they neither collide nor need
                // an exemption -- but they must not keep a mark either.
                db.prepare('UPDATE workspace_agents SET collision_group = NULL').run();
                db.prepare(
                    `UPDATE workspace_agents
                        SET collision_group = workspace_id || ':' || COALESCE(${drv}, '') || ':' || name
                      WHERE (workspace_id, ${drv}, name) IN (
                            SELECT workspace_id, ${drv}, name FROM workspace_agents
                             WHERE ${drv} IS NOT NULL
                             GROUP BY workspace_id, ${drv}, name HAVING COUNT(*) > 1)`,
                ).run();
                db.exec(`
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_agents_tui_name
                        ON workspace_agents(workspace_id, ${drv}, name)
                        WHERE collision_group IS NULL;
                `);
            },
        },
        {
            // v61 -- A SACRED WORKSPACE'S ONE RESERVED NAME.
            //
            // `general`, `genie` and `tynn` are refused as agent names
            // (`agents/reserved-names.ts`). The owner's rule: *"NO GENERAL. WE
            // need a term block list. so no genie or tynn either (except tynn is
            // allowed in this specific workspace of course)"*.
            //
            // `sacred_name` is that exception, expressed as a GRANT of ONE term
            // rather than a boolean, so being sacred as `tynn` does not also
            // unlock `genie`. NULL -- every workspace, until something grants it
            // -- means the block list applies in full.
            //
            // It is deliberately NOT seeded here. Tynn is the source of truth for
            // which project is sacred (the owner asked for it to be marked "in
            // tynn and when in genie"), so the grant ARRIVES from Tynn rather
            // than being guessed locally. Hard-coding a ULID or a project name
            // would mark one workstation's row and no one else's, and would be a
            // lie on every other machine.
            //
            // Existing agents are unaffected: the block list is checked when an
            // agent is REGISTERED or RENAMED, never on the way in from the
            // database, so no already-registered agent stops working while the
            // grant is in flight.
            // Idempotent ADD COLUMN like v2/v4/v5/v6/v7/v8 — the migration
            // replay tests run the ladder against a database that already holds
            // the column, and a bare ALTER throws `duplicate column name` and
            // takes the whole upgrade transaction down with it.
            version: 61,
            runner: (db) => {
                const cols = workspaceColumns(db);
                if (!cols.has('sacred_name')) {
                    db.exec(`ALTER TABLE workspaces ADD COLUMN sacred_name TEXT`);
                }
            },
        },
        {
            // v62 -- THE DORMANT `general` AGENTS GO.
            //
            // `general` was never a name anyone chose: `normalizePurpose`
            // returned it for any agent joining with no stated purpose, so an
            // unnamed terminal became `{tui}:general`. #326 stopped Genie
            // inventing them and v61's block list stops one being typed back in.
            // This clears the rows already sitting there.
            //
            // ONLY THE DORMANT ONES. The owner's instruction, and the only safe
            // rule: deleting a row that owns a terminal would STRAND that
            // terminal, the same hazard v57 called out. Measured on the live
            // database before this was written -- of 7 agents named `general`
            // across seven workspaces, THREE hold a live terminal spec and FOUR
            // hold none.
            //
            // Inertness is tested THROUGH THE RUNTIME as well as the agent row.
            // v55 moved terminal binding onto `agent_runtimes`, so an agent
            // whose own `terminal_spec_id` is NULL may still be driving a
            // terminal through one; checking only the legacy column would delete
            // a live agent. The join onto `terminal_specs` is deliberate -- a
            // runtime pointing at a spec that no longer exists is holding
            // nothing.
            //
            // The name is matched WHOLE, so `general-purpose` is untouched.
            // `agent_runtimes.agent_id` is ON DELETE CASCADE, so the runtimes of
            // a deleted agent go with it rather than becoming orphans.
            version: 62,
            runner: (db) => {
                db.prepare(
                    `DELETE FROM workspace_agents
                      WHERE name = 'general'
                        AND terminal_spec_id IS NULL
                        AND id NOT IN (
                            SELECT r.agent_id
                              FROM agent_runtimes r
                              JOIN terminal_specs t ON t.id = r.terminal_spec_id
                        )`,
                ).run();
            },
        },
        {
            // v63 -- THE `provider` COLUMN IS `tui`.
            //
            // The owner's rule, already quoted in v60: *"provider should be tui
            // because the tui is what determines the provider and supports TUIs
            // that can use any provider, so provider itself is not important for
            // agent identity."*
            //
            // v60 did the part that mattered -- identity became
            // (workspace, tui, name) -- but left the column called `provider`, so
            // the schema said one thing and the rule said another. This is the
            // naming catching up.
            //
            // A RENAME, not a new column plus a backfill: the values are already
            // right, and a copy leaves two columns that can disagree. SQLite
            // rewrites the dependent INDEX definitions as part of RENAME COLUMN,
            // which is what makes this safe on `idx_workspace_agents_tui_name`
            // and `idx_agent_runtimes_provider` -- both key on this column, and a
            // key silently lost is how v60's collision settlement would come
            // undone.
            //
            // Guarded per table so the ladder can be replayed: RENAME COLUMN
            // throws if the old name is gone, and that would take the whole
            // upgrade transaction with it.
            version: 63,
            runner: (db) => {
                if (tableColumns(db, 'workspace_agents').has('provider')) {
                    db.exec('ALTER TABLE workspace_agents RENAME COLUMN provider TO tui');
                }
                if (tableColumns(db, 'agent_runtimes').has('provider')) {
                    db.exec('ALTER TABLE agent_runtimes RENAME COLUMN provider TO tui');
                }
            },
        },
        {
            // v64 -- BACKFILL THE WORKSPACE AGENT ON WORKSPACES THAT PREDATE IT.
            //
            // `firstAgentRole()` gives the first agent registered in a workspace
            // the `workspace` role, but it decides that AT REGISTRATION TIME. A
            // workspace whose agents were all registered before that shipped
            // never got one, and nothing backfilled it: measured on the live
            // workstation at beta.295, SEVENTEEN of the eighteen workspaces that
            // had agents held no `role='workspace'` row at all. The code was
            // correct going forward and wrong on every machine that already
            // existed -- which is the whole shape of #324's third symptom, and
            // invisible to a test that only ever sees a fresh database.
            //
            // THE OWNER'S RULE, and the only part that is a judgement call:
            // backfill ONLY where the choice is unambiguous, considering ONLY
            // `claude` agents.
            //
            //   exactly one claude agent -> promote it
            //   two or more              -> leave it, a human picks
            //   none                     -> leave it
            //
            // Guessing is worse than waiting here. The TWA's terminal is "the
            // one that drives most work there" and is master of the agents it
            // spawns, and `idx_workspace_agents_master` allows exactly ONE such
            // row per workspace -- so a wrong pick has to be demoted before it
            // can be corrected, and it silently changes which terminal work
            // lands in until someone notices.
            //
            // Restricting candidates to `claude` is not a stylistic preference:
            // the common real shape is a claude agent beside a codex `-slave`
            // sidecar (`fancy` + `fancy-slave`, `weaver` + `weaver-slave`), and
            // a sidecar is the one agent that must never become the workspace's
            // master. It also makes those workspaces unambiguous rather than
            // ties, so the rule promotes them instead of parking them.
            //
            // `role='gapp'` is excluded for the reason firstAgentRole() already
            // excludes it: a GApp's agent belongs to the app, and handing it the
            // single workspace slot would lock the workspace out of ever having
            // an agent of its own.
            //
            // The `NOT EXISTS` guard is what makes this idempotent AND safe to
            // replay: claiming the role where one is already held would violate
            // the UNIQUE index, and a throw inside a migration takes the whole
            // upgrade transaction down with it.
            version: 64,
            runner: (db) => {
                db.exec(`
                    UPDATE workspace_agents
                       SET role = 'workspace'
                     WHERE role = 'specialized'
                       AND tui = 'claude'
                       AND NOT EXISTS (
                            SELECT 1 FROM workspace_agents peer
                             WHERE peer.workspace_id = workspace_agents.workspace_id
                               AND peer.role = 'workspace'
                       )
                       AND (
                            SELECT COUNT(*) FROM workspace_agents cand
                             WHERE cand.workspace_id = workspace_agents.workspace_id
                               AND cand.tui = 'claude'
                               AND cand.role = 'specialized'
                       ) = 1
                `);
            },
        },
        {
            // v65 -- THE NO-OP CHANNEL FLAG MUST NOT SURVIVE IN A STORED COMMAND.
            //
            // Exactly v59's shape, for the flag that replaced the one v59 swept.
            //
            // #324 moved Genie from `--dangerously-load-development-channels` to
            // `--channels`, to escape a prompt that fires on every launch. That
            // flag cannot register OUR channel: the approved allowlist is
            // Anthropic-curated (`claude-plugins-official`) and a bare `server:`
            // entry of ours is not on it, so `--channels` matches nothing and --
            // per the channels reference -- Claude Code "drops the events
            // silently and returns no error". A visible prompt became an
            // invisible no-op.
            //
            // `withClaudeAgentInboxChannelLaunch` now strips it and adds the
            // working flag, but that is the BUILDER. v59's whole lesson is that
            // a revive replays `meta_json.agent_command` verbatim
            // (terminal/ipc.ts) and the builder never runs -- so every spec
            // written while #324 shipped would keep launching with a channel
            // that silently does nothing, forever.
            //
            // Same remedy as v59: REMOVE the stored command so resolution falls
            // through to the builder, rather than editing a string inside JSON.
            // Only specs that actually carry the flag are touched, so a command
            // the owner chose survives untouched.
            //
            // The pattern is anchored on `--channels ` with its leading double
            // hyphen and trailing space: `development-channels` has a single
            // hyphen before `channels`, so a stored command carrying the CORRECT
            // flag is not matched and re-resolved on every upgrade.
            version: 65,
            runner: (db) => {
                db.prepare(
                    `UPDATE terminal_specs
                        SET meta_json = json_remove(meta_json, '$.agent_command')
                      WHERE json_extract(meta_json, '$.agent_command')
                            LIKE '%--channels server:%'`,
                ).run();
            },
        },
        {
            // v66 -- WISHES (Tynn story #270).
            //
            // RENAMED to `flows` by v67 (genie#394). The `flows` named below is
            // v47's GApp canvas table, which v67 renamed to `gapp_flows`.
            //
            // A Wish is Genie's Workflow: a Recipe (what runs), Triggers (when)
            // and a Scope (who sees it). The recipe is referenced by ID rather
            // than stored, because the body of an unattended Wish must be
            // first-party code that was reviewed when it was written -- a JSON
            // row cannot carry a function, and that is the point rather than a
            // limitation (see `wishes/admission.ts`).
            //
            // `purpose` is a COLUMN, not something inferred from the title: the
            // menu groups by it, and a grouping key that is guessed from a
            // string is a grouping that silently reshuffles when somebody
            // renames a Wish.
            //
            // No app foreign key, unlike `flows`. A Wish may belong to a GApp,
            // to a workspace, or to the workstation itself, so ownership lives
            // in `scope_json` where all three shapes fit. What a GApp-owned Wish
            // needs -- disappearing when its app does -- is the cascade
            // `flows` gets from its column, and it is deliberately NOT built
            // here: GApp-authored Wishes are not yet creatable, and a
            // half-enforced ownership rule is worse than an absent one.
            version: 66,
            runner: (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS wishes (
                        id            TEXT PRIMARY KEY,
                        title         TEXT NOT NULL,
                        purpose       TEXT NOT NULL,
                        description   TEXT,
                        scope_json    TEXT NOT NULL,
                        triggers_json TEXT NOT NULL,
                        recipe_json   TEXT NOT NULL,
                        enabled       INTEGER NOT NULL DEFAULT 1,
                        created_at    TEXT NOT NULL,
                        updated_at    TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_wishes_purpose ON wishes(purpose);
                `);
            },
        },
        {
            // v67 -- WISHES BECOME FLOWS (genie#394).
            //
            // Genie's automation system is called Flows, and the module that
            // shipped as Wishes in v0.7.0-beta.298 IS that system. The name was
            // already spoken for by v47's table of fancy-flow canvas graphs
            // owned by a Genie App -- the narrower thing, one GApp's workflows
            // -- so that becomes `gapp_flows` and the general name goes to the
            // general system. Order matters: `flows` vacates before `wishes`
            // takes the name.
            //
            // ## The scope ladder collapses to three
            //
            // `system / workspace / gapp`, and `exposure` is GONE: a `gapp`
            // scope IS internal to its GApp, which is all the field's
            // `'internal'` value ever said.
            //
            // The value with nowhere else to go is `exposure: 'workstation'` --
            // a GApp's Flow that appeared workstation-wide. Under three scopes
            // the thing visible workstation-wide is `system`, so that is where
            // it lands, losing the `appId` it carried. That id bought nothing:
            // v66 deliberately declined the app foreign key and the uninstall
            // cascade `flows` had, so no behaviour anywhere read it. Landing it
            // on `gapp` instead would HIDE a Flow its author published, which is
            // the worse of the two mistakes.
            //
            // Rewritten in JS rather than with `json_extract`, because a row can
            // be hand-edited into something that is not JSON at all and the
            // whole module's rule (`flows/store.ts`) is that such a row is left
            // alone, not dropped and not thrown over.
            //
            // `ALTER TABLE ... RENAME TO` has no `IF NOT EXISTS`, so the rename
            // states its own precondition -- the arrival of `gapp_flows` is what
            // says this database has already taken v67. Re-running the migration
            // must converge rather than throw, and it IS re-run: the suite's way
            // to exercise an earlier migration is to rewind `schema_version` and
            // replay the tail, which walks v66 (recreating an empty `wishes`)
            // straight back into v67.
            version: 67,
            runner: (db) => {
                if (migrationHasTable(db, 'gapp_flows')) {
                    // Already renamed. A `wishes` table here is v66 replayed
                    // after the fact: nothing has written to that name since the
                    // rename, so an EMPTY one is the replay's own litter and
                    // goes. One with rows in it is not litter and is left for a
                    // human -- a migration that deletes data it never looked at
                    // is a worse outcome than a stray table.
                    const left =
                        migrationHasTable(db, 'wishes') &&
                        (db
                            .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM wishes')
                            .get()?.n ?? 0) === 0;
                    if (left) db.exec('DROP TABLE wishes');
                } else {
                    db.exec(`
                        DROP INDEX IF EXISTS idx_flows_app;
                        DROP INDEX IF EXISTS idx_wishes_purpose;
                        ALTER TABLE flows RENAME TO gapp_flows;
                        ALTER TABLE wishes RENAME TO flows;
                        CREATE INDEX IF NOT EXISTS idx_gapp_flows_app ON gapp_flows(app_id);
                        CREATE INDEX IF NOT EXISTS idx_flows_purpose ON flows(purpose);
                    `);
                }

                const rows = db
                    .prepare<[], { id: string; scope_json: string }>(
                        'SELECT id, scope_json FROM flows',
                    )
                    .all();
                const update = db.prepare('UPDATE flows SET scope_json = ? WHERE id = ?');

                for (const row of rows) {
                    let scope: Record<string, unknown> | null = null;
                    try {
                        const parsed: unknown = JSON.parse(row.scope_json);
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                            scope = parsed as Record<string, unknown>;
                        }
                    } catch {
                        /* unreadable — left exactly as the author left it */
                    }
                    if (!scope) continue;

                    let next: Record<string, unknown> | null = null;
                    if (scope.kind === 'workstation') {
                        next = { kind: 'system' };
                    } else if (scope.kind === 'app') {
                        next =
                            scope.exposure === 'workstation'
                                ? { kind: 'system' }
                                : { kind: 'gapp', appId: String(scope.appId ?? '') };
                    }
                    if (next) update.run(JSON.stringify(next), row.id);
                }
            },
        },
        {
            // v68 -- KNOWLEDGE SCOPE + PROVENANCE, and the one-time link audit
            // (genie#395; knowledge graph spec §4.1, §6.2, §6.5).
            //
            // Guarded throughout -- column-exists before every ADD COLUMN,
            // IF NOT EXISTS on every index and table, INSERT OR IGNORE in the
            // audit -- because the migration suite REWINDS `schema_version` and
            // replays the tail, so this runs again against a database that
            // already has everything it creates. v47 learned that the hard way:
            // `ALTER TABLE ... RENAME TO` has no IF NOT EXISTS and took 36 tests
            // in four unrelated files down with it until it was guarded.
            //
            // ## Scope
            //
            // A node says WHOSE REASONING it belongs in --
            // `system | workspace | gapp`. Every existing node becomes `system`
            // with no ref, `origin='local'`, `role='part'`, which is EXACTLY
            // today's behaviour: the store has always been workstation-wide and
            // every node has always been visible from everywhere. Nothing moves
            // and nothing disappears. Same safe direction as v38's
            // `class='knowledge'` backfill.
            //
            // Nodes are deliberately NOT retro-assigned to a workspace. There is
            // no evidence in the row about which one wrote them -- the tool never
            // resolved a workspace at all -- and a wrong guess HIDES knowledge,
            // which is the one outcome worse than showing too much.
            //
            // Columns rather than a `scope_json` blob (which is what `wishes`
            // uses): a wish is read whole and filtered in memory, while a
            // knowledge node is filtered on EVERY retrieval, inside SQL, under an
            // FTS join. `json_extract` per candidate cannot be indexed the way
            // `(scope_kind, scope_ref)` can.
            //
            // ## Provenance
            //
            // `origin`/`origin_ns`/`origin_key`/`origin_revision`/`origin_hash`
            // plus a pending-update slot are what a later converger needs to tell
            // "Genie wrote this and the user never touched it" from "the user
            // edited it" -- so an improved guide can be offered without clobbering
            // somebody's edit.
            //
            // `origin_ns` and `origin_key` are LIVE from this migration: link
            // resolution reads them to decide which nodes a `[[wikilink]]` inside
            // a given node may reach. The rest -- revision, hash, the pending slot
            // -- are inert until the converger lands, deliberately: the schema
            // change and the behaviour change are separate releases.
            //
            // `origin_ns` duplicates the prefix of `origin_key`, and the CHECK is
            // what keeps the one denormalisation honest: a row where the two
            // disagree cannot be written at all. It is spelled slightly stronger
            // than the spec's version -- `origin_key IS NOT NULL AND ...` --
            // because a CHECK whose expression evaluates to NULL PASSES in SQLite,
            // so `origin_ns` set with no `origin_key` would otherwise slip
            // through.
            //
            // ## The one-time link audit
            //
            // Link resolution stops guessing: where two nodes share a title, the
            // shipped resolver's map let the LAST row silently win, and it now
            // resolves to nothing instead. That is safe in one direction only --
            // it can turn a WRONG link into no link, never a right link into a
            // wrong one -- but a link that "worked" by luck stops working and the
            // user has no reason to look. A graph that quietly gets sparser is
            // exactly the kind of silent change this design objects to everywhere
            // else.
            //
            // So this walks every edge ONCE, with the OLD title map, before the
            // new resolver is live, and records each ref that used to resolve and
            // now would not. The count rides out on the migration result so it can
            // be said out loud rather than left in a column. Rows are kept, never
            // deleted, so "I dismissed it and now I want it back" has an answer.
            //
            // Empty is the expected result on most machines. An audit that reports
            // nothing is the audit doing its job, not a wasted one.
            version: 68,
            runner: (db) => {
                const cols = tableColumns(db, 'knowledge_nodes');
                const add = (name: string, decl: string): void => {
                    if (!cols.has(name)) {
                        db.exec(`ALTER TABLE knowledge_nodes ADD COLUMN ${name} ${decl}`);
                    }
                };
                add('scope_kind', `TEXT NOT NULL DEFAULT 'system'`);
                add('scope_ref', 'TEXT');
                add('origin', `TEXT NOT NULL DEFAULT 'local'`);
                // origin_key first: origin_ns's CHECK references it.
                add('origin_key', 'TEXT');
                add(
                    'origin_ns',
                    `TEXT CHECK (origin_ns IS NULL
                                 OR (origin_key IS NOT NULL AND origin_key LIKE origin_ns || '/%'))`,
                );
                add('origin_revision', 'INTEGER');
                add('origin_hash', 'TEXT');
                add('role', `TEXT NOT NULL DEFAULT 'part'`);
                add('sort_order', 'INTEGER NOT NULL DEFAULT 0');
                add('pending_revision', 'INTEGER');
                add('pending_body', 'TEXT');
                add('pending_hash', 'TEXT');

                db.exec(`
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_nodes_origin_key
                        ON knowledge_nodes(origin_key) WHERE origin_key IS NOT NULL;
                    CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_scope
                        ON knowledge_nodes(scope_kind, scope_ref);
                    CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_ns
                        ON knowledge_nodes(origin_ns, sort_order);
                    CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_title
                        ON knowledge_nodes(title COLLATE NOCASE);

                    -- Without this, a user deleting a Genie guide node or a pack
                    -- node gets it back on the next converge, forever -- the same
                    -- clobber the hash comparison exists to prevent, in a
                    -- different hat.
                    CREATE TABLE IF NOT EXISTS knowledge_origin_tombstones (
                        origin_key TEXT PRIMARY KEY,
                        deleted_at INTEGER NOT NULL,
                        reason     TEXT
                    );

                    CREATE TABLE IF NOT EXISTS knowledge_link_audit (
                        from_id     TEXT NOT NULL,
                        to_ref      TEXT NOT NULL,
                        was_id      TEXT NOT NULL,
                        candidates  INTEGER NOT NULL,
                        reviewed_at INTEGER,
                        PRIMARY KEY (from_id, to_ref)
                    );
                `);

                ambiguousLinks = auditTightenedLinks(db);
            },
        },
        {
            // v69 -- A STOP THAT SURVIVES THE NEXT LAUNCH (genie#407).
            //
            // (v68 is taken by work in flight elsewhere.)
            //
            // A site's `enabled` flag was answering two questions at once:
            // "is this site configured to be served" and "should it be running
            // right now". Boot read the first to decide the second, so a site
            // the user stopped came back on the next launch -- and an upgrade is
            // just a launch nobody chose, which is where it was noticed.
            //
            // They cannot share a field because they do not want the same
            // storage. `enabled` belongs in the `.agi` envelope's project.json:
            // git-TRACKED, so the site definition travels with the repo. A stop
            // is the opposite kind of fact -- one person, one machine, one
            // moment -- and putting it there made it a diff teammates inherited
            // and something a `git pull` could silently undo. So the desired RUN
            // state lives here, in genie.db, which is local by construction.
            //
            // No backfill. Under the old code a stop wrote `enabled:false`, and
            // a site in that state still does not resume, so nobody's stop is
            // lost by this arriving empty.
            version: 69,
            runner: (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS site_run_state (
                        site_id    TEXT PRIMARY KEY,
                        stopped    INTEGER NOT NULL DEFAULT 0,
                        updated_at INTEGER NOT NULL
                    );
                `);
            },
        },
        {
            // v70 -- FLOW RUN HISTORY (genie#394; the Flow Manager).
            //
            // `FlowRunLog` existed from the start and went nowhere: the runtime
            // handed it to a callback that console.logs the non-`ran` cases and
            // drops the rest. So "did my Flow run last night, and what happened"
            // had no answer that survived the process, and a manager could show
            // a list of Flows and nothing about whether any had ever acted.
            //
            // ## Refusals are history too
            //
            // Every outcome is stored, not just `ran` -- `blocked`, `refused`
            // and `error` alongside it. That is `runtime.ts`'s own stated
            // principle applied to storage: a Flow silently not firing is the
            // hardest failure here to debug, and "last outcome: the loop guard
            // held it" is the answer that makes opening the manager worth doing.
            // A table of successes would show a Flow refused nightly for a week
            // as one that had simply never run.
            //
            // ## No foreign key to `flows`
            //
            // Recording happens inside the runtime's finish callback, and a
            // Flow deleted while its body was mid-run would turn an FK
            // violation into a throw on a path whose whole job is to report what
            // happened. `deleteFlow` drops the history explicitly instead
            // (`deleteFlowRunsIn`), which is the same outcome without a way to
            // fail at the worst moment.
            //
            // Epoch-ms INTEGERs rather than ISO text: these are compared and
            // ordered on every read, never displayed raw, and the manager's list
            // column is "the newest run per Flow" -- an index scan over
            // (flow_id, finished_at DESC).
            version: 70,
            runner: (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS flow_runs (
                        run_id      TEXT PRIMARY KEY,
                        flow_id     TEXT NOT NULL,
                        event       TEXT,
                        outcome     TEXT NOT NULL,
                        reason      TEXT,
                        started_at  INTEGER NOT NULL,
                        finished_at INTEGER NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_flow_runs_flow
                        ON flow_runs(flow_id, finished_at DESC);
                `);
            },
        },
        {
            // v71 — the bundled WebSocket engine stops being called `reverb`.
            //
            // Genie ships Sockudo, not Laravel's Reverb, and keying the engine
            // `reverb` stated otherwise in the services UI, the `manageService`
            // enum and the `.gen` hostname. The engine key is STORED, in the
            // `dev_services` JSON blob, so renaming the catalog alone would leave
            // an existing workspace holding an engine that no longer exists —
            // `engineSpecFor` returns undefined and the service disappears
            // instead of being renamed.
            //
            // Only the key moves. The workspace's password is untouched (it is
            // what the running server derives every app secret from), and the
            // `REVERB_*` environment names are NOT part of this: those are
            // Laravel's driver contract, are still emitted, and are the reason
            // this rename costs no hosted app anything. See `env-wiring.ts`.
            version: 71,
            runner: (db) => {
                const rows = db
                    .prepare<[], { id: string; dev_services: string | null }>(
                        `SELECT id, dev_services FROM workspaces
                          WHERE dev_services IS NOT NULL AND dev_services != ''`,
                    )
                    .all();
                const write = db.prepare(
                    'UPDATE workspaces SET dev_services = ? WHERE id = ?',
                );
                for (const row of rows) {
                    let parsed: unknown;
                    try {
                        parsed = JSON.parse(row.dev_services ?? '');
                    } catch {
                        // A blob that does not parse is already unreadable to the
                        // store; rewriting it here would only turn one corrupt
                        // value into a different corrupt value.
                        continue;
                    }
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
                    const services = parsed as Record<string, { engine?: unknown }>;
                    let moved = false;
                    for (const entry of Object.values(services)) {
                        if (entry && typeof entry === 'object' && entry.engine === 'reverb') {
                            entry.engine = 'websockets';
                            moved = true;
                        }
                    }
                    // Only rewrite what actually changed — an untouched blob keeps
                    // its exact bytes and its key order.
                    if (moved) write.run(JSON.stringify(services), row.id);
                }
            },
        },
        {
            // v72 -- THE DRAIN ROSTER (genie#389).
            //
            // The drain builds a list of everything that was RUNNING when it
            // began -- agents, sites, background processes -- nudges the agents
            // to hand off, and holds the upgrade until the roster clears. That
            // same list is the RESTORE list on the other side of the restart.
            //
            // It has to be a table because of where it is used: it is written
            // by one process image and read by the next one, and an in-memory
            // roster is gone at exactly the moment the restore needs it. The
            // symptom would be the one the issue is about -- an upgrade that
            // leaves everything down and the user to work out what was up.
            //
            // WHAT WAS RUNNING, not what is configured. Restoring on a broader
            // rule restarts what the user deliberately switched off (genie#407),
            // at the moment they are least able to tell it from Genie's doing.
            // The restore filters this list AGAIN through the durable desired
            // state genie#412 landed (`site_run_state`, `meta.user_stopped`), so
            // a stop between the drain and the restore still wins.
            //
            // Keyed on (kind, ref): a site id and a process spec id are separate
            // namespaces, and one row per pair means recording a roster twice is
            // not restarting anything twice.
            //
            // (v71 is taken by the websockets engine rename, which landed on
            // main while this was in review. Two entries numbered the same
            // would BOTH run on a database at v70 -- `current` is read once,
            // before the loop -- but a database that already reached 71 by
            // running only the other one would never get this table at all.)
            version: 72,
            runner: (db) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS drain_roster (
                        kind         TEXT NOT NULL,
                        ref          TEXT NOT NULL,
                        label        TEXT NOT NULL DEFAULT '',
                        workspace_id TEXT NOT NULL DEFAULT '',
                        seq          INTEGER NOT NULL DEFAULT 0,
                        recorded_at  INTEGER NOT NULL,
                        PRIMARY KEY (kind, ref)
                    );
                `);
            },
        },
    ];

    const apply = d.transaction(
        (m: { version: number; runner: (db: Database.Database) => void }) => {
            m.runner(d);
            d.prepare('INSERT INTO schema_version (version) VALUES (?)').run(
                m.version,
            );
        },
    );

    for (const m of migrations) {
        if (m.version > current) {
            apply(m);
            applied.push(m.version);
        }
    }
    return { applied, ambiguousLinks };
}

/**
 * WHAT THE TIGHTENED RESOLVER BREAKS, named once, before it goes live.
 *
 * Walks every edge with BOTH resolvers -- the shipped last-row-wins title map and
 * the unique-or-null rule replacing it -- and records each ref that used to
 * resolve and now would not. Returns how many it found.
 *
 * Only a ref that USED to resolve is recorded. A forward reference (`[[Foo]]`
 * written before Foo exists) resolved to nothing before and resolves to nothing
 * now; reporting it would bury the real findings under the normal ones.
 *
 * `INSERT OR IGNORE`, so a re-run keeps a `reviewed_at` the user has already set
 * rather than resurrecting a notice they dismissed. The count returned is what
 * the audit FOUND, not what it inserted, so a second pass reports the same
 * number rather than zero.
 *
 * Cost is one pass over `knowledge_edges` against a map already in memory, at a
 * moment when no pack exists and no graph is large.
 */
function auditTightenedLinks(db: Database.Database): number {
    const nodes = db
        .prepare<[], { id: string; title: string; slug: string }>(
            'SELECT id, title, slug FROM knowledge_nodes',
        )
        .all();
    if (nodes.length === 0) return 0;

    const legacy = buildLegacyResolver(nodes);
    // Every node is `origin='local'` at this point -- the backfill has just run
    // and nothing has ever written a namespace -- so the new ladder is its rule
    // 6: a bare title across everything, unique-or-null.
    const tightened = buildLinkResolver(
        nodes.map((n) => ({ ...n, originNs: null, originKey: null })),
    );

    const edges = db
        .prepare<[], { from_id: string; to_ref: string }>(
            'SELECT DISTINCT from_id, to_ref FROM knowledge_edges',
        )
        .all();
    const record = db.prepare(
        `INSERT OR IGNORE INTO knowledge_link_audit (from_id, to_ref, was_id, candidates)
         VALUES (?, ?, ?, ?)`,
    );

    let found = 0;
    for (const e of edges) {
        const before = legacy(e.to_ref);
        if (!before.id) continue;
        if (tightened(null, e.to_ref).id) continue;
        found++;
        record.run(e.from_id, e.to_ref, before.id, before.candidates);
    }
    return found;
}

function workspaceColumns(d: Database.Database): Set<string> {
    const rows = d
        .prepare<[], { name: string }>(`PRAGMA table_info(workspaces)`)
        .all();
    return new Set(rows.map((r) => r.name));
}

/** Column-name set for an arbitrary table (idempotent-ALTER guards). */
/**
 * Give every existing agent a runtime, then decide what is safe to enforce.
 *
 * Split out and exported because it is the only interesting half of v55 and the
 * half that must be provably CONSERVATIVE. It runs inside the migration and is
 * idempotent, so re-running it is a no-op.
 *
 * COLLISIONS ARE NOT RESOLVED HERE. Collapsing `(workspace, provider, name)` to
 * `(workspace, name)` collides wherever a workspace holds `claude:general` AND
 * `codex:general` -- two agents with two conversations, two inbox identities and
 * two histories. Which one survives is the owner's call, made against previews of
 * the real terminals; a migration that picked for them would silently discard a
 * conversation on an unattended host at upgrade time.
 *
 * So colliding rows are MARKED and left whole, and the name index is PARTIAL --
 * `WHERE collision_group IS NULL` -- which is what lets them coexist. A plain
 * UNIQUE(workspace_id, name) would simply fail to build against such a profile
 * and take the whole upgrade down with it.
 */
export function backfillRuntimes(d: Database.Database): void {
    const now = Date.now();

    // The driver column is `provider` up to v62 and `tui` from v63; this runs
    // from v55, so on a real upgrade it meets `provider` -- but the ladder is
    // also replayed against a current database, where it meets `tui`.
    const srcCol = driverColumn(d, 'workspace_agents');
    const dstCol = driverColumn(d, 'agent_runtimes');

    // One fronted runtime per agent that names a TUI. `role='workspace'` rows
    // carry a NULL driver by design -- they are the workspace's own agent and
    // have never had one -- so they get no runtime until one is chosen.
    const agents = d
        .prepare<[], {
            id: string;
            driver: string | null;
            terminal_spec_id: string | null;
            transport: string | null;
            native_transport: string | null;
            transport_verified_at: number | null;
            transport_error: string | null;
            ready_at: number | null;
        }>(
            `SELECT id, ${srcCol} AS driver, terminal_spec_id, transport, native_transport,
                    transport_verified_at, transport_error, ready_at
               FROM workspace_agents
              WHERE ${srcCol} IS NOT NULL
                AND id NOT IN (SELECT agent_id FROM agent_runtimes)`,
        )
        .all();
    const insert = d.prepare(
        `INSERT INTO agent_runtimes
           (id, agent_id, ${dstCol}, terminal_spec_id, transport, native_transport,
            transport_verified_at, transport_error, ready_at, fronted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    for (const a of agents) {
        insert.run(
            `runtime:${a.id}`,
            a.id,
            a.driver,
            a.terminal_spec_id,
            a.transport,
            a.native_transport,
            a.transport_verified_at,
            a.transport_error,
            a.ready_at,
            now,
            now,
        );
    }

    // Mark every name a workspace holds more than once. The group key is stable
    // and readable so the resolution UI can list a collision by what it is.
    d.prepare(
        `UPDATE workspace_agents
            SET collision_group = workspace_id || ':' || name
          WHERE (workspace_id, name) IN (
                SELECT workspace_id, name FROM workspace_agents
                 GROUP BY workspace_id, name HAVING COUNT(*) > 1)`,
    ).run();

    // The old key goes; the new one is partial so marked collisions survive it.
    d.exec(`
        DROP INDEX IF EXISTS idx_workspace_agents_key;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_agents_name
            ON workspace_agents(workspace_id, name) WHERE collision_group IS NULL;
    `);
}

function tableColumns(d: Database.Database, table: string): Set<string> {
    const rows = d
        .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
        .all();
    return new Set(rows.map((r) => r.name));
}


/**
 * The name of the agent DRIVER column on `table`, as it stands right now.
 *
 * It is `provider` up to v62 and `tui` from v63 (Tynn story #262). Migrations
 * WRITTEN before the rename still have to name it, and on a real upgrade they
 * run while it is still `provider` -- but the ladder is also REPLAYED (the
 * migration suite re-runs it from an earlier version against a current
 * database), and there the same statement meets `tui`.
 *
 * Resolving the name instead of hard-coding it keeps each migration doing
 * exactly what it always did, whenever it runs. The alternative -- freezing
 * `provider` into statements that a later migration renames out from under --
 * makes those migrations non-replayable, and a migration you cannot re-run is
 * one nobody can test.
 */
function driverColumn(d: Database.Database, table: string): 'provider' | 'tui' {
    return tableColumns(d, table).has('tui') ? 'tui' : 'provider';
}

function terminalSpecColumns(d: Database.Database): Set<string> {
    const rows = d
        .prepare<[], { name: string }>(`PRAGMA table_info(terminal_specs)`)
        .all();
    return new Set(rows.map((r) => r.name));
}

/**
 * Ensure the invariant that every workspace owns one Workspace Agent, even
 * before that agent has a provider or terminal. Exported with an explicit DB
 * argument so migrations/import paths can converge the same invariant without
 * relying on the process singleton.
 */
/**
 * The agent DESIGNATED as this workspace's default — the one that boots from the
 * workspace root and is the default target for actions that do not name one.
 *
 * It is a property OF a real agent, not a separate record. v50 used to seed a
 * placeholder named 'workspace' with no provider and no terminal; those were
 * phantoms in every workspace and v57 removed them.
 *
 * Undefined is a NORMAL state: a workspace whose agents were never ranked has no
 * default until someone picks one.
 */
export function workspaceDefaultAgent(
    workspaceId: string,
    database?: Database.Database,
): WorkspaceAgentRow | undefined {
    return (database ?? getDb())
        .prepare<[string], WorkspaceAgentRow>(
            `SELECT *, COALESCE(native_transport, transport) AS transport FROM workspace_agents
              WHERE workspace_id = ? AND role = 'workspace'`,
        )
        .get(workspaceId);
}

/**
 * Designate one of a workspace's agents as its default.
 *
 * ONE transaction, because `UNIQUE (workspace_id) WHERE role = 'workspace'`
 * means promoting before demoting trips the index, and demoting first leaves a
 * window with no default at all. Pass null to clear the designation.
 *
 * Refuses an agent from a DIFFERENT workspace rather than obeying: that would
 * put a stranger in the boots-from-root position, and the index would be
 * satisfied by the wrong pair. Returns whether anything changed.
 */
export function setWorkspaceDefaultAgent(
    workspaceId: string,
    agentId: string | null,
): boolean {
    const d = getDb();
    if (agentId) {
        const target = d
            .prepare<[string], { workspace_id: string }>(
                'SELECT workspace_id FROM workspace_agents WHERE id = ?',
            )
            .get(agentId);
        if (!target || target.workspace_id !== workspaceId) return false;
    }
    const now = Date.now();
    d.transaction(() => {
        d.prepare(
            `UPDATE workspace_agents SET role = 'specialized', updated_at = ?
              WHERE workspace_id = ? AND role = 'workspace'`,
        ).run(now, workspaceId);
        if (agentId) {
            d.prepare(
                `UPDATE workspace_agents SET role = 'workspace', updated_at = ? WHERE id = ?`,
            ).run(now, agentId);
        }
    })();
    return true;
}

/**
 * The user's own mark for a workspace or an agent — ONE glyph, or nothing.
 *
 * Both slots are ~18px squares sitting in a row of other 18px squares, so the
 * value has to be a single grapheme. Rejecting longer input is not fussiness:
 * a pasted word renders as overflow in the workspace rail, the flyout row, the
 * avatar stack and the agent grid at once, and there is no width anywhere to
 * absorb it.
 *
 * Empty means NULL, never ''. The renderer treats any truthy value as the
 * user's choice, so an empty string would render a blank square permanently
 * instead of returning to the initials or the provider's brand mark.
 *
 * Counted in GRAPHEMES rather than code points, because the emoji people
 * actually pick are several code points each — a flag is two, a ZWJ sequence
 * like a person-at-a-laptop is five or more — and a code-point cap either
 * rejects them or, worse, stores half of one.
 */
function normalizeGlyph(value: string | null | undefined, label: string): string | null {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return null;
    let count: number;
    try {
        const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        count = Array.from(seg.segment(trimmed)).length;
    } catch {
        // No Segmenter: fall back to code points. Coarser, so it lets a couple
        // of odd sequences through rather than rejecting a valid emoji.
        count = Array.from(trimmed).length > 8 ? 2 : 1;
    }
    if (count > 1) {
        throw new Error(
            `${label} is too long: expected a single glyph, got ${count}. ` +
                'Clear it to fall back to the default mark.',
        );
    }
    return trimmed;
}

/** Set (or clear, with '' / null) a workspace's own icon. */
export function setWorkspaceIcon(
    d: Database.Database,
    workspaceId: string,
    icon: string | null | undefined,
): void {
    const value = normalizeGlyph(icon, 'Workspace icon');
    d.prepare('UPDATE workspaces SET icon = ? WHERE id = ?').run(value, workspaceId);
}

/** Set (or clear, with '' / null) an agent's avatar. Cleared means the
 *  provider's brand mark comes back, which is the documented default. */
export function setAgentAvatar(
    d: Database.Database,
    agentId: string,
    avatar: string | null | undefined,
): void {
    const value = normalizeGlyph(avatar, 'Agent avatar');
    d.prepare('UPDATE workspace_agents SET avatar = ?, updated_at = ? WHERE id = ?').run(
        value,
        Date.now(),
        agentId,
    );
}

// Settings helpers ------------------------------------------------------

export interface Settings extends ProviderSettingKeys {
    primary_workspace?: string;
    /** Last-activated workspace id in the master view; seeds the active workspace on launch. */
    active_workspace?: string;
    default_env_file?: string;
    global_hotkey?: string;
    /** Terminal-scoped hotkeys (Tynn #246/#247). Unlike `global_hotkey` these are
     *  NOT OS-wide: they bind only while a Genie terminal panel has focus, so F5
     *  and Ctrl+K still belong to whatever app the user is actually in. */
    ftq_nudge_hotkey?: string;
    command_window_hotkey?: string;
    /** Command Window prompt library (Tynn #247): JSON array of {id,label,text}. */
    saved_prompts?: string;
    tynn_host?: string;
    notifications_muted?: string; // JSON-encoded array of category keys
    auto_update?: 'on' | 'off';
    /** Default shell id ('git-bash' | 'pwsh' | … | 'custom'). Empty = auto-detect. */
    terminal_shell?: string;
    /** Manual executable line, used when terminal_shell === 'custom'. */
    terminal_custom_cmd?: string;
    /** Max panels visible at once per workspace. String-encoded (settings are k/v text). Default '4'. */
    max_views?: string;
    /** WORKSTATION DEFAULT for how many agent terminals one workspace may run
     *  (Tynn #117). String-encoded; `'unlimited'` turns the cap off. A workspace
     *  may override it (`workspaces.max_agent_terminals`), and only a person can —
     *  no agent-facing tool writes either. Resolve via `effectiveAgentCap`, never
     *  read raw. Default '8'. */
    max_agent_terminals?: string;
    /** Per-workspace draggable-grid track sizes, JSON-encoded. Keyed by
     *  `${connKey}|${workspaceId}|${signature}` — connKey scopes it per window
     *  (local vs a driven host) so different hosts don't collide. */
    layout_json?: string;
    /** CLIENT-LOCAL panel VIEW state (visible set, focus, maximize, layout mode)
     *  per `${connKey}|${workspaceId}`, JSON-encoded. Deliberately local (NOT
     *  bridged to a host): it's how THIS device lays out a workspace's panels,
     *  distinct from the host-owned `terminal_specs` identity/`enabled`. See
     *  `renderer/lib/view-state.ts`. Default '{}'. */
    view_state_json?: string;
    /** Inject a per-shell OSC-7 prompt hook so resumed terminals start in the
     *  right cwd. 'off' disables it; anything else (incl. unset) is ON. */
    track_cwd?: 'on' | 'off';
    /** Tier 3: keep terminals running in a detached pty-host so they survive a
     *  full quit of the app. Defaults ON — an unset value resolves to 'on' so
     *  terminals AND the agents running in them survive a Genie restart
     *  everywhere; an explicit 'off' opts back into the in-process T1/T2 backend
     *  (which restores panels from a snapshot but cold-spawns a fresh shell). */
    detached_terminals?: 'on' | 'off';
    /** Whether Genie launches minimized to the tray instead of opening its
     *  window. Defaults 'off' — Genie starts OPEN. 'on' starts in the tray only
     *  (the window opens on the first tray click / global hotkey). */
    start_minimized?: 'on' | 'off';
    /** One-shot flag set by `restartAndApply` before an auto-update quit and
     *  consumed on the next boot: reopen the master window even if the updater's
     *  relaunch looks like an autostart launch. '1' = reopen; cleared to '' after
     *  boot reads it. */
    reopen_after_update?: '1' | '';
    /** Last Genie version whose What’s New modal was shown to the user. */
    whats_new_seen_version?: string;
    /** Last Genie version announced to agents through AgentInbox. */
    agent_upgrade_announced_version?: string;
    /** Play a chime when an agent calls imDone. Defaults 'off'. */
    notify_sound?: 'on' | 'off';
    /** Show an OS notification (tray popup) when an agent calls imDone.
     *  Defaults 'off'. */
    notify_toast?: 'on' | 'off';
    /** Which sound the imDone alert plays (gated by notify_sound). 'synth' (the
     *  built-in Web Audio chime, default), a bundled wav name ('3tootpipe' |
     *  'dingdongdoink'), 'custom' (sound_imdone_custom file), or 'off' (silent
     *  even with notify_sound on). */
    sound_imdone?: 'off' | 'synth' | '3tootpipe' | 'dingdongdoink' | 'sparkle' | 'triumphant' | 'winddown' | 'custom';
    /** Absolute path to the user's custom imDone sound (used when
     *  sound_imdone === 'custom'). Empty = none chosen. */
    sound_imdone_custom?: string;
    /** Which sound the ForceTheQuestion alert plays. Same value set as
     *  sound_imdone; default 'synth'. */
    sound_forcequestion?: 'off' | 'synth' | '3tootpipe' | 'dingdongdoink' | 'sparkle' | 'triumphant' | 'winddown' | 'custom';
    /** Absolute path to the user's custom ForceTheQuestion sound (used when
     *  sound_forcequestion === 'custom'). Empty = none chosen. */
    sound_forcequestion_custom?: string;
    /** Fixed loopback port for the agent-integration MCP server. String-encoded
     *  (settings are k/v text). Default '51717' (obscure, outside the OS
     *  ephemeral range). Changing it requires restarting the MCP server. */
    mcp_port?: string;
    /** Phone web UI server (Settings → Remote control). Opt-in: 'off' (default)
     *  withholds the phone UI; 'on' serves it on the Tailscale-only HTTP/WS server. */
    mobile_enabled?: 'on' | 'off';
    /** Desktop Genie Remote (Settings → Remote control). Opt-in: 'off' (default) |
     *  'on'. Independent of mobile_enabled — either binds the host server; the phone
     *  UI route is gated on mobile_enabled, so remote works with mobile off. */
    remote_enabled?: 'on' | 'off';
    remote_network_local?: 'on' | 'off';
    remote_network_lan?: 'on' | 'off';
    remote_network_tailscale?: 'on' | 'off';
    remote_network_tynn?: 'on' | 'off';
    /** PendingQuestions UX — GLOBAL ForceTheQuestion availability: 'available'
     *  (pop the modal) or 'dnd' (queue to the top-bar inbox, no popup). Narrower
     *  per-workspace / per-workstation overrides live in the JSON maps below;
     *  resolved most-specific-first (see main/ask/availability.ts). */
    ftq_availability?: 'available' | 'dnd';
    /** Per-WORKSPACE availability overrides — JSON `{ [workspaceId]: 'available'|'dnd' }`. */
    ftq_availability_workspaces?: string;
    /** Per-WORKSTATION availability overrides — JSON `{ [workstationId]: 'available'|'dnd' }`. */
    ftq_availability_workstations?: string;
    /** The agent-facing reply when the user is in DND (user-configurable). Empty
     *  ⇒ the built-in default (availability.ts DEFAULT_DND_MESSAGE). */
    ftq_dnd_message?: string;
    /** Still play the ForceTheQuestion chime while in DND (no modal, no focus steal),
     *  so a heads-down owner HEARS a question land without a fullscreen app being
     *  yanked out. Gated by `notify_sound` too. Default 'off'. */
    ftq_dnd_sound?: 'on' | 'off';
    /** Fixed port for the mobile server, bound on the Tailscale IP. String-
     *  encoded; default '51718' (obscure, beside the MCP port). Same Integer/
     *  range guard as mcp_port. Changing it requires restarting the server. */
    mobile_port?: string;
    /** The Genie Browser — Genie's own built-in browser for `.gen` dev sites.
     *  Default 'on': it is how a dev site is opened at all, so it is enabled
     *  unless the owner deliberately turns it off. Lives with the container
     *  runtime on the workstation Dev Server settings page. */
    genie_browser_enabled?: 'on' | 'off';
    /** Keep the Genie endpoint synced into a workspace's Claude `.mcp.json`.
     *  Default 'on'; 'off' means Genie never touches that file (manual edits
     *  stick). */
    mcp_sync_claude?: 'on' | 'off';
    /** Keep the Genie endpoint synced into a workspace's Cursor
     *  `.cursor/mcp.json`. Default 'on'; 'off' leaves it alone. */
    mcp_sync_cursor?: 'on' | 'off';
    /** Inject workspace-scoped MCP config into Codex Agent Terminal launches.
     *  Default 'on'; 'off' leaves Codex launch commands alone. */
    mcp_sync_codex?: 'on' | 'off';
    /** Keep the Genie brief synced into a workspace's AGENTS.md. Default 'on';
     *  'off' leaves it alone. */
    mcp_sync_agents?: 'on' | 'off';
    /** Pull Tynn-managed provider credentials (Anthropic/OpenAI keys, GitHub
     *  token, Claude subscription) and inject them into agent terminals. Default
     *  'off' — the host generates no encryption key and makes no request until
     *  the owner turns it on, so nothing changes for a host whose owner has not
     *  opted in. See `main/tynn/managed-credentials-service.ts`. */
    managed_credentials?: 'on' | 'off';
    /** Auto-provision Genie workspaces for an Ops project's governed children
     *  (the provisionWorkspaces MCP tool). 'off' (default): the agent proposes a
     *  plan and the user approves each clone via the OS modal. 'on': the agent
     *  provisions the missing child workspaces directly, no prompt. */
    ops_auto_provision_workspaces?: 'on' | 'off';
    /** Terminal copy/paste behaviour:
     *  - 'contextmenu' (default): right-click Copy/Paste menu + Ctrl+Shift+C/V.
     *  - 'linux': highlight-to-copy, right-click (and middle-click) to paste.
     *  - 'winmac': Ctrl/Cmd+C copies the selection, Ctrl/Cmd+V pastes. */
    terminal_copy_paste?: 'contextmenu' | 'linux' | 'winmac';
    /** Ai.System — a user-authored instruction set Genie injects into EVERY
     *  workspace's AGENTS.md, inside the auto-managed GENIE PROTOCOL block.
     *  Capped at AI_SYSTEM_MAX chars (enforced UI + server-side) so AGENTS.md
     *  doesn't bloat. Default '' (nothing injected). */
    ai_system?: string;
    /** Collapsed workspace sidebar rows — JSON-encoded string[] of workspace
     *  ids (k/v values are text, like notifications_muted). Persists the
     *  sidebar expand/collapse state across restarts. Default '[]'. */
    collapsed_workspaces?: string;
    /** The MACHINE's default language version per tool, JSON-encoded
     *  (`{"php":"8.3.33","node":"24.19.0"}`). Only versions Genie itself
     *  installed under `<userData>/toolchain` may appear; a stale or foreign
     *  entry is ignored at read time (`defaultVersionFor`). Written by the
     *  Toolchain page's `toolchain:set-default` ipc. Default '{}'. */
    toolchain_defaults?: string;
    /** The WORKSTATION's default GApp backup policy, JSON-encoded
     *  (`{"enabled":true,"dir":"/Volumes/Shared/genie","keep":7}`). This is the
     *  default an installed app inherits; an app may override any FIELD of it
     *  (`app_grants.backup_json`). Read through `parseBackupSettings`
     *  (`dev-server/services/backup.ts`), which falls back to Genie's own data
     *  folder — never to "off" — so an unreadable value cannot silently stop the
     *  backups. Tynn #250, step 4. */
    gapp_backup?: string;
    // `agent_command_<id>` and `agent_flags_<id>` for every provider come from
    // ProviderSettingKeys (genie#261), so adding a provider adds its two keys
    // with no edit here.
    //
    //   agent_command_<id>  the CLI invocation runAgent launches — a wrapper or a
    //                       full path. Defaults to the registry's defaultCommand;
    //                       `custom` has none, so it means "require an explicit
    //                       command".
    //   agent_flags_<id>    ALWAYS-ON launch flags appended AFTER the resolved
    //                       command and BEFORE the session-id flag:
    //                       `<command> <flags> --session-id <uuid>`. Default ''.
    /** GApp AI Provider (genie#245): which AI TUI a Genie App's DECLARED agents
     *  launch under — `claude` | `codex` | `custom`. The user's choice, once per
     *  WORKSTATION, never the app's: a GApp says it needs an agent and the
     *  workstation decides what that agent is, for the same reason as the
     *  agent-terminal cap — it is asking for someone else's compute and
     *  subscription. Human-only, like `max_agent_terminals`: written by the
     *  Settings page, and never imported into `main/mcp/`. Resolve through
     *  `resolveGappProvider`, never read raw — an unset value inherits
     *  `agent_default` rather than asking the same question twice. Default ''. */
    gapp_ai_provider?: string;
    /** Workstation Setup: the owner's chosen DEFAULT agent id (claude/codex/custom),
     *  written by the desktop setup wizard. HOST-SOURCED. Default '' (none chosen). */
    agent_default?: string;
    /** Workstation Setup: the enabled-agent ids as a JSON string array, written by
     *  the desktop setup wizard. HOST-SOURCED. Default '' (none chosen). */
    agent_enabled?: string;
    /** Private GitHub HTTPS repository used to back up the Genie OS workspace. */
    genie_os_backup_repo?: string;
    /** Plugin System Developer Mode. When 'on', the user may install/enable
     *  UNSIGNED plugins (with escalated consent + restricted runtime) and manage
     *  developer-trusted signing keys. Default 'off' — the signed registry is the
     *  production path (§12.3). */
    plugins_developer_mode?: 'on' | 'off';
    /** ONE-SHOT marker for the genie #83 repair: 'done' once boot has re-enabled the
     *  BUNDLED first-party plugins that the old trust gate silently switched off
     *  (`setPluginEnabled(id, false)` destroyed the user's intent, and the self-heal
     *  then faithfully preserved the zero). Set after the pass runs — so a plugin the
     *  user DELIBERATELY turns off afterwards is never switched back on. */
    plugins_bundled_enable_repair?: string;
    /** This machine's Tynn Workstation id — set once the local Genie SELF-REGISTERS
     *  + enrolls as a workstation (design brief genie-service-separation §2a). In
     *  the clear (like `github_user`) so the transport can address the
     *  `private-workstation.{id}` channel without decrypting. Absent = not enrolled. */
    workstation_id?: string;
    /** The base64 ciphertext of this workstation's Ed25519 PRIVATE key (PKCS8 PEM),
     *  encrypted at rest through the OS keychain — mirrors `github_token_enc`. The
     *  raw key NEVER lands in plaintext on disk. Absent = not enrolled. */
    workstation_key_enc?: string;
}

/** Hard cap on the Ai.System instruction set. Enforced BOTH in the Settings UI
 *  (`maxLength`) and server-side (in the `settings:set` IPC handler) so the text
 *  injected into every workspace's AGENTS.md can't bloat the file. */
export const AI_SYSTEM_MAX = 2000;

export function getAllSettings(): Settings {
    const d = getDb();
    const rows = d
        .prepare<[], { key: string; value: string }>(
            'SELECT key, value FROM settings',
        )
        .all();
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;

    return {
        // Pass ALL raw k/v through first. The github + updater modules
        // store their own keys (github_token_enc, github_user,
        // github_client_id, updater_repo, …) and read them back via
        // `getAllSettings() as Record<string,string>` — without this
        // spread those keys were silently dropped, so getToken() always
        // returned null and GitHub could never report "connected" even
        // after a successful Device Flow. The typed defaults below
        // override the spread for the keys Settings cares about.
        ...out,
        primary_workspace: out['primary_workspace'],
        active_workspace: out['active_workspace'],
        default_env_file: out['default_env_file'] ?? '.env',
        global_hotkey:
            out['global_hotkey'] ??
            (process.platform === 'darwin'
                ? 'CommandOrControl+Shift+W'
                : 'Control+Shift+W'),
        ftq_nudge_hotkey: out['ftq_nudge_hotkey'] ?? 'F5',
        command_window_hotkey: out['command_window_hotkey'] ?? 'CommandOrControl+K',
        saved_prompts: out['saved_prompts'] ?? '[]',
        tynn_host: out['tynn_host'] ?? 'https://tynn.ai',
        notifications_muted: out['notifications_muted'] ?? '[]',
        auto_update: (out['auto_update'] as 'on' | 'off') ?? 'on',
        terminal_shell: out['terminal_shell'] ?? '',
        terminal_custom_cmd: out['terminal_custom_cmd'] ?? '',
        max_views: out['max_views'] ?? '4',
        max_agent_terminals: out['max_agent_terminals'] ?? '8',
        layout_json: out['layout_json'] ?? '{}',
        view_state_json: out['view_state_json'] ?? '{}',
        track_cwd: (out['track_cwd'] as 'on' | 'off') ?? 'on',
        detached_terminals: (out['detached_terminals'] as 'on' | 'off') ?? 'on',
        start_minimized: (out['start_minimized'] as 'on' | 'off') ?? 'off',
        notify_sound: (out['notify_sound'] as 'on' | 'off') ?? 'off',
        notify_toast: (out['notify_toast'] as 'on' | 'off') ?? 'off',
        sound_imdone:
            (out['sound_imdone'] as Settings['sound_imdone']) ?? 'synth',
        sound_imdone_custom: out['sound_imdone_custom'] ?? '',
        sound_forcequestion:
            (out['sound_forcequestion'] as Settings['sound_forcequestion']) ??
            'synth',
        sound_forcequestion_custom: out['sound_forcequestion_custom'] ?? '',
        mcp_port: out['mcp_port'] ?? '51717',
        mobile_enabled: (out['mobile_enabled'] as 'on' | 'off') ?? 'off',
        remote_network_local: (out['remote_network_local'] as 'on' | 'off') ?? 'on',
        remote_network_lan: (out['remote_network_lan'] as 'on' | 'off') ?? 'off',
        remote_network_tailscale: (out['remote_network_tailscale'] as 'on' | 'off') ?? 'on',
        remote_network_tynn: (out['remote_network_tynn'] as 'on' | 'off') ?? 'on',
        ftq_availability: (out['ftq_availability'] as 'available' | 'dnd') ?? 'available',
        ftq_availability_workspaces: out['ftq_availability_workspaces'] ?? '',
        ftq_availability_workstations: out['ftq_availability_workstations'] ?? '',
        ftq_dnd_message: out['ftq_dnd_message'] ?? '',
        ftq_dnd_sound: (out['ftq_dnd_sound'] as 'on' | 'off') ?? 'off',
        mobile_port: out['mobile_port'] ?? '51718',
        genie_browser_enabled:
            (out['genie_browser_enabled'] as 'on' | 'off') ?? 'on',
        mcp_sync_claude: (out['mcp_sync_claude'] as 'on' | 'off') ?? 'on',
        mcp_sync_cursor: (out['mcp_sync_cursor'] as 'on' | 'off') ?? 'on',
        mcp_sync_codex: (out['mcp_sync_codex'] as 'on' | 'off') ?? 'on',
        mcp_sync_agents: (out['mcp_sync_agents'] as 'on' | 'off') ?? 'on',
        managed_credentials: (out['managed_credentials'] as 'on' | 'off') ?? 'off',
        ops_auto_provision_workspaces:
            (out['ops_auto_provision_workspaces'] as 'on' | 'off') ?? 'off',
        terminal_copy_paste:
            (out['terminal_copy_paste'] as 'contextmenu' | 'linux' | 'winmac') ?? 'contextmenu',
        ai_system: out['ai_system'] ?? '',
        collapsed_workspaces: out['collapsed_workspaces'] ?? '[]',
        // Every provider's command + flags, defaulted from TUI_REGISTRY
        // (genie#261) with the stored value winning where one exists.
        ...Object.fromEntries(
            Object.entries(tuiSettingDefaults()).map(([k, fallback]) => [
                k,
                out[k] ?? fallback,
            ]),
        ),
        // '' is a real answer meaning "no workstation opinion yet", which
        // `resolveGappProvider` resolves to the user's setup-wizard default. It is
        // deliberately NOT defaulted to 'claude' here: that would make the
        // inheritance invisible and freeze the answer at whatever this file said.
        gapp_ai_provider: out['gapp_ai_provider'] ?? '',
        plugins_developer_mode:
            (out['plugins_developer_mode'] as 'on' | 'off') ?? 'off',
        // Local-workstation identity (design brief §2a). No default — absent means
        // "not yet enrolled" (readWorkstationIdentity keys off that). Threaded like
        // github_token_enc: id in the clear, key encrypted at rest.
        workstation_id: out['workstation_id'],
        workstation_key_enc: out['workstation_key_enc'],
    };
}

export function setSettings(patch: Partial<Settings>): Settings {
    const d = getDb();
    const stmt = d.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    const tx = d.transaction((entries: Array<[string, string]>) => {
        for (const [k, v] of entries) stmt.run(k, v);
    });
    const entries: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined && v !== null) entries.push([k, String(v)]);
    }
    tx(entries);
    return getAllSettings();
}

// Workspace helpers -----------------------------------------------------

export type WorkspaceAgentRole = 'workspace' | 'specialized' | 'gapp';
export type WorkspaceAgentReachability = 'workspace' | 'workstation' | 'hidden';
export type WorkspaceAgentTransport =
    | 'claude-channel'
    | 'codex-app-server'
    | 'kiwi-native'
    | 'genie-mcp';

/** A first-class AMS configuration. Its terminal binding is intentionally nullable. */
/**
 * ONE TUI an agent may run under (v55).
 *
 * An agent is not its TUI: `claude` and `codex` are drivers it can switch
 * between, and the one that is not fronted keeps its pty and its conversation as
 * a sidecar to flip back to. `fronted` is the visible one; at most one per agent,
 * enforced by a partial unique index rather than by convention.
 */
export interface AgentRuntimeRow {
    id: string;
    agent_id: string;
    tui: string;
    terminal_spec_id: string | null;
    chat_session_id: string | null;
    transport: string | null;
    native_transport: string | null;
    transport_verified_at: number | null;
    transport_error: string | null;
    ready_at: number | null;
    fronted: number;
    created_at: number;
    updated_at: number;
}

/** Every TUI this agent may run under, fronted first. */
export function listAgentRuntimes(agentId: string): AgentRuntimeRow[] {
    return getDb()
        .prepare<[string], AgentRuntimeRow>(
            `SELECT * FROM agent_runtimes WHERE agent_id = ?
              ORDER BY fronted DESC, created_at ASC`,
        )
        .all(agentId);
}

/** The TUI currently on screen for this agent, if any is running. */
export function frontedAgentRuntime(agentId: string): AgentRuntimeRow | undefined {
    return listAgentRuntimes(agentId).find((r) => r.fronted === 1);
}

export function createAgentRuntime(input: {
    agentId: string;
    tui: string;
    terminalSpecId?: string | null;
    chatSessionId?: string | null;
    fronted?: boolean;
}): AgentRuntimeRow {
    const now = Date.now();
    const id = `runtime:${crypto.randomUUID()}`;
    getDb()
        .prepare(
            `INSERT INTO agent_runtimes
               (id, agent_id, tui, terminal_spec_id, chat_session_id, fronted, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            id,
            input.agentId,
            input.tui,
            input.terminalSpecId ?? null,
            input.chatSessionId ?? null,
            input.fronted ? 1 : 0,
            now,
            now,
        );
    return getDb()
        .prepare<[string], AgentRuntimeRow>('SELECT * FROM agent_runtimes WHERE id = ?')
        .get(id)!;
}

/**
 * Make one runtime the visible TUI, in ONE step.
 *
 * The flip is a SWAP, and doing it as two writes is wrong twice: fronting the
 * new one first trips the one-fronted index, and un-fronting the old one first
 * leaves a window where the agent has no visible TUI at all — which every
 * surface above reads as "stopped".
 *
 * Refuses a runtime belonging to a different agent rather than obeying: that
 * would let one agent take another's visible TUI, and the index would be
 * satisfied by the wrong pair. Returns whether the flip happened.
 */
export function frontAgentRuntime(agentId: string, runtimeId: string): boolean {
    const d = getDb();
    const target = d
        .prepare<[string], AgentRuntimeRow>('SELECT * FROM agent_runtimes WHERE id = ?')
        .get(runtimeId);
    if (!target || target.agent_id !== agentId) return false;
    const now = Date.now();
    d.transaction(() => {
        d.prepare(
            'UPDATE agent_runtimes SET fronted = 0, updated_at = ? WHERE agent_id = ? AND id != ?',
        ).run(now, agentId, runtimeId);
        d.prepare('UPDATE agent_runtimes SET fronted = 1, updated_at = ? WHERE id = ?').run(
            now,
            runtimeId,
        );
    })();
    return true;
}

/** Point a runtime at the terminal now backing it (or at nothing). */
export function bindAgentRuntimeTerminal(
    runtimeId: string,
    terminalSpecId: string | null,
): void {
    getDb()
        .prepare('UPDATE agent_runtimes SET terminal_spec_id = ?, updated_at = ? WHERE id = ?')
        .run(terminalSpecId, Date.now(), runtimeId);
}

export interface WorkspaceAgentRow {
    id: string;
    workspace_id: string;
    tui: string | null;
    name: string;
    purpose: string;
    avatar: string | null;
    boot_cwd: string | null;
    persona_path: string | null;
    role: WorkspaceAgentRole;
    parent_agent_id: string | null;
    terminal_spec_id: string | null;
    reachability: WorkspaceAgentReachability;
    wake_on_dm: number;
    ready_at: number | null;
    transport: WorkspaceAgentTransport | null;
    transport_verified_at: number | null;
    transport_error: string | null;
    created_at: number;
    updated_at: number;
    /** Set when this workspace holds more than one agent under this name and a
     *  human has not yet said which survives (v55). The name index is partial on
     *  this, so marked rows coexist until the collision is answered. */
    collision_group: string | null;
}

export interface WorkspaceRow {
    id: string;
    backend: 'tynn' | 'aionima';
    project_id: string;
    project_name: string;
    /** Legacy mirrors — kept populated for backwards-compat with v1 schema readers. */
    tynn_project_id: string;
    tynn_project_name: string;
    shape: 'agi' | 'simple';
    /** A user-set workspace icon (emoji today; a path or URL later). NULL means
     *  fall back to the workspace's initials — see renderer/lib/workspace-avatar. */
    icon?: string | null;
    path: string;
    editor: string | null;
    editor_cmd: string | null;
    start_cmd: string | null;
    env_file: string | null;
    last_opened_at: string | null;
    created_by_genie: number;
    /** 1 when this headless host provisioned the workspace from a Tynn
     *  `WorkspaceAssigned` push. The convergent reconcile ONLY ever deprovisions
     *  rows with this set — ops-provisioned / user-local rows (same backend +
     *  created_by_genie) stay 0 and are never torn down. Default 0. */
    assignment_managed: number;
    /**
     * The ONE reserved agent name this workspace is permitted to use, or NULL.
     *
     * `general`, `genie` and `tynn` are refused as agent names everywhere
     * (`agents/reserved-names.ts`); a SACRED workspace is granted exactly one of
     * them back — the Tynn workspace gets `tynn`. A grant, not a boolean, so it
     * cannot become a skeleton key over the whole list. Sacred is otherwise
     * PURELY COSMETIC in Genie: same tools, same permissions, same guides.
     */
    sacred_name: string | null;
    /** User-defined sidebar order (lower = higher). New rows append to the bottom. */
    sort_order: number;
    /** Agent-integration MCP enabled for this workspace's terminals. 0=off (default). */
    mcp_enabled: number;
    /** Require user approval before an agent (manageProcess MCP tool) creates or
     *  starts a background process. 1=require approval (default), 0=auto-run. */
    process_approval: number;
    /** Require user approval before an agent (manageTerminals / runAgent MCP
     *  tools) spawns a terminal, writes to one, or launches/drives a coding
     *  agent. 1=require approval (default), 0=auto-run. Higher-power sibling of
     *  process_approval. */
    terminal_approval: number;
    /** Require user approval before an agent (manageProcess MCP tool) arms a
     *  SCHEDULED task — a process spec with `meta.schedule`. 1=require approval
     *  (default), 0=arm immediately. Sibling of process_approval, separate
     *  because a schedule runs unattended and recurs. */
    schedule_approval: number;
    /** AgentInbox OUTER tier — who may reach INTO this workspace (its channels and
     *  its agents) from another workspace. 'all' (default) preserves the
     *  pre-feature behaviour where channels were ungoverned. Resolve via
     *  {@link getWorkspaceAgentAccess}, never read raw. */
    agent_access: WorkspaceAgentAccess;
    /** WORKSTATION OPERATOR (Tynn #248): 1 = this workspace's agent may act on
     *  every workspace on this machine. 0/absent = no. Resolve via
     *  {@link isWorkstationOperator}, never read raw. */
    workstation_operator?: number | null;
    /** GENIE APPS (Tynn #250): 'app' = this workspace hosts an installed GApp.
     *  NULL = an ordinary workspace. Resolve via {@link getWorkspaceAppKind}. */
    app_kind?: string | null;
    /** GAPP DEVELOPMENT WORKSPACE (genie#245): 1 = the linked Tynn project is
     *  marked `is_gapp`, so a GApp is DEVELOPED here. Mirrored from Tynn by
     *  `syncGappDevWorkspaces`, never set by hand. Independent of `app_kind`,
     *  which records what Genie INSTALLED here. Resolve via {@link isGappDevValue}. */
    gapp_dev?: number | null;
    /** Workspace ids admitted when `agent_access: 'specific'`, JSON-encoded.
     *  NULL/absent = none admitted. Resolve via {@link getWorkspaceAgentAccess}. */
    agent_access_workspaces?: string | null;
    /** LEGACY per-workspace IssueWatch remediation policy (single value for all
     *  kinds). Superseded by `issuewatch_policy_buckets`; still read as the
     *  per-bucket fallback for backward compat. NULL/absent reads as 'surface'. */
    issuewatch_policy?: 'surface' | 'fix' | 'fix-and-ship' | null;
    /** Per-workspace IssueWatch remediation policy PER BUCKET, JSON-encoded
     *  ({security,issue,pr} → policy). NULL/absent falls back to the legacy
     *  `issuewatch_policy` value for every bucket — resolve it via
     *  {@link getWorkspaceIssuewatchPolicyBuckets}, never parse here. */
    issuewatch_policy_buckets?: string | null;
    /** Per-workspace IssueWatch granularity, JSON-encoded (what to watch + ping
     *  about). NULL/absent reads as the all-on + upstream-issues+prs defaults —
     *  resolve it via {@link getWorkspaceIssuewatchGranularity}, never parse here. */
    issuewatch_granularity?: string | null;
    /** Per-workspace DEV SITES (the container Dev Server, #234 P2), JSON-encoded
     *  ({ [siteId]: { name, genName, repo, runMode, command?, port?, … } }).
     *  The ONLY source of a `.gen` site: what GENIE serves, from a container in
     *  the workspace sandbox.
     *  NULL/absent reads as {} — resolve via {@link getWorkspaceDevSites}. */
    dev_sites?: string | null;
    /** Per-workspace DEV SERVICES (the container Dev Server, #234 P3),
     *  JSON-encoded ({ [serviceId]: { engine, version, dedicated, password, … } }).
     *  What this workspace's dev sites CONNECT TO: its slice — database, role
     *  and credentials — of a SHARED engine container.
     *  NULL/absent reads as {} — resolve via
     *  {@link getWorkspaceDevServices}. */
    dev_services?: string | null;
}

/**
 * The PROTECTED System Workspace — the workstation operator's own row.
 *
 * It is a real row like any other, which is the whole point: AgentInbox identity
 * is `workspaceId:purpose`, so an operator with no workspace had no identity, and
 * every surface that needed one substituted a sentinel instead. It is reachable
 * by id ({@link getWorkspace}) so those guards now find a row, and deliberately
 * absent from {@link listWorkspaces} so nothing enumerating "the workspaces"
 * offers it, polls it, serves it, pushes it, or starts a container in it.
 *
 * Rooted at `~/.gosa` — outside `userData`, so Reset Workstation cannot reach its
 * files. The ROW lives in `genie.db`, which a reset does delete, so a reset
 * machine re-seeds an empty operator over its preserved memory. That is the
 * intended split: the workstation is new, the operator's notes are not.
 */
export { SYSTEM_WORKSPACE_ROW_ID };

/**
 * Create (or re-point) the System Workspace row.
 *
 * `workstation_operator` is set here rather than by a human: this row IS the
 * workstation's operator, and the designation is what lets its agent act on
 * every workspace on the machine through the ORDINARY authorization path
 * (`decideTargetWorkspace`) instead of a bespoke "the caller has no workspace but
 * is the OSA" escape hatch.
 */
export function ensureSystemWorkspaceRow(
    d: Database.Database,
    workspacePath: string,
): WorkspaceRow {
    d.prepare(
        `INSERT INTO workspaces
           (id, backend, project_id, project_name, tynn_project_id, tynn_project_name,
            shape, path, editor, editor_cmd, start_cmd, env_file, last_opened_at,
            created_by_genie, sort_order, mcp_enabled, assignment_managed, sacred_name,
            workstation_operator)
         VALUES (@id, 'aionima', '', 'System', '', 'System', 'agi', @path,
                 NULL, NULL, NULL, NULL, NULL, 1, -1, 1, 0, NULL, 1)
         ON CONFLICT(id) DO UPDATE SET
            path = excluded.path,
            project_name = excluded.project_name,
            mcp_enabled = 1,
            workstation_operator = 1,
            assignment_managed = 0`,
    ).run({ id: SYSTEM_WORKSPACE_ROW_ID, path: workspacePath });
    return d
        .prepare<[string], WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?')
        .get(SYSTEM_WORKSPACE_ROW_ID)!;
}

/** Create (or re-point) the System Workspace row on the live database. */
export function ensureSystemWorkspace(workspacePath: string): WorkspaceRow {
    return ensureSystemWorkspaceRow(getDb(), workspacePath);
}

/**
 * The workspaces anything may enumerate — pickers, sidebars, the workstation
 * inventory, IssueWatch counts, the Dev Server reconcile, the mobile payload.
 *
 * The System Workspace is excluded HERE, once, rather than filtered at each of
 * those. That is what "protected" means structurally: a surface has to ask for it
 * by id to see it, and none of them do.
 */
export function listWorkspacesIn(d: Database.Database): WorkspaceRow[] {
    return d
        .prepare<[string], WorkspaceRow>(
            `SELECT * FROM workspaces
             WHERE id != ?
             ORDER BY sort_order ASC, (last_opened_at IS NULL) ASC, last_opened_at DESC, project_name ASC`,
        )
        .all(SYSTEM_WORKSPACE_ROW_ID);
}

export function listWorkspaces(): WorkspaceRow[] {
    return listWorkspacesIn(getDb());
}

export function listWorkspaceAgents(workspaceId: string): WorkspaceAgentRow[] {
    return getDb()
        .prepare<[string], WorkspaceAgentRow>(
            `SELECT *, COALESCE(native_transport, transport) AS transport FROM workspace_agents
             WHERE workspace_id = ?
             ORDER BY CASE role WHEN 'workspace' THEN 0 WHEN 'specialized' THEN 1 ELSE 2 END,
                      name ASC`,
        )
        .all(workspaceId);
}

/**
 * The agent a workspace knows by NAME.
 *
 * The lookup that matters since v55: a name means ONE agent, whatever TUI is
 * driving it. `getWorkspaceAgent` still takes a tui for the callers that
 * have one in hand, but a uniqueness check must use this -- checking
 * (tui, name) let a second agent be registered under a name the workspace
 * already had, and the insert then died on the index instead of refusing
 * cleanly.
 */
export function getWorkspaceAgentByName(
    workspaceId: string,
    name: string,
): WorkspaceAgentRow | undefined {
    return getDb()
        .prepare<[string, string], WorkspaceAgentRow>(
            `SELECT *, COALESCE(native_transport, transport) AS transport FROM workspace_agents
             WHERE workspace_id = ? AND name = ?`,
        )
        .get(workspaceId, name);
}

export function getWorkspaceAgent(
    workspaceId: string,
    tui: string,
    name: string,
): WorkspaceAgentRow | undefined {
    return getDb()
        .prepare<[string, string, string], WorkspaceAgentRow>(
            `SELECT *, COALESCE(native_transport, transport) AS transport FROM workspace_agents
             WHERE workspace_id = ? AND tui = ? AND name = ?`,
        )
        .get(workspaceId, tui, name);
}

export function createWorkspaceAgent(
    row: Omit<WorkspaceAgentRow, 'created_at' | 'updated_at' | 'ready_at' | 'terminal_spec_id' | 'transport' | 'transport_verified_at' | 'transport_error' | 'collision_group'> & {
        ready_at?: number | null;
        terminal_spec_id?: string | null;
    },
): WorkspaceAgentRow {
    const now = Date.now();
    getDb()
        .prepare(
            `INSERT INTO workspace_agents
                (id, workspace_id, tui, name, purpose, avatar, boot_cwd,
                 persona_path, role, parent_agent_id, terminal_spec_id,
                 reachability, wake_on_dm, ready_at, created_at, updated_at)
             VALUES (@id, @workspace_id, @tui, @name, @purpose, @avatar, @boot_cwd,
                     @persona_path, @role, @parent_agent_id, @terminal_spec_id,
                     @reachability, @wake_on_dm, @ready_at, @created_at, @updated_at)`,
        )
        .run({
            ...row,
            terminal_spec_id: row.terminal_spec_id ?? null,
            ready_at: row.ready_at ?? null,
            created_at: now,
            updated_at: now,
        });
    return getDb()
        .prepare<[string], WorkspaceAgentRow>('SELECT *, COALESCE(native_transport, transport) AS transport FROM workspace_agents WHERE id = ?')
        .get(row.id)!;
}

export function bindWorkspaceAgentTerminal(agentId: string, terminalSpecId: string | null): void {
    bindWorkspaceAgentTerminalInDb(getDb(), agentId, terminalSpecId);
}

export function bindWorkspaceAgentTerminalInDb(
    database: Database.Database,
    agentId: string,
    terminalSpecId: string | null,
): void {
    const now = Date.now();
    // The FRONTED RUNTIME is the source of truth for "which TUI is this agent
    // in"; `workspace_agents.terminal_spec_id` is only its cached mirror (v55 --
    // see `main/__tests__/agent-runtimes.test.ts`). Writing the mirror alone left
    // the authority null, so `frontedAgentRuntime` reported a running agent as
    // stopped and clicking its icon spawned a SECOND agent (#310).
    //
    // Only the fronted runtime moves: a sidecar keeping its conversation warm is
    // not backed by this terminal and must not be repointed at it.
    const moved = database
        .prepare(
            `UPDATE agent_runtimes
             SET terminal_spec_id = ?, ready_at = NULL,
                 transport_verified_at = NULL, transport_error = NULL,
                 updated_at = ?
             WHERE agent_id = ? AND fronted = 1`,
        )
        .run(terminalSpecId, now, agentId).changes;

    // An agent REGISTERED but never started has no runtime at all — the
    // documented dormant state. An UPDATE against no row touches nothing, so the
    // first bind left the authority empty while the mirror below was written,
    // and `frontedAgentRuntime` then reported the running agent as stopped. That
    // is the regression the UPDATE-only form of this fix introduced: before it,
    // only the mirror was written and only the mirror was read, so a missing
    // runtime cost nothing.
    //
    // Create it here instead. Only when binding a terminal — unbinding a dormant
    // agent must stay a no-op rather than inventing a runtime for something that
    // never ran.
    if (moved === 0 && terminalSpecId) {
        const tui = database
            .prepare<[string], { tui: string | null }>(
                'SELECT tui FROM workspace_agents WHERE id = ?',
            )
            .get(agentId)?.tui;
        if (tui) {
            database
                .prepare(
                    `INSERT INTO agent_runtimes
                       (id, agent_id, tui, terminal_spec_id, fronted, created_at, updated_at)
                     VALUES (?, ?, ?, ?, 1, ?, ?)`,
                )
                .run(`runtime:${crypto.randomUUID()}`, agentId, tui, terminalSpecId, now, now);
        }
    }
    database
        .prepare(
            `UPDATE workspace_agents
             SET terminal_spec_id = ?, ready_at = NULL,
                 transport_verified_at = NULL, transport_error = NULL,
                 updated_at = ?
             WHERE id = ?`,
        )
        .run(terminalSpecId, now, agentId);
}

export function markWorkspaceAgentReadyByTerminal(
    database: Database.Database,
    terminalSpecId: string,
    readyAt = Date.now(),
): WorkspaceAgentRow | undefined {
    database
        .prepare(
            `UPDATE workspace_agents SET ready_at = ?, updated_at = ?
             WHERE terminal_spec_id = ? AND transport_verified_at IS NOT NULL`,
        )
        .run(readyAt, readyAt, terminalSpecId);
    return database
        .prepare<[string], WorkspaceAgentRow>(
            'SELECT *, COALESCE(native_transport, transport) AS transport FROM workspace_agents WHERE terminal_spec_id = ?',
        )
        .get(terminalSpecId);
}

export function markWorkspaceAgentTransportState(
    database: Database.Database,
    agentId: string,
    transport: WorkspaceAgentTransport,
    result: { ok: true; at?: number } | { ok: false; error: string },
): WorkspaceAgentRow | undefined {
    const now = result.ok ? (result.at ?? Date.now()) : Date.now();
    database.prepare(
        `UPDATE workspace_agents
         SET transport = CASE WHEN ? IN ('claude-channel','codex-app-server') THEN ? ELSE NULL END,
             native_transport = ?, transport_verified_at = ?, transport_error = ?,
             ready_at = NULL, updated_at = ?
         WHERE id = ?`,
    ).run(
        transport,
        transport,
        transport,
        result.ok ? now : null,
        result.ok ? null : result.error.trim(),
        now,
        agentId,
    );
    return database.prepare<[string], WorkspaceAgentRow>(
        'SELECT *, COALESCE(native_transport, transport) AS transport FROM workspace_agents WHERE id = ?',
    ).get(agentId);
}

export function deleteWorkspaceAgent(agentId: string): void {
    // No role filter. The old `AND role <> 'workspace'` made this a DELETE that
    // reported success while removing nothing — a failure that reports success,
    // which is worse than one that stops, because nothing prompts anyone to
    // look. Whether the WORKSPACE agent may be removed is decided in
    // `resolveAgentDeletion` (it may — genie#324), where a refusal can actually
    // be returned to the caller.
    getDb().prepare(`DELETE FROM workspace_agents WHERE id = ?`).run(agentId);
}

export type WorkspaceTodoKind = 'user' | 'agent';
export type WorkspaceTodoStatus = 'open' | 'thrown_back' | 'refused' | 'done';

export interface WorkspaceTodoRow {
    id: string;
    workspace_id: string;
    agent_id: string | null;
    kind: WorkspaceTodoKind;
    text: string;
    status: WorkspaceTodoStatus;
    created_at: number;
    updated_at: number;
}

export function listWorkspaceTodos(
    database: Database.Database,
    workspaceId: string,
    kind?: WorkspaceTodoKind,
): WorkspaceTodoRow[] {
    return kind
        ? database.prepare<[string, WorkspaceTodoKind], WorkspaceTodoRow>(
              `SELECT * FROM workspace_todos
               WHERE workspace_id = ? AND kind = ? AND status = 'open'
               ORDER BY created_at ASC`,
          ).all(workspaceId, kind)
        : database.prepare<[string], WorkspaceTodoRow>(
              `SELECT * FROM workspace_todos
               WHERE workspace_id = ? AND status = 'open'
               ORDER BY kind ASC, created_at ASC`,
          ).all(workspaceId);
}

export function createWorkspaceTodo(
    database: Database.Database,
    input: { workspaceId: string; kind: WorkspaceTodoKind; text: string; agentId?: string | null },
): { ok: true; todo: WorkspaceTodoRow; reminder: string } | { ok: false; error: string; cap?: number } {
    const text = input.text.trim();
    if (!text) return { ok: false, error: 'Todo text cannot be empty.' };
    const cap = input.kind === 'user' ? 5 : 10;
    return database.transaction(() => {
        const count = database.prepare<[string, WorkspaceTodoKind], { n: number }>(
            `SELECT COUNT(*) AS n FROM workspace_todos
             WHERE workspace_id = ? AND kind = ? AND status = 'open'`,
        ).get(input.workspaceId, input.kind)?.n ?? 0;
        if (count >= cap) {
            return { ok: false as const, cap, error: `${input.kind === 'user' ? 'UserToDo' : 'AgentTodo'} is capped at ${cap} open items.` };
        }
        const now = Date.now();
        const id = randomUUID();
        database.prepare(
            `INSERT INTO workspace_todos
                (id, workspace_id, agent_id, kind, text, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
        ).run(id, input.workspaceId, input.agentId ?? null, input.kind, text, now, now);
        const todo = database.prepare<[string], WorkspaceTodoRow>(
            'SELECT * FROM workspace_todos WHERE id = ?',
        ).get(id)!;
        return {
            ok: true as const,
            todo,
            reminder: 'Use Tynn instead if this is roadmap or project-management work.',
        };
    })();
}

export function resolveUserTodo(
    database: Database.Database,
    todoId: string,
    action: Exclude<WorkspaceTodoStatus, 'open'>,
    comment: string,
): { ok: true; todo: WorkspaceTodoRow } | { ok: false; error: string } {
    const note = comment.trim();
    if (!note) return { ok: false, error: 'A comment is required for every UserToDo outcome.' };
    return database.transaction(() => {
        const todo = database.prepare<[string], WorkspaceTodoRow>(
            `SELECT * FROM workspace_todos WHERE id = ? AND kind = 'user' AND status = 'open'`,
        ).get(todoId);
        if (!todo) return { ok: false as const, error: 'No open UserToDo with that id.' };
        const now = Date.now();
        database.prepare(
            `UPDATE workspace_todos SET status = ?, updated_at = ? WHERE id = ?`,
        ).run(action, now, todoId);
        database.prepare(
            `INSERT INTO workspace_todo_events (id, todo_id, action, comment, created_at)
             VALUES (?, ?, ?, ?, ?)`,
        ).run(randomUUID(), todoId, action, note, now);
        return {
            ok: true as const,
            todo: database.prepare<[string], WorkspaceTodoRow>(
                'SELECT * FROM workspace_todos WHERE id = ?',
            ).get(todoId)!,
        };
    })();
}

/**
 * Workspaces this host provisioned from a Tynn assignment (`assignment_managed`
 * = 1). The convergent reconcile diffs THIS list against Tynn's current assigned
 * set to find safe-to-deprovision workspaces — it never sees ops-provisioned or
 * user-local rows, so it can't tear them down.
 */
export function listAssignmentWorkspaces(): WorkspaceRow[] {
    return getDb()
        .prepare<[], WorkspaceRow>(
            'SELECT * FROM workspaces WHERE assignment_managed = 1',
        )
        .all();
}

/** Next sidebar order for a new workspace — appends to the bottom. */
function nextWorkspaceOrder(): number {
    const row = getDb()
        .prepare<[], { mx: number | null }>(
            'SELECT MAX(sort_order) AS mx FROM workspaces',
        )
        .get();
    return (row?.mx ?? -1) + 1;
}

/**
 * Persist a user-defined sidebar order. `ids` is the full ordered list of
 * workspace ids (flyout order); each gets its index as sort_order. Unknown
 * ids are ignored. Runs in one transaction so the rail never sees a partial
 * reorder.
 */
export function reorderWorkspaces(ids: string[]): void {
    const stmt = getDb().prepare('UPDATE workspaces SET sort_order = ? WHERE id = ?');
    const tx = getDb().transaction((order: string[]) => {
        order.forEach((id, i) => stmt.run(i, id));
    });
    tx(ids);
}

export function getWorkspace(id: string): WorkspaceRow | undefined {
    return getDb()
        .prepare<[string], WorkspaceRow | undefined>(
            'SELECT * FROM workspaces WHERE id = ?',
        )
        .get(id);
}

/**
 * Look a workspace up by its on-disk path. Used to recover a workspace's
 * durable Tynn-project association (the `tynn_project_id` recorded at creation)
 * from a path-only caller — e.g. the Tynn provisioner, which is handed a
 * workspace path, not an id.
 */
export function getWorkspaceByPath(wsPath: string): WorkspaceRow | undefined {
    return getDb()
        .prepare<[string], WorkspaceRow | undefined>(
            'SELECT * FROM workspaces WHERE path = ?',
        )
        .get(wsPath);
}

export function addWorkspace(
    row: Omit<
        WorkspaceRow,
        | 'sort_order'
        | 'mcp_enabled'
        | 'process_approval'
        | 'terminal_approval'
        | 'schedule_approval'
        | 'assignment_managed'
        | 'agent_access'
        | 'sacred_name'
    > & {
        sort_order?: number;
        mcp_enabled?: number;
        process_approval?: number;
        terminal_approval?: number;
        schedule_approval?: number;
        assignment_managed?: number;
        agent_access?: WorkspaceAgentAccess;
        sacred_name?: string | null;
    },
): WorkspaceRow {
    // Mirror project_id / project_name into the legacy tynn_* columns
    // because they're declared NOT NULL on v1 — even Aionima rows have to
    // populate them.
    const full = {
        ...row,
        backend: row.backend ?? 'tynn',
        tynn_project_id: row.tynn_project_id || row.project_id,
        tynn_project_name: row.tynn_project_name || row.project_name,
        // New workspaces append to the bottom of the user-defined order.
        sort_order: row.sort_order ?? nextWorkspaceOrder(),
        // Agent-integration MCP is ON by default for every workspace so the
        // Genie MCP (imDone, ForceTheQuestion, …) is available to agents
        // everywhere out of the box. The per-workspace toggle can opt out.
        mcp_enabled: row.mcp_enabled ?? 1,
        // Only the workspace-assignment provisioner sets this to 1 (see
        // provisionAssignedWorkspace); everything else stays 0 so the convergent
        // reconcile never tears it down.
        assignment_managed: row.assignment_managed ?? 0,
        // No workspace is sacred until something GRANTS it a reserved name --
        // Tynn is the source of truth for which project that is. NULL means the
        // reserved-name block list applies in full, which is the right default
        // for every workspace anyone creates.
        sacred_name: row.sacred_name ?? null,
    };
    const database = getDb();
    const insert = database.transaction(() => {
        database.prepare(
            `INSERT INTO workspaces
             (id, backend, project_id, project_name, tynn_project_id, tynn_project_name, shape, path, editor, editor_cmd, start_cmd, env_file, last_opened_at, created_by_genie, sort_order, mcp_enabled, assignment_managed, sacred_name)
             VALUES (@id, @backend, @project_id, @project_name, @tynn_project_id, @tynn_project_name, @shape, @path, @editor, @editor_cmd, @start_cmd, @env_file, @last_opened_at, @created_by_genie, @sort_order, @mcp_enabled, @assignment_managed, @sacred_name)`,
        )
        .run(full);
        // No placeholder agent. A new workspace has NO default until someone
        // designates one of its real agents -- v50 seeded a driverless
        // 'workspace' row here, which became a phantom square that clicked
        // into nothing once the grid started drawing registered agents.
    });
    insert();
    return getWorkspace(row.id)!;
}

export function updateWorkspace(
    id: string,
    patch: Partial<WorkspaceRow>,
): WorkspaceRow | undefined {
    const existing = getWorkspace(id);
    if (!existing) return undefined;
    const next = {
        ...existing,
        ...patch,
        tynn_project_id:
            patch.tynn_project_id ?? patch.project_id ?? existing.tynn_project_id,
        tynn_project_name:
            patch.tynn_project_name ?? patch.project_name ?? existing.tynn_project_name,
    };
    getDb()
        .prepare(
            `UPDATE workspaces SET
                backend           = @backend,
                project_id        = @project_id,
                project_name      = @project_name,
                tynn_project_id   = @tynn_project_id,
                tynn_project_name = @tynn_project_name,
                shape             = @shape,
                path              = @path,
                editor            = @editor,
                editor_cmd        = @editor_cmd,
                start_cmd         = @start_cmd,
                env_file          = @env_file,
                last_opened_at    = @last_opened_at,
                created_by_genie  = @created_by_genie,
                sacred_name       = @sacred_name
             WHERE id = @id`,
        )
        .run(next);
    return getWorkspace(id);
}

/**
 * Unregister a workspace — and REFUSE the System Workspace.
 *
 * The refusal lives at the delete itself because three callers reach it: the
 * `workspaces:remove` IPC, `manageWorkspaces remove` (any workstation-operator
 * agent), and the assignment deprovisioner. A guard in one of them is a guard in
 * one of them. `workspace_agents` and `workspace_todos` cascade on this delete,
 * so an agent unmounting the machine's own operator would take its agents with
 * it.
 */
export function removeWorkspaceIn(d: Database.Database, id: string): void {
    if (id === SYSTEM_WORKSPACE_ROW_ID) {
        throw new Error(
            'The System Workspace is the workstation operator’s own workspace and cannot be unregistered.',
        );
    }
    d.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
}

export function removeWorkspace(id: string): void {
    removeWorkspaceIn(getDb(), id);
}

export function touchWorkspace(id: string): void {
    getDb()
        .prepare('UPDATE workspaces SET last_opened_at = ? WHERE id = ?')
        .run(new Date().toISOString(), id);
}

/** Toggle the agent-integration MCP for a workspace's terminals. */
export function setWorkspaceMcp(id: string, enabled: boolean): void {
    getDb()
        .prepare('UPDATE workspaces SET mcp_enabled = ? WHERE id = ?')
        .run(enabled ? 1 : 0, id);
}

/** Whether the agent-integration MCP is enabled for a workspace (default off). */
export function workspaceMcpEnabled(id: string): boolean {
    const row = getDb()
        .prepare<[string], { mcp_enabled: number } | undefined>(
            'SELECT mcp_enabled FROM workspaces WHERE id = ?',
        )
        .get(id);
    return !!row && row.mcp_enabled === 1;
}

/** Toggle the "require approval before an agent starts a process" gate. */
export function setWorkspaceProcessApproval(id: string, require: boolean): void {
    getDb()
        .prepare('UPDATE workspaces SET process_approval = ? WHERE id = ?')
        .run(require ? 1 : 0, id);
}

/**
 * Whether an agent-created/started background process needs user approval in
 * this workspace. Defaults to TRUE (require approval) — for an unknown id too,
 * so the safe gate is the fallback, never a silent auto-run.
 */
export function workspaceProcessApproval(id: string): boolean {
    const row = getDb()
        .prepare<[string], { process_approval: number } | undefined>(
            'SELECT process_approval FROM workspaces WHERE id = ?',
        )
        .get(id);
    return !row || row.process_approval !== 0;
}

/**
 * Toggle the "require approval before an agent spawns a terminal / launches an
 * agent" gate (the manageTerminals + runAgent MCP tools).
 */
export function setWorkspaceTerminalApproval(id: string, require: boolean): void {
    getDb()
        .prepare('UPDATE workspaces SET terminal_approval = ? WHERE id = ?')
        .run(require ? 1 : 0, id);
}

/**
 * Whether an agent spawning a terminal / writing to one / launching or driving
 * a coding agent needs user approval in this workspace. Defaults to TRUE
 * (require approval) — for an unknown id too, so the safe gate is the fallback,
 * never a silent auto-run of arbitrary code.
 */
export function workspaceTerminalApproval(id: string): boolean {
    const row = getDb()
        .prepare<[string], { terminal_approval: number } | undefined>(
            'SELECT terminal_approval FROM workspaces WHERE id = ?',
        )
        .get(id);
    return !row || row.terminal_approval !== 0;
}

/**
 * Toggle the "require approval before an agent arms a scheduled task" gate
 * (a manageProcess create carrying a `schedule`).
 */
export function setWorkspaceScheduleApproval(id: string, require: boolean): void {
    getDb()
        .prepare('UPDATE workspaces SET schedule_approval = ? WHERE id = ?')
        .run(require ? 1 : 0, id);
}

/**
 * Whether an agent-armed SCHEDULED task needs user approval in this workspace.
 * Defaults to TRUE (require approval) — for an unknown id too, so the safe gate
 * is the fallback, never a silently-armed recurring job.
 */
export function workspaceScheduleApproval(id: string): boolean {
    const row = getDb()
        .prepare<[string], { schedule_approval: number } | undefined>(
            'SELECT schedule_approval FROM workspaces WHERE id = ?',
        )
        .get(id);
    return !row || row.schedule_approval !== 0;
}

const AGENT_ACCESS_VALUES: readonly WorkspaceAgentAccess[] = ['none', 'self', 'specific', 'all'];

/**
 * Set the workspace's AgentInbox front door (OUTER tier). `workspaces` is only
 * meaningful for `specific` and is stored NULL otherwise, so a later widen →
 * narrow round-trip can't resurrect a stale allow-list.
 */
export function setWorkspaceAgentAccess(
    id: string,
    access: WorkspaceAgentAccess,
    workspaces: string[] = [],
): void {
    const safe: WorkspaceAgentAccess = AGENT_ACCESS_VALUES.includes(access) ? access : 'all';
    const list =
        safe === 'specific' ? JSON.stringify([...new Set(workspaces.map(String))]) : null;
    getDb()
        .prepare('UPDATE workspaces SET agent_access = ?, agent_access_workspaces = ? WHERE id = ?')
        .run(safe, list, id);
}

/**
 * Resolve a workspace's AgentInbox front door. Defaults to `all` — including for
 * an unknown id — because channels were UNGOVERNED before this feature existed;
 * failing closed here would sever working cross-workspace channels rather than
 * protect anything. Tightening is an explicit user action.
 */
export function getWorkspaceAgentAccess(id: string): {
    access: WorkspaceAgentAccess;
    workspaces: string[];
} {
    const row = getDb()
        .prepare<
            [string],
            { agent_access: string | null; agent_access_workspaces: string | null } | undefined
        >('SELECT agent_access, agent_access_workspaces FROM workspaces WHERE id = ?')
        .get(id);
    const raw = (row?.agent_access ?? 'all') as WorkspaceAgentAccess;
    const access = AGENT_ACCESS_VALUES.includes(raw) ? raw : 'all';
    let workspaces: string[] = [];
    if (access === 'specific' && row?.agent_access_workspaces) {
        try {
            const parsed: unknown = JSON.parse(row.agent_access_workspaces);
            if (Array.isArray(parsed)) workspaces = parsed.filter((w): w is string => typeof w === 'string');
        } catch {
            workspaces = []; // corrupt JSON → admit nobody extra, never throw
        }
    }
    return { access, workspaces };
}

/**
 * Is this workspace the designated WORKSTATION OPERATOR (Tynn #248)?
 *
 * Fails CLOSED — an unknown id, a NULL column or a corrupt value all read as
 * `false`. This is authority over every workspace on the machine, so the only way
 * to hold it is to have been explicitly given it.
 */
export function isWorkstationOperator(id: string): boolean {
    const row = getDb()
        .prepare<[string], { workstation_operator: number | null } | undefined>(
            'SELECT workstation_operator FROM workspaces WHERE id = ?',
        )
        .get(id);
    return row?.workstation_operator === 1;
}

/**
 * Which kind of App workspace this is, or null for an ordinary one (Tynn #250).
 *
 * Read through here rather than off the row so an unrecognised value — a newer
 * Genie's kind, a hand edit — reads as "not an App workspace" instead of being
 * treated as one.
 */
export type WorkspaceAppKind = 'app' | 'app-dev' | 'app-preview';

/** PURE. The same narrowing, for a row already in hand — so a LIST of workspaces
 *  does not become one query each just to learn which are Apps. */
export function toWorkspaceAppKind(value: unknown): WorkspaceAppKind | null {
    return value === 'app' || value === 'app-dev' || value === 'app-preview' ? value : null;
}

export function getWorkspaceAppKind(id: string): WorkspaceAppKind | null {
    const row = getDb()
        .prepare<[string], { app_kind: string | null } | undefined>(
            'SELECT app_kind FROM workspaces WHERE id = ?',
        )
        .get(id);
    return toWorkspaceAppKind(row?.app_kind);
}

/**
 * Mark (or unmark) a workspace as hosting a GApp.
 *
 * `app-preview` is the THROWAWAY kind: a workspace opened for a preview window,
 * living on the developer's own folder, removed when the window closes and swept
 * at boot if it did not get to. It is a distinct value rather than a flag because
 * both of those deletions have to be able to recognise it with certainty — a
 * preview's workspace is one confused id away from being somebody's real project.
 */
export function setWorkspaceAppKind(id: string, kind: WorkspaceAppKind | null): void {
    getDb().prepare('UPDATE workspaces SET app_kind = ? WHERE id = ?').run(kind, id);
}

/**
 * Mark (or unmark) a workspace as a GApp Development Workspace (genie#245).
 *
 * Written ONLY by `syncGappDevWorkspaces`, which mirrors Tynn's `is_gapp`. There
 * is no user-facing toggle on purpose: the flag has exactly one home, and Genie
 * converging on it is what makes "turn it on in Tynn and Genie notices" true.
 */
/**
 * Grant (or revoke) this workspace's one reserved agent name.
 *
 * Written ONLY by `syncSacredWorkspaces`, which mirrors Tynn's marking. There is
 * no user-facing toggle on purpose, for the same reason `gapp_dev` has none: the
 * flag has exactly one home, and Genie converging on it is what makes "mark it
 * in Tynn and Genie notices" true.
 */
export function setWorkspaceSacredName(id: string, name: string | null): void {
    getDb().prepare('UPDATE workspaces SET sacred_name = ? WHERE id = ?').run(name, id);
}

export function setWorkspaceGappDev(id: string, on: boolean): void {
    getDb()
        .prepare('UPDATE workspaces SET gapp_dev = ? WHERE id = ?')
        .run(on ? 1 : 0, id);
}

/* -------------------------------------------------------------------------- */
/* GApp grants (Tynn #250)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * An installed GApp and what the user granted it.
 *
 * Read through {@link getAppGrant} rather than off the row: a malformed scope or
 * an unparseable capability list must degrade to LESS authority, never more, and
 * that only holds if there is one place doing the reading.
 */
/** Where an installed GApp came from. */
export interface AppGrantSource {
    kind: 'folder' | 'github';
    origin: string;
    /** The exact commit, for a GitHub install. */
    commit?: string;
}

export interface AppGrantRow {
    appId: string;
    workspaceId: string;
    name: string;
    version: string;
    slug: string;
    scope: 'self' | 'workspaces' | 'workstation';
    workspaces: string[];
    capabilities: string[];
    manifestJson: string;
    installPath: string;
    /** Where it came from. Null for an app installed before Genie recorded it. */
    source: AppGrantSource | null;
    revoked: boolean;
    /** Running from a folder Genie does not control, with dev tools on. */
    devMode: boolean;
    installedAt: string;
    updatedAt: string;
}

interface RawAppGrant {
    app_id: string;
    workspace_id: string;
    name: string;
    version: string;
    slug: string;
    scope: string;
    workspaces_json: string;
    capabilities_json: string;
    manifest_json: string;
    install_path: string;
    source_kind: string | null;
    source_origin: string | null;
    source_commit: string | null;
    revoked: number;
    dev_mode: number;
    installed_at: string;
    updated_at: string;
}

/** Parse a JSON string array, degrading to empty — never to "everything". */
function parseStringList(json: string): string[] {
    try {
        const parsed: unknown = JSON.parse(json);
        return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
        return [];
    }
}

function toAppGrant(row: RawAppGrant): AppGrantRow {
    return {
        appId: row.app_id,
        workspaceId: row.workspace_id,
        name: row.name,
        version: row.version,
        slug: row.slug,
        // An unrecognised scope narrows to `self`. The CHECK constraint should make
        // this unreachable; if it is ever reached, the safe reading is the smallest
        // one.
        scope:
            row.scope === 'workstation' || row.scope === 'workspaces'
                ? row.scope
                : 'self',
        workspaces: parseStringList(row.workspaces_json),
        capabilities: parseStringList(row.capabilities_json),
        manifestJson: row.manifest_json,
        installPath: row.install_path,
        // An unrecognised kind reads as "not recorded" rather than being shown
        // verbatim: a provenance line the user cannot trust is worse than none.
        source:
            (row.source_kind === 'folder' || row.source_kind === 'github') && row.source_origin
                ? {
                      kind: row.source_kind,
                      origin: row.source_origin,
                      ...(row.source_commit ? { commit: row.source_commit } : {}),
                  }
                : null,
        revoked: row.revoked === 1,
        devMode: row.dev_mode === 1,
        installedAt: row.installed_at,
        updatedAt: row.updated_at,
    };
}

const APP_GRANT_COLUMNS =
    'app_id, workspace_id, name, version, slug, scope, workspaces_json, capabilities_json, manifest_json, install_path, source_kind, source_origin, source_commit, revoked, dev_mode, installed_at, updated_at';

export function getAppGrant(appId: string): AppGrantRow | null {
    const row = getDb()
        .prepare<[string], RawAppGrant | undefined>(
            `SELECT ${APP_GRANT_COLUMNS} FROM app_grants WHERE app_id = ?`,
        )
        .get(appId);
    return row ? toAppGrant(row) : null;
}

/** The app installed into a workspace, if that workspace is an App workspace. */
export function getAppGrantForWorkspace(workspaceId: string): AppGrantRow | null {
    const row = getDb()
        .prepare<[string], RawAppGrant | undefined>(
            `SELECT ${APP_GRANT_COLUMNS} FROM app_grants WHERE workspace_id = ?`,
        )
        .get(workspaceId);
    return row ? toAppGrant(row) : null;
}

export function listAppGrants(): AppGrantRow[] {
    return getDb()
        .prepare<[], RawAppGrant>(`SELECT ${APP_GRANT_COLUMNS} FROM app_grants ORDER BY name`)
        .all()
        .map(toAppGrant);
}

/**
 * Record an install, or update one in place.
 *
 * Reinstalling an app does NOT silently re-grant what it had: the caller passes
 * the capabilities the user consented to THIS time, so a new version asking for
 * more has to ask again.
 */
export function upsertAppGrant(
    grant: Omit<AppGrantRow, 'installedAt' | 'updatedAt'> & { installedAt?: string },
): void {
    const now = new Date().toISOString();
    getDb()
        .prepare(
            `INSERT INTO app_grants (${APP_GRANT_COLUMNS})
             VALUES (@app_id, @workspace_id, @name, @version, @slug, @scope, @workspaces_json,
                     @capabilities_json, @manifest_json, @install_path, @source_kind,
                     @source_origin, @source_commit, @revoked, @dev_mode,
                     @installed_at, @updated_at)
             ON CONFLICT(app_id) DO UPDATE SET
                workspace_id = excluded.workspace_id,
                name = excluded.name,
                version = excluded.version,
                slug = excluded.slug,
                scope = excluded.scope,
                workspaces_json = excluded.workspaces_json,
                capabilities_json = excluded.capabilities_json,
                manifest_json = excluded.manifest_json,
                install_path = excluded.install_path,
                source_kind = excluded.source_kind,
                source_origin = excluded.source_origin,
                source_commit = excluded.source_commit,
                revoked = excluded.revoked,
                dev_mode = excluded.dev_mode,
                updated_at = excluded.updated_at`,
        )
        .run({
            app_id: grant.appId,
            workspace_id: grant.workspaceId,
            name: grant.name,
            version: grant.version,
            slug: grant.slug,
            scope: grant.scope,
            workspaces_json: JSON.stringify(grant.workspaces),
            capabilities_json: JSON.stringify(grant.capabilities),
            manifest_json: grant.manifestJson,
            install_path: grant.installPath,
            source_kind: grant.source?.kind ?? null,
            source_origin: grant.source?.origin ?? null,
            source_commit: grant.source?.commit ?? null,
            revoked: grant.revoked ? 1 : 0,
            dev_mode: grant.devMode ? 1 : 0,
            installed_at: grant.installedAt ?? now,
            updated_at: now,
        });
}

/** Turn an app's permissions off (or back on) without uninstalling it. */
/**
 * One app's BACKUP override, as stored. The raw blob, because `db.ts` does not
 * interpret what it persisted — `parseBackupOverride` owns that shape, the same
 * split `dev_services` already uses (Tynn #250, step 4).
 */
export function getAppBackupJson(appId: string): string | null {
    const row = getDb()
        .prepare<[string], { backup_json: string | null } | undefined>(
            'SELECT backup_json FROM app_grants WHERE app_id = ?',
        )
        .get(appId);
    return row?.backup_json ?? null;
}

/** `null` clears the override, so the app follows the workstation default again. */
export function setAppBackupJson(appId: string, json: string | null): void {
    getDb().prepare('UPDATE app_grants SET backup_json = ? WHERE app_id = ?').run(json, appId);
}

export function setAppGrantRevoked(appId: string, revoked: boolean): void {
    getDb()
        .prepare('UPDATE app_grants SET revoked = ?, updated_at = ? WHERE app_id = ?')
        .run(revoked ? 1 : 0, new Date().toISOString(), appId);
}

/** Change what an installed app is allowed to do, from its permissions screen. */
export function setAppGrantCapabilities(appId: string, capabilities: string[]): void {
    getDb()
        .prepare('UPDATE app_grants SET capabilities_json = ?, updated_at = ? WHERE app_id = ?')
        .run(JSON.stringify(capabilities), new Date().toISOString(), appId);
}

export function deleteAppGrant(appId: string): void {
    getDb().prepare('DELETE FROM app_grants WHERE app_id = ?').run(appId);
}

/** Grant or revoke the workstation-operator designation. */
export function setWorkstationOperator(id: string, on: boolean): void {
    getDb()
        .prepare('UPDATE workspaces SET workstation_operator = ? WHERE id = ?')
        .run(on ? 1 : 0, id);
}

/**
 * How `unlimited` survives an INTEGER column (Tynn #117).
 *
 * The column has to distinguish three states — inherit, a number, and explicitly
 * uncapped — and NULL is already spoken for by inherit. The sentinel is confined
 * to these two accessors so it never reaches a caller or a decision function.
 */
const AGENT_CAP_UNLIMITED_SENTINEL = -1;

/**
 * This workspace's agent-terminal override: a positive maximum, `'unlimited'`, or
 * `null` to inherit the workstation default.
 *
 * Never read the column directly — resolve through `effectiveAgentCap`, which
 * knows what to do when this is absent or unusable.
 */
export function getWorkspaceAgentCap(id: string): number | 'unlimited' | null {
    const row = getDb()
        .prepare<[string], { max_agent_terminals: number | null } | undefined>(
            'SELECT max_agent_terminals FROM workspaces WHERE id = ?',
        )
        .get(id);

    const raw = row?.max_agent_terminals;
    if (raw === AGENT_CAP_UNLIMITED_SENTINEL) return 'unlimited';
    // Anything else unusable (NULL, 0, a negative that is not the sentinel) reads
    // as "no opinion" so the workstation default applies. Inheriting is the safe
    // direction; treating a corrupt row as uncapped would delete the limit.
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return null;
    return raw;
}

/**
 * Set or clear this workspace's override. `null` clears it back to inheriting.
 *
 * NOT reachable from any agent-facing surface: this setter is never imported into
 * `main/mcp/`, and the column is absent from {@link updateWorkspace}'s allowlist,
 * so a patch naming it is dropped rather than applied. An agent that can raise its
 * own cap has no cap.
 */
export function setWorkspaceAgentCap(id: string, cap: number | 'unlimited' | null): void {
    let value: number | null;
    if (cap === 'unlimited') value = AGENT_CAP_UNLIMITED_SENTINEL;
    else if (typeof cap === 'number' && Number.isInteger(cap) && cap >= 1) value = cap;
    else value = null;

    getDb()
        .prepare('UPDATE workspaces SET max_agent_terminals = ? WHERE id = ?')
        .run(value, id);
}

export type IssuewatchPolicy = 'surface' | 'fix' | 'fix-and-ship';

/**
 * The three IssueWatch buckets (mirrors `WatchTypeCounts` in issue-watch/index.ts):
 * `security` collapses dependabot + code-scanning + secret-scanning. Each bucket
 * carries its OWN remediation policy, so a workspace can (e.g.) fix-and-ship
 * security immediately while holding regular issues.
 */
export interface IssuewatchPolicyBuckets {
    security: IssuewatchPolicy;
    issue: IssuewatchPolicy;
    pr: IssuewatchPolicy;
}

/** The conservative default every bucket reads as when unset: report only. */
export const DEFAULT_ISSUEWATCH_POLICY: IssuewatchPolicy = 'surface';

/** Coerce an arbitrary value to a valid IssuewatchPolicy, else `fallback`. */
function coercePolicy(v: unknown, fallback: IssuewatchPolicy): IssuewatchPolicy {
    return v === 'surface' || v === 'fix' || v === 'fix-and-ship' ? v : fallback;
}

/**
 * Resolve the per-bucket remediation policy from storage. `bucketsRaw` is the JSON
 * blob in `issuewatch_policy_buckets`; `legacyRaw` is the pre-per-bucket single
 * `issuewatch_policy` value, applied as the fallback for EVERY bucket so an
 * existing single setting keeps working (backward compat). Per-bucket precedence:
 * the JSON value → the legacy single value → 'surface'. Robust to NULL, corrupt
 * JSON, and partial objects. Always returns a fresh object (never a shared ref).
 */
export function parsePolicyBuckets(
    bucketsRaw: string | null | undefined,
    legacyRaw?: string | null,
): IssuewatchPolicyBuckets {
    const fallback = coercePolicy(legacyRaw, DEFAULT_ISSUEWATCH_POLICY);
    let j: Record<string, unknown> | null = null;
    if (bucketsRaw) {
        try {
            const parsed = JSON.parse(bucketsRaw);
            if (parsed && typeof parsed === 'object') j = parsed as Record<string, unknown>;
        } catch {
            j = null;
        }
    }
    return {
        security: coercePolicy(j?.security, fallback),
        issue: coercePolicy(j?.issue, fallback),
        pr: coercePolicy(j?.pr, fallback),
    };
}

/**
 * This workspace's resolved per-bucket IssueWatch remediation policy (how agents
 * act on its IssueWatch pings, per bucket). Falls back to the legacy single
 * `issuewatch_policy` value for every bucket, then to 'surface' — the same
 * conservative default the old single setting used.
 */
export function getWorkspaceIssuewatchPolicyBuckets(id: string): IssuewatchPolicyBuckets {
    const row = getDb()
        .prepare<
            [string],
            { issuewatch_policy_buckets: string | null; issuewatch_policy: string | null } | undefined
        >(
            'SELECT issuewatch_policy_buckets, issuewatch_policy FROM workspaces WHERE id = ?',
        )
        .get(id);
    return parsePolicyBuckets(
        row?.issuewatch_policy_buckets ?? null,
        row?.issuewatch_policy ?? null,
    );
}

/** Persist this workspace's per-bucket IssueWatch remediation policy (JSON). */
export function setWorkspaceIssuewatchPolicyBuckets(
    id: string,
    buckets: IssuewatchPolicyBuckets,
): void {
    getDb()
        .prepare('UPDATE workspaces SET issuewatch_policy_buckets = ? WHERE id = ?')
        .run(JSON.stringify(buckets), id);
}

// IssueWatch granularity ------------------------------------------------

/** How IssueWatch watches a fork's UPSTREAM (parent) repo. */
export type UpstreamGranularity = 'none' | 'issues' | 'issues+prs';

/**
 * Per-workspace IssueWatch granularity — WHAT IssueWatch watches + pings about.
 *   - `own`: each own-repo kind (Issues / Pull Requests / Security alerts) on/off.
 *   - `upstream`: for a forked repo, watch its parent's None / Issues / Issues+PRs.
 */
export interface IssuewatchGranularity {
    own: { issues: boolean; pulls: boolean; security: boolean };
    upstream: UpstreamGranularity;
}

/** The defaults a NULL/absent granularity reads as: every own kind ON (the prior
 *  behaviour) + upstream Issues+PRs auto-on for forks. */
export const DEFAULT_ISSUEWATCH_GRANULARITY: IssuewatchGranularity = {
    own: { issues: true, pulls: true, security: true },
    upstream: 'issues+prs',
};

/**
 * Parse a stored granularity JSON blob into a fully-defaulted granularity. Robust
 * to NULL, corrupt JSON, and partial objects: each own kind defaults ON (only an
 * explicit `false` disables it) and an unrecognized `upstream` falls back to
 * `issues+prs`. Always returns a fresh object (never a shared reference).
 */
export function parseGranularity(raw: string | null | undefined): IssuewatchGranularity {
    let j: { own?: Record<string, unknown>; upstream?: unknown } = {};
    if (raw) {
        try {
            j = (JSON.parse(raw) as typeof j) ?? {};
        } catch {
            j = {};
        }
    }
    const own = (j.own ?? {}) as Record<string, unknown>;
    const up = j.upstream;
    return {
        own: {
            issues: own.issues !== false,
            pulls: own.pulls !== false,
            security: own.security !== false,
        },
        upstream:
            up === 'none' || up === 'issues' || up === 'issues+prs'
                ? up
                : 'issues+prs',
    };
}

/** This workspace's resolved IssueWatch granularity (defaults applied). */
export function getWorkspaceIssuewatchGranularity(id: string): IssuewatchGranularity {
    const row = getDb()
        .prepare<[string], { issuewatch_granularity: string | null } | undefined>(
            'SELECT issuewatch_granularity FROM workspaces WHERE id = ?',
        )
        .get(id);
    return parseGranularity(row?.issuewatch_granularity ?? null);
}

/** Persist this workspace's IssueWatch granularity (JSON-encoded). */
export function setWorkspaceIssuewatchGranularity(
    id: string,
    granularity: IssuewatchGranularity,
): void {
    getDb()
        .prepare('UPDATE workspaces SET issuewatch_granularity = ? WHERE id = ?')
        .run(JSON.stringify(granularity), id);
}

/**
 * The workspace's DESIGNATED IssueWatch handler set — the agent terminal ids that
 * should receive its pings. Empty (the default: NULL / corrupt / non-array blob)
 * means "not designated", and the ping fans out to every `issuewatch_handle`
 * agent instead. Always returns a fresh array of strings (hostile entries dropped).
 */
export function getWorkspaceIssuewatchHandlers(id: string): string[] {
    const row = getDb()
        .prepare<[string], { issuewatch_handlers: string | null } | undefined>(
            'SELECT issuewatch_handlers FROM workspaces WHERE id = ?',
        )
        .get(id);
    if (!row?.issuewatch_handlers) return [];
    try {
        const j = JSON.parse(row.issuewatch_handlers);
        return Array.isArray(j) ? j.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

/** Persist this workspace's designated IssueWatch handler set (JSON array). An
 *  empty array clears the designation (fan-out to all handle-enabled agents). */
export function setWorkspaceIssuewatchHandlers(id: string, terminalIds: string[]): void {
    const clean = [...new Set(terminalIds.filter((x) => typeof x === 'string'))];
    getDb()
        .prepare('UPDATE workspaces SET issuewatch_handlers = ? WHERE id = ?')
        .run(JSON.stringify(clean), id);
}

/** A workspace's agent terminals with their IssueWatch ping settings — the
 *  candidate recipients the router resolves against. Only agent terminals (those
 *  with an AgentInbox `agent_id`) are candidates; `handle` defaults off and `action`
 *  defaults `notify`. */
export function listWorkspaceIssuewatchAgents(
    workspaceId: string,
): Array<{ terminalId: string; label: string; handle: boolean; action: 'notify' | 'wake' }> {
    return listTerminalSpecs()
        .filter((s) => s.workspace_id === workspaceId && !!s.meta?.agent_id)
        .map((s) => ({
            terminalId: s.id,
            label: s.label,
            handle: s.meta?.issuewatch_handle === true,
            action: s.meta?.issuewatch_action === 'wake' ? 'wake' : 'notify',
        }));
}

// Dev sites (the container Dev Server, #234 P2) --------------------------
//
// The ONE source of a `.gen` site: what GENIE serves. Single-column JSON; the
// id is workspace-SCOPED (two workspaces can each have a `web`).
// Parse/sanitize live in main/dev-server/sites-config.ts.

/**
 * The Tynn hosted-sites push (#661), injected by the desktop boot. db.ts must NOT
 * import the Tynn client itself — tynn.ts imports db.ts (getAllSettings), so a
 * direct import here would cycle. Default no-op: headless, not-linked, and tests
 * simply don't set it. `setHostedSitesSync(null)` clears it.
 */
let hostedSitesSync: ((projectId: string, sites: DevSites) => void) | null = null;

export function setHostedSitesSync(
    fn: ((projectId: string, sites: DevSites) => void) | null,
): void {
    hostedSitesSync = fn;
}

/**
 * The dev-site store: the `.agi` envelope (project.json `sites`) is the source of
 * truth so config travels with the repo; genie.db is the mirror. A non-envelope
 * workspace has no project.json and stays genie.db-only. Policy in
 * {@link resolveDevSites}/{@link persistDevSites}; this only supplies the raw
 * genie.db + envelope IO (all resolved lazily so nothing runs before the DB is up).
 */
const devSitesStore: DevSitesStore = {
    workspacePath: (id) => getWorkspace(id)?.path ?? null,
    isEnvelope: (folder) => isEnvelopeFolder(folder),
    // A GApp preview's workspace sits on the DEVELOPER'S folder, which is usually
    // an envelope. Its site config is Genie's scaffolding for a throwaway window,
    // not the app's, so it stays in genie.db and dies with the row instead of
    // landing in somebody's tracked project.json.
    isEphemeral: (id) => getWorkspaceAppKind(id) === 'app-preview',
    // Through the SAME sanitizer a write goes through. project.json is tracked, so
    // its `sites` arrives from a clone, a merge or a hand edit — raw it would feed
    // unvalidated values to a spawn and a cert, and a shape we cannot read would
    // pass as "this workspace has no sites" and wipe the mirror (genie#190). `null`
    // (not a sites map) reads as "the envelope does not say"; `{}` still means the
    // user removed their last site.
    readEnvelopeSites: (folder) => parseDevSitesValue(readProjectJson(folder)?.sites),
    writeEnvelopeSites: (folder, sites) => writeProjectJson(folder, { sites }),
    dbRead: (id) => {
        const row = getDb()
            .prepare<[string], { dev_sites: string | null } | undefined>(
                'SELECT dev_sites FROM workspaces WHERE id = ?',
            )
            .get(id);
        return parseDevSites(row?.dev_sites ?? null);
    },
    dbWrite: (id, sites) => {
        getDb().prepare('UPDATE workspaces SET dev_sites = ? WHERE id = ?').run(JSON.stringify(sites), id);
    },
    // A Tynn-linked envelope mirrors its sites onward to Tynn (#661). We resolve
    // the linked project id from the envelope; the injected push does the network
    // (fire-and-forget), so a dead session never fails the local write.
    onEnvelopePersisted: (folder, sites) => {
        const projectId = readProjectJson(folder)?.tynn?.projectId;
        if (projectId && hostedSitesSync) hostedSitesSync(projectId, sites);
    },
};

/** This workspace's dev sites — envelope-authoritative (NULL/absent ⇒ {} = none). */
export function getWorkspaceDevSites(id: string): DevSites {
    return resolveDevSites(devSitesStore, id);
}

/** Replace this workspace's whole dev-site map — writes the envelope + mirror.
 *  `env` is stripped from every site first (genie #168): the tracked manifest
 *  never holds a secret, and an existing leaked env is scrubbed on this write. */
export function setWorkspaceDevSites(id: string, sites: DevSites): void {
    persistDevSites(devSitesStore, id, withoutPersistedEnv(sites));
}

/**
 * Merge ONE dev site into this workspace's map, returning its id.
 *
 * The key is DERIVED from the (sanitized) name rather than supplied, so the
 * stored id and the stored name can never disagree — a mismatch there would mean
 * the manager starts a container for one site while the Testing Browser resolves
 * another. Returns null when the patch carries no usable name and none is stored.
 */
export function setWorkspaceDevSite(
    id: string,
    patch: Partial<DevSiteConfig> & { siteId?: string },
): string | null {
    const current = getWorkspaceDevSites(id);
    const clean = sanitizeDevSitePatch(patch);
    const name = clean.name ?? (patch.siteId ? current[patch.siteId]?.name : undefined);
    if (!name) return null;
    const siteId = devSiteIdFor(id, name);
    const previous = (patch.siteId ? current[patch.siteId] : undefined) ?? current[siteId] ?? {};
    // Defaults UNDER the stored row, which is under the patch — a create gets a
    // complete row, an update touches only what it named.
    const combined: Partial<DevSiteConfig> = { ...previous, ...clean, name };
    const merged: DevSiteConfig = {
        ...combined,
        name,
        genName: combined.genName ?? '',
        repo: combined.repo ?? '',
        runMode: combined.runMode ?? 'explicit',
        kind: combined.kind ?? 'http',
        enabled: combined.enabled ?? false,
    };
    if (!merged.genName) return null;
    const next = { ...current, [siteId]: merged };
    // Renaming a site moves it to a new key; drop the old one so the map never
    // holds two entries for one site.
    if (patch.siteId && patch.siteId !== siteId) delete next[patch.siteId];
    setWorkspaceDevSites(id, next);
    return siteId;
}

/** Forget one dev site entirely (`manageSite remove`). */
export function deleteWorkspaceDevSite(id: string, siteId: string): void {
    const current = getWorkspaceDevSites(id);
    if (!(siteId in current)) return;
    const next = { ...current };
    delete next[siteId];
    setWorkspaceDevSites(id, next);
    // The site is gone; its run state is about a site that no longer exists.
    // Leaving the row would also mean a site recreated under the same name (the
    // id is derived from workspace + name) inherited a stop nobody asked for.
    forgetSiteRunState(siteId);
}

// A site's DESIRED RUN STATE (genie#407) --------------------------------------
//
// Deliberately NOT part of `DevSites`, and so deliberately not in project.json.
// `enabled` says the site is configured to be served and belongs in the tracked
// envelope, where a teammate's clone gets it. Whether the user wants it running
// on THIS machine right now is a different fact with a different lifetime, and
// keeping it here is what stops one person's stop becoming a tracked diff and a
// `git pull` becoming a way to restart a site somebody deliberately stopped.
//
// Absence means "not stopped": a site nobody has ever stopped has no row.

/** Record (or lift) the user's stop for one site. Best-effort. */
export function setSiteStoppedByUser(siteId: string, stopped: boolean): void {
    if (!siteId) return;
    getDb()
        .prepare(
            `INSERT INTO site_run_state (site_id, stopped, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(site_id) DO UPDATE SET stopped = excluded.stopped, updated_at = excluded.updated_at`,
        )
        .run(siteId, stopped ? 1 : 0, Date.now());
}

/** Did the user stop this site, and not start it since? */
export function isSiteStoppedByUser(siteId: string): boolean {
    if (!siteId) return false;
    const row = getDb()
        .prepare<[string], { stopped: number }>(
            'SELECT stopped FROM site_run_state WHERE site_id = ?',
        )
        .get(siteId);
    return row?.stopped === 1;
}

/** Forget a site's run state (it was removed, or renamed to a new id). */
export function forgetSiteRunState(siteId: string): void {
    if (!siteId) return;
    getDb().prepare('DELETE FROM site_run_state WHERE site_id = ?').run(siteId);
}

// The DRAIN ROSTER (genie#389) ------------------------------------------------
//
// What was running when a drain began, so the boot on the other side of the
// upgrade can bring exactly that back — no more (which would restart what the
// user stopped) and no less (which would leave them to work out what was up).
//
// The `db` is passed rather than reached for, so the store is exercised against
// a real in-memory database without standing an app up around it.

/** One thing that was running when the drain began. */
export interface DrainRosterRow {
    kind: 'agent' | 'site' | 'process';
    /** The agent id / site id / process spec id — whatever starts it again. */
    ref: string;
    label: string;
    workspaceId: string;
}

/**
 * Replace the roster with this one.
 *
 * REPLACE, not append: a roster is a snapshot of one moment, and merging a new
 * drain into an old one restores a set nobody drained. Recording an EMPTY list
 * is therefore meaningful — it says this drain found nothing running — and
 * clears the table rather than leaving the previous drain's list to be restored.
 */
export function recordDrainRoster(
    d: Database.Database,
    entries: readonly DrainRosterRow[],
): void {
    const now = Date.now();
    const write = d.transaction((rows: readonly DrainRosterRow[]) => {
        d.prepare('DELETE FROM drain_roster').run();
        const insert = d.prepare(
            `INSERT INTO drain_roster (kind, ref, label, workspace_id, seq, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(kind, ref) DO NOTHING`,
        );
        rows.forEach((row, index) => {
            if (!row.ref) return;
            insert.run(row.kind, row.ref, row.label ?? '', row.workspaceId ?? '', index, now);
        });
    });
    write(entries);
}

/** The roster, in the order it was recorded. Empty when no drain is pending. */
export function readDrainRoster(d: Database.Database): DrainRosterRow[] {
    return d
        .prepare<[], { kind: string; ref: string; label: string; workspace_id: string }>(
            'SELECT kind, ref, label, workspace_id FROM drain_roster ORDER BY seq ASC',
        )
        .all()
        .map((row) => ({
            kind: row.kind as DrainRosterRow['kind'],
            ref: row.ref,
            label: row.label,
            workspaceId: row.workspace_id,
        }));
}

/** Consume the roster. Called once the restore has run, so an ordinary launch
 *  after it restores nothing — the list describes one upgrade, not a policy. */
export function clearDrainRoster(d: Database.Database): void {
    d.prepare('DELETE FROM drain_roster').run();
}

// Dev services (the container Dev Server, #234 P3) ------------------------
//
// This workspace's SLICE of a shared engine — which engine, which version,
// shared or dedicated, and its own credential. The engine CONTAINER itself is
// machine-scoped and lives in `dev_service_engines` below, because one postgres
// serves many workspaces and its superuser credential belongs to none of them.
// Parse/sanitize live in main/dev-server/services/services-config.ts.

/** This workspace's stored services (NULL/absent ⇒ {} = none configured). */
export function getWorkspaceDevServices(id: string): DevServices {
    const row = getDb()
        .prepare<[string], { dev_services: string | null } | undefined>(
            'SELECT dev_services FROM workspaces WHERE id = ?',
        )
        .get(id);
    return parseDevServices(row?.dev_services ?? null);
}

/** Replace this workspace's whole service map (JSON-encoded). */
export function setWorkspaceDevServices(id: string, services: DevServices): void {
    getDb()
        .prepare('UPDATE workspaces SET dev_services = ? WHERE id = ?')
        .run(JSON.stringify(services), id);
}

/**
 * Merge ONE service into this workspace's map, returning its id.
 *
 * The key is DERIVED from (workspace, engine, VERSION) rather than supplied, so
 * a workspace can hold a `postgres-15` and a `postgres-16` at once but can never
 * accumulate two `postgres-16` entries fighting over one database name.
 *
 * The credential is minted HERE, on the way in, and only when absent — doing it
 * on write rather than on read is what makes it stable, and a password
 * regenerated on read would lock the workspace out of the database that was
 * created with it.
 */
export function setWorkspaceDevService(
    id: string,
    patch: Partial<DevServiceConfig>,
): string | null {
    const clean = sanitizeDevServicePatch(patch);
    if (!clean.engine) return null;
    const version = clean.version ?? resolveEngineVersion(clean.engine, undefined);
    if (!version) return null;
    const serviceId = devServiceIdFor(id, engineKeyFor(clean.engine, version));
    const current = getWorkspaceDevServices(id);
    const previous = current[serviceId];
    // The merge — including "the password comes ONLY from the stored row, so a
    // re-add can never re-key a workspace out of its own database" (genie#193) —
    // is a pure decision, asserted directly in `merge-service.test.ts`.
    // `engine` is re-stated because the guard above narrows the FIELD, not `clean`.
    const merged = mergeDevServiceConfig(
        previous,
        { ...clean, engine: clean.engine },
        version,
        generateServicePassword,
    );
    setWorkspaceDevServices(id, { ...current, [serviceId]: merged });
    return serviceId;
}

/** Forget one dev service entirely (`manageService remove`). */
export function deleteWorkspaceDevService(id: string, serviceId: string): void {
    const current = getWorkspaceDevServices(id);
    if (!(serviceId in current)) return;
    const next = { ...current };
    delete next[serviceId];
    setWorkspaceDevServices(id, next);
}

/**
 * The superuser credential for one engine CONTAINER, minted once and then
 * stable.
 *
 * Machine-scoped, keyed by the container's identity (`postgres-16`, or
 * `postgres-16@<workspaceId>` for a dedicated one) — a shared engine's admin
 * password cannot live in one workspace's row, because the container outlives
 * any one workspace's interest in it.
 *
 * NEVER regenerated. Every engine image bakes its credential into the data
 * directory on first init and ignores the environment afterwards, so handing
 * back a fresh password would lock Genie out of the engine it created.
 */
export function getOrCreateDevServiceEngine(req: {
    recordKey: string;
    engine: ServiceEngine;
    version: string;
    workspaceId: string | null;
    adminUser: string;
    newPassword?: () => string;
}): { user: string; password: string } {
    const db = getDb();
    const existing = db
        .prepare<[string], { admin_user: string; admin_password: string } | undefined>(
            'SELECT admin_user, admin_password FROM dev_service_engines WHERE key = ?',
        )
        .get(req.recordKey);
    if (existing) return { user: existing.admin_user, password: existing.admin_password };

    const password = (req.newPassword ?? generateServicePassword)();
    db.prepare(
        `INSERT OR IGNORE INTO dev_service_engines
         (key, engine, version, workspace_id, admin_user, admin_password, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        req.recordKey,
        req.engine,
        req.version,
        req.workspaceId,
        req.adminUser,
        password,
        Date.now(),
    );
    // Re-read rather than trusting the insert: two windows can reach this at
    // once, and the loser must use the winner's credential, not its own.
    const row = db
        .prepare<[string], { admin_user: string; admin_password: string } | undefined>(
            'SELECT admin_user, admin_password FROM dev_service_engines WHERE key = ?',
        )
        .get(req.recordKey);
    return { user: row?.admin_user ?? req.adminUser, password: row?.admin_password ?? password };
}

/** Forget an engine record — only ever alongside removing its container AND its
 *  volume, since the credential is baked into the data directory. */
export function deleteDevServiceEngine(recordKey: string): void {
    getDb().prepare('DELETE FROM dev_service_engines WHERE key = ?').run(recordKey);
    deleteDevServicePorts(recordKey);
}

/**
 * The host ports this engine was published on last time, by surface name.
 *
 * Empty for an engine that has never run, or one whose preferred (derived) port
 * has always been available — the derivation is the default and needs no row. See
 * `dev-server/services/service-ports.ts` for why the exceptions are remembered.
 */
export function getDevServicePorts(recordKey: string): Record<string, number> {
    const rows = getDb()
        .prepare<[string], { port_name: string; host_port: number }>(
            'SELECT port_name, host_port FROM dev_service_ports WHERE record_key = ?',
        )
        .all(recordKey);
    return Object.fromEntries(rows.map((r) => [r.port_name, r.host_port]));
}

/** Remember what an engine was actually published on, so the next create asks for
 *  the same numbers rather than re-deriving and moving. */
export function saveDevServicePorts(recordKey: string, ports: Record<string, number>): void {
    const db = getDb();
    const stmt = db.prepare(
        `INSERT INTO dev_service_ports (record_key, port_name, host_port, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(record_key, port_name) DO UPDATE SET host_port = excluded.host_port`,
    );
    const write = db.transaction((entries: Array<[string, number]>) => {
        for (const [name, port] of entries) stmt.run(recordKey, name, port, Date.now());
    });
    write(Object.entries(ports).filter(([, port]) => Number.isInteger(port)));
}

/** Forget an engine's publication. Only alongside removing its container — a
 *  reservation outliving nothing is a port held against a machine for no reason. */
export function deleteDevServicePorts(recordKey: string): void {
    getDb().prepare('DELETE FROM dev_service_ports WHERE record_key = ?').run(recordKey);
}

// Fork → upstream cache -------------------------------------------------

/** A cached fork→upstream resolution (see migration v16). */
export interface ForkUpstreamRow {
    owner: string;
    repo: string;
    /** 1 when `<owner>/<repo>` is a fork, else 0. */
    is_fork: number;
    /** The upstream (parent) owner — NULL for a non-fork or orphan fork. */
    upstream_owner: string | null;
    /** The upstream (parent) repo — NULL for a non-fork or orphan fork. */
    upstream_repo: string | null;
    /** ISO timestamp of the last resolution (drives the ~7-day staleness check). */
    checked_at: string;
}

/** The cached fork→upstream entry for a repo, or undefined when never resolved. */
export function getForkUpstream(owner: string, repo: string): ForkUpstreamRow | undefined {
    return getDb()
        .prepare<[string, string], ForkUpstreamRow | undefined>(
            'SELECT owner, repo, is_fork, upstream_owner, upstream_repo, checked_at FROM fork_upstream WHERE owner = ? AND repo = ?',
        )
        .get(owner, repo);
}

/** Upsert a fork→upstream resolution, stamping `checked_at` (defaults to now). */
export function setForkUpstream(
    owner: string,
    repo: string,
    isFork: boolean,
    upstreamOwner: string | null,
    upstreamRepo: string | null,
    checkedAt: string = new Date().toISOString(),
): void {
    getDb()
        .prepare(
            `INSERT INTO fork_upstream (owner, repo, is_fork, upstream_owner, upstream_repo, checked_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(owner, repo) DO UPDATE SET
               is_fork        = excluded.is_fork,
               upstream_owner = excluded.upstream_owner,
               upstream_repo  = excluded.upstream_repo,
               checked_at     = excluded.checked_at`,
        )
        .run(owner, repo, isFork ? 1 : 0, upstreamOwner, upstreamRepo, checkedAt);
}

// Backend connection helpers --------------------------------------------

export interface BackendConfig {
    host?: string;
    token?: string | null;
}

export function getAionimaConfig(): BackendConfig {
    const row = getDb()
        .prepare<[string], { host: string | null; token: string | null } | undefined>(
            'SELECT host, token FROM backend_connections WHERE backend = ?',
        )
        .get('aionima');
    if (!row) return { host: undefined, token: undefined };
    return { host: row.host ?? undefined, token: row.token ?? undefined };
}

export function setAionimaConfig(patch: BackendConfig): BackendConfig {
    const existing = getAionimaConfig();
    const next: BackendConfig = {
        host: patch.host !== undefined ? patch.host : existing.host,
        token: patch.token !== undefined ? patch.token : existing.token,
    };
    getDb()
        .prepare(
            `INSERT INTO backend_connections (backend, host, token, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(backend) DO UPDATE SET
               host = excluded.host,
               token = excluded.token,
               updated_at = excluded.updated_at`,
        )
        .run('aionima', next.host ?? null, next.token ?? null, new Date().toISOString());
    return next;
}

// Terminal spec helpers -------------------------------------------------

/** A view spec is a terminal, a fancy-code editor, or a background process runner. */
export type TerminalSpecType = 'terminal' | 'code' | 'process' | 'plugin' | 'plugin-panel';

/** Per-type metadata. Code views persist the open file's workspace-relative path. */
export interface TerminalSpecMeta {
    file_path?: string;
    /** When true, a code view is pinned to `root` and reopens `file_path`. */
    locked?: boolean;
    /** Workspace-relative folder the tree is rooted at when locked. */
    root?: string;
    /** Process views: the command line run (non-interactively) by the runner. */
    command?: string;
    /** Process views: start automatically when the workspace/app opens. */
    autostart?: boolean;
    /** Process views: relaunch the command (with backoff) if it exits/crashes. */
    restart_on_exit?: boolean;
    /**
     * Process views: persisted "was running" intent. Set true while the process
     * is running and false on a deliberate stop or terminal failure, so a
     * process active when Genie went down (quit/update/crash) is auto-restored
     * on next launch — like a service. Distinct from `autostart` (which the
     * user opts into); this tracks live state.
     */
    was_running?: boolean;
    /**
     * Process views: the user PAUSED this process — they deliberately stopped it
     * and have not started it since (genie#407). Persisted, and boot honours it:
     * `startAutostartProcesses()` skips a spec carrying it, whatever `autostart`
     * says.
     *
     * Distinct from both its neighbours, and it has to be. `autostart` is
     * CONFIGURATION ("this is a service"); `was_running` is the answer to "was it
     * up when Genie went down", which is also false for a process that has never
     * run and for one whose retries were exhausted. Neither can say "the user
     * asked for this to be down", and Genie's rule needs exactly that: it may
     * restore what IT stopped on the user's behalf, never restart what the USER
     * stopped. Only an explicit start clears it.
     */
    user_stopped?: boolean;
    /**
     * SCHEDULED TASK: a 5-field cron expression (min hour dom month dow), in the
     * HOST's local time. Its PRESENCE is what makes a process spec a scheduled
     * task rather than a long-running service: the scheduler arms one timer to
     * the next occurrence, runs the spec ONE-SHOT per fire, and re-arms —
     * `restart_on_exit` / `autostart` / `was_running` do not apply, because the
     * schedule (not the supervisor) decides when it runs again.
     */
    schedule?: string;
    /**
     * SCHEDULED TASK: what a fire actually does. `command` (the default) spawns
     * `command` exactly like a process run; `agent-nudge` delivers
     * `nudge_prompt` to an agent terminal through AgentInbox, waking it if it is
     * provably idle; `flow` runs the fancy-flow workflow named by `flow_id`.
     *
     * `flow` exists so a scheduled workflow reuses THIS scheduler rather than
     * growing a second one. It also satisfies the rule that ops must not depend
     * on an agent being asked: a flow's schedule is declared on its canvas, Genie
     * reconciles a spec for it, and the fire happens on the Host whether or not
     * anyone has Genie open.
     */
    schedule_kind?: 'command' | 'agent-nudge' | 'flow';
    /** flow: the workflow this fire runs. Reconciled from the flow's own graph. */
    flow_id?: string;
    /** agent-nudge: the terminal to nudge (preferred — it is the stable handle). */
    nudge_target_terminal_id?: string;
    /** agent-nudge: the AgentInbox agent id to nudge, when the terminal isn't known. */
    nudge_agent_id?: string;
    /** agent-nudge: the prompt text delivered to the agent on each fire. */
    nudge_prompt?: string;
    /** SCHEDULED TASK: epoch ms the last fire STARTED. Absent = never run. */
    last_run_at?: number;
    /**
     * SCHEDULED TASK: how the last fire went — `ok` (it ran), `failed` (the
     * spawn/nudge threw or was refused), `skipped` (the previous run was still
     * in flight, so this occurrence was dropped rather than overlapped).
     */
    last_run_status?: 'ok' | 'failed' | 'skipped';
    /**
     * SCHEDULED TASK: set while an agent-armed schedule is waiting on the user's
     * approval. The spec exists (so the user can see it) but is `enabled: false`
     * and MUST NOT be armed. Cleared on approve; the spec is deleted on deny.
     */
    schedule_pending_approval?: boolean;
    /** Plugin editor view: the owning plugin id (§6.1). */
    plugin_id?: string;
    /** Plugin editor view: the plugin's editor id from its manifest. */
    editor_id?: string;
    /** Plugin editor view: the workspace-relative file the editor is bound to. */
    file?: string;
    /** Plugin editor view: the declared first-party Fancy component export. */
    fancy_export?: string;
    /** Plugin editor view: the declared Fancy package + version (provenance). */
    fancy_package?: string;
    fancy_version?: string;
    /**
     * System Workspace tag: the spec belongs to the System Workspace but is
     * deliberately UNATTACHED — an editor/plugin panel that roots at its own `cwd`
     * and reads the whole filesystem, or a global background process whose cwd the
     * user picked. Attaching those to the row would re-root them: `CodePanel`
     * resolves an ATTACHED panel's tabs against the workspace path.
     *
     * It is no longer the workstation operator's marker. The operator has a real
     * `workspace_id` (`__system__`, rooted at `~/.gosa`); this tag used to stand in
     * for a row that did not exist, and every surface substituting for it is gone.
     */
    system?: boolean;
    /**
     * GApp agent panels (genie#245): the app whose declared agent runs here, the
     * agent's NAME as the manifest declared it (and as the consent screen said
     * it), and the ABSOLUTE path of the persona it was launched against.
     *
     * On the spec's meta rather than a new table, for the reason every other
     * agent-terminal fact is: the spec is what survives a restart, so the binding
     * has to ride it or a relaunched panel forgets who it was. It is also what
     * makes "this app's agents are actually running" answerable by looking, which
     * is the whole complaint in genie#245.
     */
    gapp_id?: string;
    gapp_agent?: string;
    gapp_persona?: string;
    /** Agent terminals (runAgent / specialized): which AI TUI this runs. */
    agent?: AgentTuiId;
    /** Agent terminals: the CLI command line that was launched (display). */
    agent_command?: string;
    /** Who asked for this terminal (Tynn #117). Absent on terminals created before
     *  the field existed, which read as `'human'` — the cap must not apply
     *  retroactively to work already running. */
    created_by?: 'human' | 'agent';
    /**
     * AgentInbox identity + accessibility (Specialized Terminals). These ride
     * the spec's meta so an agent's AgentInbox registration is durable across a
     * restart (the in-memory broker rehydrates from them) — NO migration.
     *
     * BACK-COMPAT: the stored `whisper_*` meta key names are RETAINED (the feature
     * was renamed WhisperChat → AgentInbox; renaming these persisted keys would
     * need a data migration of existing installs, so the wire names stay).
     */
    /** Stable AgentInbox identity (uuid). Present ⇒ this terminal is an AgentInbox agent. */
    agent_id?: string;
    /** Channel purpose (kebab). Default `general`. */
    whisper_purpose?: string;
    /** Accessibility scope — who can DM this agent. Default `self`. `hidden` also
     *  removes it from peers' discovery; see AgentInboxScope for the full model. */
    whisper_scope?: AgentInboxScope;
    /** Workspace ids this agent is visible to when `whisper_scope: 'specific'`. */
    whisper_workspaces?: string[];
    /** Opt-in wake-on-DM (issue #9): a DM to an idle agent may inject a nudge to
     *  start a turn. Default off/absent. */
    whisper_wake_on_dm?: boolean;
    /** Channel keys this agent explicitly joined (genie #65) — everything beyond
     *  its own `<workspaceId>:<purpose>` room, which is re-derived from
     *  `whisper_purpose` instead. The broker's `channelMembers` map is pure
     *  runtime state, so without this a restart or an agent-terminal relaunch
     *  silently evicted the agent from every shared channel. */
    whisper_channels?: string[];
    /** IssueWatch pings (feature): this agent participates in its workspace's
     *  IssueWatch deltas. Default off/absent — no ping is delivered. */
    issuewatch_handle?: boolean;
    /** IssueWatch pings: how this agent reacts to a ping — `notify` glows its
     *  terminal, `wake` injects an idle-only nudge (same fail-safe gate as
     *  wake-on-DM). Default `notify` when `issuewatch_handle` is on. */
    issuewatch_action?: 'notify' | 'wake';
    /** The captured AI chat-session uuid (session-capture), when known. */
    chat_session_id?: string;
    [key: string]: unknown;
}

export interface TerminalSpecRow {
    id: string;
    workspace_id: string | null;
    label: string;
    cwd: string;
    shell: string | null;
    args: string[];
    env: Record<string, string>;
    type: TerminalSpecType;
    meta: TerminalSpecMeta;
    sort_order: number;
    created_at: string;
    last_opened_at: string | null;
    /** Epoch ms of the last written session snapshot, or null when none. */
    snapshot_at: number | null;
    /** On-disk encrypted snapshot size in bytes, or null when none. */
    snapshot_bytes: number | null;
    /** Last cwd the shell reported via OSC-7, or null when unknown. */
    live_cwd: string | null;
    /**
     * Tier 2: true when the terminal is live/visible, false when it has been
     * DISABLED (suspended-but-retained). A disabled terminal keeps its spec and,
     * while the app is open, its running pty. Pre-v6 rows read back as true.
     */
    enabled: boolean;
    /**
     * Tier 3: the detached pty-host's session key for this spec, so a spec can
     * be re-associated with a still-running shell across an app restart. NULL
     * when there's no host session (in-process backend or never host-started).
     */
    host_session_id: string | null;
}

interface TerminalSpecRecord {
    id: string;
    workspace_id: string | null;
    label: string;
    cwd: string;
    shell: string | null;
    args_json: string;
    env_json: string;
    /** Nullable in the read because pre-v4 rows existed before the column;
     *  the column default ('terminal') fills new rows, but a SELECT * over a
     *  brand-new DB still types it as possibly absent. */
    type: string | null;
    meta_json: string | null;
    sort_order: number;
    created_at: string;
    last_opened_at: string | null;
    /** Pre-v5 rows lack these columns; a SELECT * over an older DB types them
     *  as possibly absent. Null = no snapshot / cwd unknown. */
    snapshot_at: number | null;
    snapshot_bytes: number | null;
    live_cwd: string | null;
    /** Pre-v6 rows lack this column; a SELECT * over an older DB types it as
     *  possibly absent. NULL/absent → enabled (1). Stored as 0/1. */
    enabled: number | null;
    /** Pre-v7 rows lack this column; NULL = no host session. */
    host_session_id: string | null;
}

function rowFromRecord(r: TerminalSpecRecord): TerminalSpecRow {
    let args: string[] = [];
    let env: Record<string, string> = {};
    let meta: TerminalSpecMeta = {};
    try { args = JSON.parse(r.args_json); } catch { args = []; }
    try { env = JSON.parse(r.env_json); } catch { env = {}; }
    try { meta = r.meta_json ? JSON.parse(r.meta_json) : {}; } catch { meta = {}; }
    const type: TerminalSpecType =
        r.type === 'code'
            ? 'code'
            : r.type === 'process'
              ? 'process'
              : r.type === 'plugin'
                ? 'plugin'
                : r.type === 'plugin-panel'
                  ? 'plugin-panel'
                : 'terminal';
    return {
        id: r.id,
        workspace_id: r.workspace_id,
        label: r.label,
        cwd: r.cwd,
        shell: r.shell,
        args,
        env,
        type,
        meta,
        sort_order: r.sort_order,
        created_at: r.created_at,
        last_opened_at: r.last_opened_at,
        snapshot_at: r.snapshot_at ?? null,
        snapshot_bytes: r.snapshot_bytes ?? null,
        live_cwd: r.live_cwd ?? null,
        // NULL (pre-v6) or 1 → enabled; only an explicit 0 disables.
        enabled: r.enabled == null ? true : r.enabled !== 0,
        host_session_id: r.host_session_id ?? null,
    };
}

export function listTerminalSpecs(): TerminalSpecRow[] {
    return getDb()
        .prepare<[], TerminalSpecRecord>(
            'SELECT * FROM terminal_specs ORDER BY workspace_id, sort_order, created_at',
        )
        .all()
        .map(rowFromRecord);
}

export function getTerminalSpec(id: string): TerminalSpecRow | null {
    const r = getDb()
        .prepare<[string], TerminalSpecRecord>('SELECT * FROM terminal_specs WHERE id = ?')
        .get(id);
    return r ? rowFromRecord(r) : null;
}

export function createTerminalSpec(input: {
    id: string;
    workspace_id: string | null;
    label: string;
    cwd: string;
    shell?: string | null;
    args?: string[];
    env?: Record<string, string>;
    type?: TerminalSpecType;
    meta?: TerminalSpecMeta;
}): TerminalSpecRow {
    const now = new Date().toISOString();
    const nextOrder = (getDb()
        .prepare<[string | null], { mx: number | null }>(
            'SELECT MAX(sort_order) AS mx FROM terminal_specs WHERE workspace_id IS ?',
        )
        .get(input.workspace_id)?.mx ?? -1) + 1;

    getDb()
        .prepare(
            `INSERT INTO terminal_specs
             (id, workspace_id, label, cwd, shell, args_json, env_json, type, meta_json, sort_order, created_at)
             VALUES (@id, @workspace_id, @label, @cwd, @shell, @args_json, @env_json, @type, @meta_json, @sort_order, @created_at)`,
        )
        .run({
            id: input.id,
            workspace_id: input.workspace_id,
            label: input.label,
            cwd: input.cwd,
            shell: input.shell ?? null,
            args_json: JSON.stringify(input.args ?? []),
            env_json: JSON.stringify(input.env ?? {}),
            type:
                input.type === 'code'
                    ? 'code'
                    : input.type === 'process'
                      ? 'process'
                      : input.type === 'plugin'
                        ? 'plugin'
                        : input.type === 'plugin-panel'
                          ? 'plugin-panel'
                        : 'terminal',
            meta_json: JSON.stringify(input.meta ?? {}),
            sort_order: nextOrder,
            created_at: now,
        });

    return getTerminalSpec(input.id)!;
}

export function updateTerminalSpec(
    id: string,
    patch: Partial<{
        label: string;
        cwd: string;
        shell: string | null;
        args: string[];
        env: Record<string, string>;
        type: TerminalSpecType;
        meta: TerminalSpecMeta;
        workspace_id: string | null;
        sort_order: number;
        snapshot_at: number | null;
        snapshot_bytes: number | null;
        live_cwd: string | null;
        enabled: boolean;
        host_session_id: string | null;
    }>,
): TerminalSpecRow | null {
    const cur = getTerminalSpec(id);
    if (!cur) return null;
    const next = {
        label: patch.label ?? cur.label,
        cwd: patch.cwd ?? cur.cwd,
        shell: patch.shell !== undefined ? patch.shell : cur.shell,
        args_json: JSON.stringify(patch.args ?? cur.args),
        env_json: JSON.stringify(patch.env ?? cur.env),
        type: patch.type !== undefined ? patch.type : cur.type,
        meta_json: JSON.stringify(patch.meta !== undefined ? patch.meta : cur.meta),
        workspace_id:
            patch.workspace_id !== undefined ? patch.workspace_id : cur.workspace_id,
        sort_order: patch.sort_order ?? cur.sort_order,
        snapshot_at:
            patch.snapshot_at !== undefined ? patch.snapshot_at : cur.snapshot_at,
        snapshot_bytes:
            patch.snapshot_bytes !== undefined
                ? patch.snapshot_bytes
                : cur.snapshot_bytes,
        live_cwd: patch.live_cwd !== undefined ? patch.live_cwd : cur.live_cwd,
        enabled:
            patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled ? 1 : 0,
        host_session_id:
            patch.host_session_id !== undefined
                ? patch.host_session_id
                : cur.host_session_id,
    };
    getDb()
        .prepare(
            `UPDATE terminal_specs SET
               label = @label,
               cwd   = @cwd,
               shell = @shell,
               args_json = @args_json,
               env_json  = @env_json,
               type      = @type,
               meta_json = @meta_json,
               workspace_id = @workspace_id,
               sort_order   = @sort_order,
               snapshot_at    = @snapshot_at,
               snapshot_bytes = @snapshot_bytes,
               live_cwd       = @live_cwd,
               enabled        = @enabled,
               host_session_id = @host_session_id
             WHERE id = @id`,
        )
        .run({ id, ...next });
    return getTerminalSpec(id);
}

export function deleteTerminalSpec(id: string): boolean {
    const info = getDb().prepare('DELETE FROM terminal_specs WHERE id = ?').run(id);
    return info.changes > 0;
}

export function touchTerminalSpec(id: string): void {
    getDb()
        .prepare('UPDATE terminal_specs SET last_opened_at = ? WHERE id = ?')
        .run(new Date().toISOString(), id);
}

/**
 * Persist a user-defined PANEL order (the grid's drag-reorder). `ids` is the
 * full ordered list of spec ids for one workspace; each gets its index as
 * sort_order, which is exactly what listTerminalSpecs() sorts by. Unknown ids
 * are ignored. One transaction so the grid never reads a partial reorder —
 * mirrors reorderWorkspaces() for the sidebar.
 */
export function reorderTerminalSpecs(ids: string[]): void {
    const stmt = getDb().prepare(
        'UPDATE terminal_specs SET sort_order = ? WHERE id = ?',
    );
    const tx = getDb().transaction((order: string[]) => {
        order.forEach((id, i) => stmt.run(i, id));
    });
    tx(ids);
}

// Issue Watch ----------------------------------------------------------------

export interface IssueWatchRow {
    workspace_id: string;
    owner: string;
    repo: string;
    enabled: number; // 1/0
    seen_at: string; // ISO; items updated after this are "unread"
}

/** All watch rows for a workspace. */
export function listIssueWatches(workspaceId: string): IssueWatchRow[] {
    return getDb()
        .prepare<[string], IssueWatchRow>(
            'SELECT workspace_id, owner, repo, enabled, seen_at FROM issue_watches WHERE workspace_id = ?',
        )
        .all(workspaceId);
}

/** Every enabled watch across all workspaces (for the background poller). */
export function listEnabledIssueWatches(): IssueWatchRow[] {
    return getDb()
        .prepare<[], IssueWatchRow>(
            'SELECT workspace_id, owner, repo, enabled, seen_at FROM issue_watches WHERE enabled = 1',
        )
        .all();
}

/**
 * Upsert a watch's enabled flag. Auto-detected repos call this with the prior
 * enabled value (default 1) so toggling persists without resetting seen_at.
 */
export function setIssueWatch(
    workspaceId: string,
    owner: string,
    repo: string,
    enabled: boolean,
): void {
    getDb()
        .prepare(
            `INSERT INTO issue_watches (workspace_id, owner, repo, enabled)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(workspace_id, owner, repo) DO UPDATE SET enabled = excluded.enabled`,
        )
        .run(workspaceId, owner, repo, enabled ? 1 : 0);
}

/** Bump seen_at (mark everything currently in the feed as read). */
export function markIssueWatchSeen(
    workspaceId: string,
    owner: string,
    repo: string,
    seenAt: string,
): void {
    getDb()
        .prepare(
            `INSERT INTO issue_watches (workspace_id, owner, repo, enabled, seen_at)
             VALUES (?, ?, ?, 1, ?)
             ON CONFLICT(workspace_id, owner, repo) DO UPDATE SET seen_at = excluded.seen_at`,
        )
        .run(workspaceId, owner, repo, seenAt);
}

// Plugins (Plugin System, Phase 0) --------------------------------------------

/** Where a plugin was installed from. */
export type PluginSourceType = 'repo' | 'folder' | 'marketplace';

/**
 * A plugin's evaluated provenance verdict (Plugin System Phase 3).
 *
 * `outdated` is DISTINCT from `untrusted`: the stored manifest no longer validates
 * against a newer schema (it "needs an update"), which is a very different thing
 * from a signature/tamper `untrusted`. Both are non-surfaceable, but they carry
 * different, accurate user-facing reasons.
 */
export type PluginTrustStatus = 'trusted' | 'unsigned' | 'untrusted' | 'outdated';

/** Coerce a stored trust string to a valid status (fail-closed to 'unsigned'). */
function parseTrustStatus(raw: string | null | undefined): PluginTrustStatus {
    return raw === 'trusted' || raw === 'untrusted' || raw === 'outdated' ? raw : 'unsigned';
}

/**
 * The GRANULAR granted-permission map (§12.1). Each key under a category is an
 * INDEPENDENT grant the user can toggle on/off in Settings → Plugins:
 *   - fs:       scope id (e.g. 'workspace') → granted?
 *   - network:  host        → granted?
 *   - genieApi: api name    → granted?
 * A permission the manifest never declared is simply absent (unreachable).
 */
export interface PluginGrants {
    fs: Record<string, boolean>;
    network: Record<string, boolean>;
    genieApi: Record<string, boolean>;
}

export function emptyPluginGrants(): PluginGrants {
    return { fs: {}, network: {}, genieApi: {} };
}

/** Parse a stored granted_json blob into a well-formed grants object. */
export function parsePluginGrants(raw: string | null | undefined): PluginGrants {
    const out = emptyPluginGrants();
    if (!raw) return out;
    try {
        const j = JSON.parse(raw) as Partial<PluginGrants>;
        for (const cat of ['fs', 'network', 'genieApi'] as const) {
            const src = j[cat];
            if (src && typeof src === 'object') {
                for (const [k, v] of Object.entries(src)) out[cat][k] = v === true;
            }
        }
    } catch {
        /* corrupt → all-denied (fail-closed) */
    }
    return out;
}

export interface PluginRow {
    id: string;
    namespace: string;
    name: string;
    version: string;
    source_type: PluginSourceType;
    source_url: string | null;
    source_ref: string | null;
    install_path: string;
    marketplace_id: string | null;
    enabled: boolean;
    /** The validated manifest snapshot (JSON string, as stored). */
    manifest_json: string;
    grants: PluginGrants;
    integrity: string | null;
    signature: string | null;
    publisher_key_id: string | null;
    /** Last evaluated trust verdict (§12.3 Phase 3). */
    trust: PluginTrustStatus;
    /** User knowingly enabled an UNSIGNED plugin under Developer Mode. */
    dev_approved: boolean;
    installed_at: string;
    updated_at: string;
}

interface PluginRecord {
    id: string;
    namespace: string;
    name: string;
    version: string;
    source_type: string;
    source_url: string | null;
    source_ref: string | null;
    install_path: string;
    marketplace_id: string | null;
    enabled: number;
    manifest_json: string;
    granted_json: string | null;
    integrity: string | null;
    signature: string | null;
    publisher_key_id: string | null;
    trust: string | null;
    dev_approved: number | null;
    installed_at: string;
    updated_at: string;
}

function pluginRowFrom(r: PluginRecord): PluginRow {
    const source_type: PluginSourceType =
        r.source_type === 'folder' ? 'folder' : r.source_type === 'marketplace' ? 'marketplace' : 'repo';
    return {
        id: r.id,
        namespace: r.namespace,
        name: r.name,
        version: r.version,
        source_type,
        source_url: r.source_url,
        source_ref: r.source_ref,
        install_path: r.install_path,
        marketplace_id: r.marketplace_id,
        enabled: r.enabled !== 0,
        manifest_json: r.manifest_json,
        grants: parsePluginGrants(r.granted_json),
        integrity: r.integrity,
        signature: r.signature,
        publisher_key_id: r.publisher_key_id,
        trust: parseTrustStatus(r.trust),
        dev_approved: r.dev_approved === 1,
        installed_at: r.installed_at,
        updated_at: r.updated_at,
    };
}

export function listPlugins(): PluginRow[] {
    return getDb()
        .prepare<[], PluginRecord>('SELECT * FROM plugins ORDER BY name COLLATE NOCASE')
        .all()
        .map(pluginRowFrom);
}

/** Only the ENABLED plugins — the set the MCP registry surfaces (fail-closed). */
export function listEnabledPlugins(): PluginRow[] {
    return getDb()
        .prepare<[], PluginRecord>('SELECT * FROM plugins WHERE enabled = 1 ORDER BY name COLLATE NOCASE')
        .all()
        .map(pluginRowFrom);
}

export function getPlugin(id: string): PluginRow | null {
    const r = getDb()
        .prepare<[string], PluginRecord>('SELECT * FROM plugins WHERE id = ?')
        .get(id);
    return r ? pluginRowFrom(r) : null;
}

export interface UpsertPluginInput {
    id: string;
    namespace: string;
    name: string;
    version: string;
    source_type: PluginSourceType;
    source_url?: string | null;
    source_ref?: string | null;
    install_path: string;
    marketplace_id?: string | null;
    enabled?: boolean;
    manifest_json: string;
    grants?: PluginGrants;
    integrity?: string | null;
    signature?: string | null;
    publisher_key_id?: string | null;
    trust?: PluginTrustStatus;
    dev_approved?: boolean;
}

/** Install (or re-install/update) a plugin row. Idempotent per id. */
export function upsertPlugin(input: UpsertPluginInput): PluginRow {
    const now = new Date().toISOString();
    getDb()
        .prepare(
            `INSERT INTO plugins
               (id, namespace, name, version, source_type, source_url, source_ref, install_path,
                marketplace_id, enabled, manifest_json, granted_json, integrity, signature,
                publisher_key_id, trust, dev_approved, installed_at, updated_at)
             VALUES
               (@id, @namespace, @name, @version, @source_type, @source_url, @source_ref, @install_path,
                @marketplace_id, @enabled, @manifest_json, @granted_json, @integrity, @signature,
                @publisher_key_id, @trust, @dev_approved, @now, @now)
             ON CONFLICT(id) DO UPDATE SET
                namespace        = excluded.namespace,
                name             = excluded.name,
                version          = excluded.version,
                source_type      = excluded.source_type,
                source_url       = excluded.source_url,
                source_ref       = excluded.source_ref,
                install_path     = excluded.install_path,
                marketplace_id   = excluded.marketplace_id,
                enabled          = excluded.enabled,
                manifest_json    = excluded.manifest_json,
                granted_json     = excluded.granted_json,
                integrity        = excluded.integrity,
                signature        = excluded.signature,
                publisher_key_id = excluded.publisher_key_id,
                trust            = excluded.trust,
                dev_approved     = excluded.dev_approved,
                updated_at       = excluded.updated_at`,
        )
        .run({
            id: input.id,
            namespace: input.namespace,
            name: input.name,
            version: input.version,
            source_type: input.source_type,
            source_url: input.source_url ?? null,
            source_ref: input.source_ref ?? null,
            install_path: input.install_path,
            marketplace_id: input.marketplace_id ?? null,
            enabled: input.enabled ? 1 : 0,
            manifest_json: input.manifest_json,
            granted_json: JSON.stringify(input.grants ?? emptyPluginGrants()),
            integrity: input.integrity ?? null,
            signature: input.signature ?? null,
            publisher_key_id: input.publisher_key_id ?? null,
            trust: input.trust ?? 'unsigned',
            dev_approved: input.dev_approved ? 1 : 0,
            now,
        });
    return getPlugin(input.id)!;
}

/** Update a plugin's evaluated trust verdict + dev-approval (Phase 3). */
export function setPluginTrust(
    id: string,
    trust: PluginTrustStatus,
    devApproved: boolean,
): void {
    getDb()
        .prepare('UPDATE plugins SET trust = ?, dev_approved = ?, updated_at = ? WHERE id = ?')
        .run(trust, devApproved ? 1 : 0, new Date().toISOString(), id);
}

/** Flip a plugin's enabled flag (disable = instant fail-closed revoke). */
export function setPluginEnabled(id: string, enabled: boolean): void {
    getDb()
        .prepare('UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?')
        .run(enabled ? 1 : 0, new Date().toISOString(), id);
}

/** Replace a plugin's granular granted-permission map. */
export function setPluginGrants(id: string, grants: PluginGrants): void {
    getDb()
        .prepare('UPDATE plugins SET granted_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(grants), new Date().toISOString(), id);
}

export function deletePlugin(id: string): void {
    getDb().prepare('DELETE FROM plugins WHERE id = ?').run(id);
}

export interface PluginMarketplaceRow {
    id: string;
    name: string;
    url: string;
    ref: string | null;
    official: boolean;
    /** Cached, validated marketplace index (JSON string), or null before a fetch. */
    manifest_json: string | null;
    /** A signed index's detached signature + the trusted key it verifies against. */
    signature: string | null;
    publisher_key_id: string | null;
    added_at: string;
    updated_at: string;
}

interface PluginMarketplaceRecord {
    id: string;
    name: string;
    url: string;
    ref: string | null;
    official: number;
    manifest_json: string | null;
    signature: string | null;
    publisher_key_id: string | null;
    added_at: string;
    updated_at: string;
}

function marketplaceRowFrom(r: PluginMarketplaceRecord): PluginMarketplaceRow {
    return {
        id: r.id,
        name: r.name,
        url: r.url,
        ref: r.ref,
        official: r.official !== 0,
        manifest_json: r.manifest_json,
        signature: r.signature,
        publisher_key_id: r.publisher_key_id,
        added_at: r.added_at,
        updated_at: r.updated_at,
    };
}

export function listPluginMarketplaces(): PluginMarketplaceRow[] {
    return getDb()
        .prepare<[], PluginMarketplaceRecord>('SELECT * FROM plugin_marketplaces ORDER BY official DESC, name COLLATE NOCASE')
        .all()
        .map(marketplaceRowFrom);
}

export function getPluginMarketplace(id: string): PluginMarketplaceRow | null {
    const r = getDb()
        .prepare<[string], PluginMarketplaceRecord>('SELECT * FROM plugin_marketplaces WHERE id = ?')
        .get(id);
    return r ? marketplaceRowFrom(r) : null;
}

export interface UpsertMarketplaceInput {
    id: string;
    name: string;
    url: string;
    ref?: string | null;
    official?: boolean;
    manifest_json?: string | null;
    signature?: string | null;
    publisher_key_id?: string | null;
}

/** Add (or refresh) a marketplace. Idempotent per id. */
export function upsertPluginMarketplace(input: UpsertMarketplaceInput): PluginMarketplaceRow {
    const now = new Date().toISOString();
    getDb()
        .prepare(
            `INSERT INTO plugin_marketplaces (id, name, url, ref, official, manifest_json, signature, publisher_key_id, added_at, updated_at)
             VALUES (@id, @name, @url, @ref, @official, @manifest_json, @signature, @publisher_key_id, @now, @now)
             ON CONFLICT(id) DO UPDATE SET
                name             = excluded.name,
                url              = excluded.url,
                ref              = excluded.ref,
                official         = excluded.official,
                manifest_json    = excluded.manifest_json,
                signature        = excluded.signature,
                publisher_key_id = excluded.publisher_key_id,
                updated_at       = excluded.updated_at`,
        )
        .run({
            id: input.id,
            name: input.name,
            url: input.url,
            ref: input.ref ?? null,
            official: input.official ? 1 : 0,
            manifest_json: input.manifest_json ?? null,
            signature: input.signature ?? null,
            publisher_key_id: input.publisher_key_id ?? null,
            now,
        });
    return getPluginMarketplace(input.id)!;
}

export function deletePluginMarketplace(id: string): void {
    getDb().prepare('DELETE FROM plugin_marketplaces WHERE id = ?').run(id);
}


/* -------------------------------------------------------------------------- */
/* Data kept from an uninstalled GApp (Tynn #250)                              */
/* -------------------------------------------------------------------------- */

/** Remember that an uninstalled app's data was KEPT, and who it belonged to. */
export function retainAppData(appId: string, sourceOrigin: string): void {
    getDb()
        .prepare(
            `INSERT INTO app_retained_data (app_id, source_origin, retained_at)
             VALUES (?, ?, ?)
             ON CONFLICT(app_id) DO UPDATE SET
                source_origin = excluded.source_origin,
                retained_at = excluded.retained_at`,
        )
        .run(appId, sourceOrigin, new Date().toISOString());
}

/** The origin whose data is being held for this app id, if any. */
export function retainedAppData(appId: string): { origin: string } | null {
    const row = getDb()
        .prepare<[string], { source_origin: string } | undefined>(
            'SELECT source_origin FROM app_retained_data WHERE app_id = ?',
        )
        .get(appId);
    return row ? { origin: row.source_origin } : null;
}

/** Forget the retention record — after restoring it, or after wiping it. */
export function forgetRetainedAppData(appId: string): void {
    getDb().prepare('DELETE FROM app_retained_data WHERE app_id = ?').run(appId);
}


