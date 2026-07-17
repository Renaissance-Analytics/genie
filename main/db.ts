import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import {
    parseTunnelSites,
    sanitizeTunnelPatch,
    type TunnelSites,
    type TunnelSiteConfig,
} from './mobile/hosts';

/**
 * Local SQLite store. Two tables:
 *   - `workspaces` — one row per registered project (Story #152)
 *   - `settings`  — k/v for Settings window state (Story #151)
 *
 * Schema migrations are append-only. Read `schema_version` on boot, run any
 * pending migrations in order, write the new version. Never rewrite history.
 */

let db: Database.Database | null = null;

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
            // v19: per-workspace LOCAL-SITE TUNNEL settings (serve-local-sites
            // Phase B). A JSON blob mapping an opaque per-site id → its tunnel
            // config: { [siteId]: { enabled, genName, scheme, port } }. This IS
            // the §5 allowlist — nothing is tunnelled until a site's `enabled` is
            // set true; discovery + probing (the hosts-file scheme/port) supply
            // the rest. NULL/absent reads as {} (nothing enabled), so existing
            // workspaces gain the column with the safe default. Stored as TEXT
            // JSON (one structured setting), resolved by getWorkspaceTunnelSites —
            // never parsed here. Mirrors the issuewatch_granularity pattern.
            // Idempotent ADD COLUMN.
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
            // v23 — WhisperChat durable inbox. Messages were in-memory only (lost on
            // restart, silently dropped past the 200 cap). Persist every message +
            // a per-agent ACK cursor so a queued whisper survives a restart, the
            // human panel keeps its history, and unACKed-urgent escalation (Track C)
            // has a durable position to check. `seq` is the broker's monotonic global
            // sequence (resumed from MAX(seq) on boot so cursors stay valid).
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

// Settings helpers ------------------------------------------------------

export interface Settings {
    primary_workspace?: string;
    /** Last-activated workspace id in the master view; seeds the active workspace on launch. */
    active_workspace?: string;
    default_env_file?: string;
    global_hotkey?: string;
    tynn_host?: string;
    notifications_muted?: string; // JSON-encoded array of category keys
    auto_update?: 'on' | 'off';
    /** Default shell id ('git-bash' | 'pwsh' | … | 'custom'). Empty = auto-detect. */
    terminal_shell?: string;
    /** Manual executable line, used when terminal_shell === 'custom'. */
    terminal_custom_cmd?: string;
    /** Max panels visible at once per workspace. String-encoded (settings are k/v text). Default '4'. */
    max_views?: string;
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
    /** Fixed port for the mobile server, bound on the Tailscale IP. String-
     *  encoded; default '51718' (obscure, beside the MCP port). Same Integer/
     *  range guard as mcp_port. Changing it requires restarting the server. */
    mobile_port?: string;
    /** Serve-local-sites master switch (serve-local-sites Phase B). Opt-in:
     *  'off' (default) discovers/serves nothing; 'on' allows the host to expose
     *  its loopback dev sites over Work Mode. DISTINCT from mobile_enabled /
     *  Work-Mode host enable — exposing your dev environment is a separate,
     *  deliberate decision. Per-repo `.gen` enables (tunnel_sites) are the
     *  second opt-in on top of this. */
    local_sites_enabled?: 'on' | 'off';
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
    /** The CLI invocation the runAgent MCP tool launches for a `claude` agent.
     *  Default 'claude'. The user can set the real command (e.g. a wrapper or a
     *  full path with flags). */
    agent_command_claude?: string;
    /** The CLI invocation the runAgent MCP tool launches for a `codex` agent.
     *  Default 'codex'. */
    agent_command_codex?: string;
    /** The CLI invocation the runAgent MCP tool launches for a `custom` agent.
     *  No default — the agent must pass an explicit `command`, or this is used
     *  when set. Empty means "no preset; require an explicit command". */
    agent_command_custom?: string;
    /** ALWAYS-ON launch flags appended to a `claude` agent's command when a
     *  specialized terminal (or runAgent) opens it — e.g.
     *  `--dangerously-skip-permissions`. Appended AFTER the resolved command and
     *  BEFORE the session-id flag: `<command> <flags> --session-id <uuid>`.
     *  Default '' (no extra flags). */
    agent_flags_claude?: string;
    /** Always-on launch flags appended to a `codex` agent's command. Default ''. */
    agent_flags_codex?: string;
    /** Always-on launch flags appended to a `custom` agent's command. Default ''. */
    agent_flags_custom?: string;
    /** Plugin System Developer Mode. When 'on', the user may install/enable
     *  UNSIGNED plugins (with escalated consent + restricted runtime) and manage
     *  developer-trusted signing keys. Default 'off' — the signed registry is the
     *  production path (§12.3). */
    plugins_developer_mode?: 'on' | 'off';
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
        tynn_host: out['tynn_host'] ?? 'https://tynn.ai',
        notifications_muted: out['notifications_muted'] ?? '[]',
        auto_update: (out['auto_update'] as 'on' | 'off') ?? 'on',
        terminal_shell: out['terminal_shell'] ?? '',
        terminal_custom_cmd: out['terminal_custom_cmd'] ?? '',
        max_views: out['max_views'] ?? '4',
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
        mobile_port: out['mobile_port'] ?? '51718',
        local_sites_enabled:
            (out['local_sites_enabled'] as 'on' | 'off') ?? 'off',
        mcp_sync_claude: (out['mcp_sync_claude'] as 'on' | 'off') ?? 'on',
        mcp_sync_cursor: (out['mcp_sync_cursor'] as 'on' | 'off') ?? 'on',
        mcp_sync_codex: (out['mcp_sync_codex'] as 'on' | 'off') ?? 'on',
        mcp_sync_agents: (out['mcp_sync_agents'] as 'on' | 'off') ?? 'on',
        ops_auto_provision_workspaces:
            (out['ops_auto_provision_workspaces'] as 'on' | 'off') ?? 'off',
        terminal_copy_paste:
            (out['terminal_copy_paste'] as 'contextmenu' | 'linux' | 'winmac') ?? 'contextmenu',
        ai_system: out['ai_system'] ?? '',
        collapsed_workspaces: out['collapsed_workspaces'] ?? '[]',
        agent_command_claude: out['agent_command_claude'] ?? 'claude',
        agent_command_codex: out['agent_command_codex'] ?? 'codex',
        agent_command_custom: out['agent_command_custom'] ?? '',
        agent_flags_claude: out['agent_flags_claude'] ?? '',
        agent_flags_codex: out['agent_flags_codex'] ?? '',
        agent_flags_custom: out['agent_flags_custom'] ?? '',
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
    /** Per-workspace LOCAL-SITE tunnel settings (serve-local-sites Phase B),
     *  JSON-encoded ({ [siteId]: { enabled, genName, scheme, port } }). This IS
     *  the §5 allowlist. NULL/absent reads as {} (nothing enabled) — resolve it
     *  via {@link getWorkspaceTunnelSites}, never parse here. */
    tunnel_sites?: string | null;
}

