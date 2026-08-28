import Database from 'better-sqlite3';
import { providerSettingDefaults } from './agents/registry';
import type { ProviderSettingKeys } from './agents/registry';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'node:crypto';
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
 * Run all pending append-only migrations against `d`. Exported so the
 * migration suite can exercise the runner against a fresh `:memory:`
 * database without the Electron `app.getPath` singleton path.
 */
export function runMigrations(d: Database.Database): void {
    d.exec(`CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
    )`);
    const row = d
        .prepare<[], { version: number } | undefined>(
            'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1',
        )
        .get();
    const current = row?.version ?? 0;

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
                        ON workspace_agents(workspace_id, provider, name);
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_agents_terminal
                        ON workspace_agents(terminal_spec_id) WHERE terminal_spec_id IS NOT NULL;
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_agents_master
                        ON workspace_agents(workspace_id) WHERE role = 'workspace';
                    CREATE INDEX IF NOT EXISTS idx_workspace_agents_parent
                        ON workspace_agents(parent_agent_id);

                    INSERT OR IGNORE INTO workspace_agents
                        (id, workspace_id, provider, name, purpose, role, reachability,
                         wake_on_dm, created_at, updated_at)
                    SELECT 'workspace:' || id, id, NULL, 'workspace',
                           'Drive this workspace and coordinate its agents.',
                           'workspace', 'workspace', 1,
                           CAST(strftime('%s','now') AS INTEGER) * 1000,
                           CAST(strftime('%s','now') AS INTEGER) * 1000
                    FROM workspaces;

                    INSERT OR IGNORE INTO workspace_agents
                        (id, workspace_id, provider, name, purpose, boot_cwd,
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
        if (m.version > current) apply(m);
    }
}

function workspaceColumns(d: Database.Database): Set<string> {
    const rows = d
        .prepare<[], { name: string }>(`PRAGMA table_info(workspaces)`)
        .all();
    return new Set(rows.map((r) => r.name));
}

/** Column-name set for an arbitrary table (idempotent-ALTER guards). */
function tableColumns(d: Database.Database, table: string): Set<string> {
    const rows = d
        .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
        .all();
    return new Set(rows.map((r) => r.name));
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
export function ensureWorkspaceAgent(
    database: Database.Database,
    workspaceId: string,
    now = Date.now(),
): void {
    database
        .prepare(
            `INSERT OR IGNORE INTO workspace_agents
                (id, workspace_id, provider, name, purpose, role, reachability,
                 wake_on_dm, created_at, updated_at)
             VALUES (?, ?, NULL, 'workspace',
                     'Drive this workspace and coordinate its agents.',
                     'workspace', 'workspace', 1, ?, ?)`,
        )
        .run(`workspace:${workspaceId}`, workspaceId, now, now);
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
        // Every provider's command + flags, defaulted from PROVIDER_REGISTRY
        // (genie#261) with the stored value winning where one exists.
        ...Object.fromEntries(
            Object.entries(providerSettingDefaults()).map(([k, fallback]) => [
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
export interface WorkspaceAgentRow {
    id: string;
    workspace_id: string;
    provider: string | null;
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

export function listWorkspaces(): WorkspaceRow[] {
    return getDb()
        .prepare<[], WorkspaceRow>(
            `SELECT * FROM workspaces
             ORDER BY sort_order ASC, (last_opened_at IS NULL) ASC, last_opened_at DESC, project_name ASC`,
        )
        .all();
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

export function getWorkspaceAgent(
    workspaceId: string,
    provider: string,
    name: string,
): WorkspaceAgentRow | undefined {
    return getDb()
        .prepare<[string, string, string], WorkspaceAgentRow>(
            `SELECT *, COALESCE(native_transport, transport) AS transport FROM workspace_agents
             WHERE workspace_id = ? AND provider = ? AND name = ?`,
        )
        .get(workspaceId, provider, name);
}

export function createWorkspaceAgent(
    row: Omit<WorkspaceAgentRow, 'created_at' | 'updated_at' | 'ready_at' | 'terminal_spec_id' | 'transport' | 'transport_verified_at' | 'transport_error'> & {
        ready_at?: number | null;
        terminal_spec_id?: string | null;
    },
): WorkspaceAgentRow {
    const now = Date.now();
    getDb()
        .prepare(
            `INSERT INTO workspace_agents
                (id, workspace_id, provider, name, purpose, avatar, boot_cwd,
                 persona_path, role, parent_agent_id, terminal_spec_id,
                 reachability, wake_on_dm, ready_at, created_at, updated_at)
             VALUES (@id, @workspace_id, @provider, @name, @purpose, @avatar, @boot_cwd,
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
    database
        .prepare(
            `UPDATE workspace_agents
             SET terminal_spec_id = ?, ready_at = NULL,
                 transport_verified_at = NULL, transport_error = NULL,
                 updated_at = ?
             WHERE id = ?`,
        )
        .run(terminalSpecId, Date.now(), agentId);
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
    getDb()
        .prepare(`DELETE FROM workspace_agents WHERE id = ? AND role <> 'workspace'`)
        .run(agentId);
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
    > & {
        sort_order?: number;
        mcp_enabled?: number;
        process_approval?: number;
        terminal_approval?: number;
        schedule_approval?: number;
        assignment_managed?: number;
        agent_access?: WorkspaceAgentAccess;
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
    };
    const database = getDb();
    const insert = database.transaction(() => {
        database.prepare(
            `INSERT INTO workspaces
             (id, backend, project_id, project_name, tynn_project_id, tynn_project_name, shape, path, editor, editor_cmd, start_cmd, env_file, last_opened_at, created_by_genie, sort_order, mcp_enabled, assignment_managed)
             VALUES (@id, @backend, @project_id, @project_name, @tynn_project_id, @tynn_project_name, @shape, @path, @editor, @editor_cmd, @start_cmd, @env_file, @last_opened_at, @created_by_genie, @sort_order, @mcp_enabled, @assignment_managed)`,
        )
        .run(full);
        ensureWorkspaceAgent(database, row.id);
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
                created_by_genie  = @created_by_genie
             WHERE id = @id`,
        )
        .run(next);
    return getWorkspace(id);
}

export function removeWorkspace(id: string): void {
    getDb().prepare('DELETE FROM workspaces WHERE id = ?').run(id);
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
export type TerminalSpecType = 'terminal' | 'code' | 'process' | 'plugin';

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
     * System Workspace tag: the spec belongs to the synthetic System Workspace
     * (which has no `workspaces` row), so it persists with `workspace_id: null`
     * + `system: true` and is grouped under the System Workspace in the UI.
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
    agent?: 'claude' | 'codex' | 'kiwi' | 'genie' | 'custom';
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