export function listWorkspaces(): WorkspaceRow[] {
    return getDb()
        .prepare<[], WorkspaceRow>(
            `SELECT * FROM workspaces
             ORDER BY sort_order ASC, (last_opened_at IS NULL) ASC, last_opened_at DESC, project_name ASC`,
        )
        .all();
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
        | 'assignment_managed'
    > & {
        sort_order?: number;
        mcp_enabled?: number;
        process_approval?: number;
        terminal_approval?: number;
        assignment_managed?: number;
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
    getDb()
        .prepare(
            `INSERT INTO workspaces
             (id, backend, project_id, project_name, tynn_project_id, tynn_project_name, shape, path, editor, editor_cmd, start_cmd, env_file, last_opened_at, created_by_genie, sort_order, mcp_enabled, assignment_managed)
             VALUES (@id, @backend, @project_id, @project_name, @tynn_project_id, @tynn_project_name, @shape, @path, @editor, @editor_cmd, @start_cmd, @env_file, @last_opened_at, @created_by_genie, @sort_order, @mcp_enabled, @assignment_managed)`,
        )
        .run(full);
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

// Local-site tunnel settings (serve-local-sites Phase B) ----------------
//
// The §5 per-repo ALLOWLIST, stored per-workspace as a JSON blob keyed by the
// opaque siteId (mirrors the issuewatch_granularity single-column pattern).
// Nothing is tunnelled until a site's `enabled` is set true. Re-exported types
// live in main/mobile/hosts.ts (the feature module); the parse/sanitize helpers
// are pure so a corrupt blob or hostile patch can't poison the store.

/** This workspace's stored per-site tunnel settings (NULL/absent ⇒ {} = nothing
 *  enabled). Keyed by the opaque siteId (see main/mobile/hosts.ts). */
export function getWorkspaceTunnelSites(id: string): TunnelSites {
    const row = getDb()
        .prepare<[string], { tunnel_sites: string | null } | undefined>(
            'SELECT tunnel_sites FROM workspaces WHERE id = ?',
        )
        .get(id);
    return parseTunnelSites(row?.tunnel_sites ?? null);
}

/** Replace this workspace's whole tunnel-settings map (JSON-encoded). */
export function setWorkspaceTunnelSites(id: string, sites: TunnelSites): void {
    getDb()
        .prepare('UPDATE workspaces SET tunnel_sites = ? WHERE id = ?')
        .run(JSON.stringify(sites), id);
}

/** Merge ONE site's tunnel config into this workspace's map (the write behind
 *  the workspace-settings toggles). The patch is sanitized before it lands. */
export function setWorkspaceTunnelSite(
    id: string,
    siteId: string,
    patch: TunnelSiteConfig,
): void {
    const current = getWorkspaceTunnelSites(id);
    const merged = { ...(current[siteId] ?? {}), ...sanitizeTunnelPatch(patch) };
    setWorkspaceTunnelSites(id, { ...current, [siteId]: merged });
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
    /** Agent terminals (runAgent / specialized): which AI TUI this runs. */
    agent?: 'claude' | 'codex' | 'custom';
    /** Agent terminals: the CLI command line that was launched (display). */
    agent_command?: string;
    /**
     * WhisperChat identity + accessibility (Specialized Terminals). These ride
     * the spec's meta so an agent's whisper registration is durable across a
     * restart (the in-memory broker rehydrates from them) — NO migration.
     */
    /** Stable whisper identity (uuid). Present ⇒ this terminal is a whisper agent. */
    agent_id?: string;
    /** Channel purpose (kebab). Default `general`. */
    whisper_purpose?: string;
    /** Accessibility scope — who can see/DM this agent. Default `self`. */
    whisper_scope?: 'none' | 'self' | 'specific' | 'all';
    /** Workspace ids this agent is visible to when `whisper_scope: 'specific'`. */
    whisper_workspaces?: string[];
    /** Opt-in wake-on-DM (issue #9): a DM to an idle agent may inject a nudge to
     *  start a turn. Default off/absent. */
    whisper_wake_on_dm?: boolean;
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

/** A plugin's evaluated provenance verdict (Plugin System Phase 3). */
export type PluginTrustStatus = 'trusted' | 'unsigned' | 'untrusted';

/** Coerce a stored trust string to a valid status (fail-closed to 'unsigned'). */
function parseTrustStatus(raw: string | null | undefined): PluginTrustStatus {
    return raw === 'trusted' || raw === 'untrusted' ? raw : 'unsigned';
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
