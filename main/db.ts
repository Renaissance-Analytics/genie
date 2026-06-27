import { app } from 'electron';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

/**
 * Local SQLite store. Two tables:
 *   - `workspaces` — one row per registered project (Story #152)
 *   - `settings`  — k/v for Settings window state (Story #151)
 *
 * Schema migrations are append-only. Read `schema_version` on boot, run any
 * pending migrations in order, write the new version. Never rewrite history.
 */

let db: Database.Database | null = null;

export function initDatabase(): Database.Database {
    if (db) return db;

    const dir = app.getPath('userData');
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
    default_editor?: string;
    default_editor_cmd?: string;
    default_start_cmd?: string;
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
    /** Per-workspace draggable-grid track sizes, JSON-encoded. Keyed by `${workspaceId}:${signature}`. */
    layout_json?: string;
    /** Inject a per-shell OSC-7 prompt hook so resumed terminals start in the
     *  right cwd. 'off' disables it; anything else (incl. unset) is ON. */
    track_cwd?: 'on' | 'off';
    /** Tier 3: keep terminals running in a detached pty-host so they survive a
     *  full quit of the app. Defaults ON — an unset value resolves to 'on' so
     *  terminals AND the agents running in them survive a Genie restart
     *  everywhere; an explicit 'off' opts back into the in-process T1/T2 backend
     *  (which restores panels from a snapshot but cold-spawns a fresh shell). */
    detached_terminals?: 'on' | 'off';
    /** Prepend the bundled tynn-cli bin to terminal PATH + inject GENIE_* env.
     *  'off' disables it; anything else (incl. unset) is ON. */
    cli_tools_in_terminals?: 'on' | 'off';
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
    /** Mobile remote-control server (Settings → Mobile). Opt-in: 'off' (default)
     *  binds nothing; 'on' binds the Tailscale-only HTTP/WS server. */
    mobile_enabled?: 'on' | 'off';
    /** Fixed port for the mobile server, bound on the Tailscale IP. String-
     *  encoded; default '51718' (obscure, beside the MCP port). Same Integer/
     *  range guard as mcp_port. Changing it requires restarting the server. */
    mobile_port?: string;
    /** Keep the Genie endpoint synced into a workspace's Claude `.mcp.json`.
     *  Default 'on'; 'off' means Genie never touches that file (manual edits
     *  stick). */
    mcp_sync_claude?: 'on' | 'off';
    /** Keep the Genie endpoint synced into a workspace's Cursor
     *  `.cursor/mcp.json`. Default 'on'; 'off' leaves it alone. */
    mcp_sync_cursor?: 'on' | 'off';
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
    /** How agents should act on IssueWatch pings — the open Issues / PRs /
     *  security alerts surfaced via the `checkIssues` tool and the `imDone`
     *  `sec:` count. Surfaced to agents on the imDone count line so it actually
     *  steers behaviour:
     *    - 'surface' (default): just report the counts; wait for direction.
     *    - 'fix': fix the ROOT CAUSE when no other work is in progress, then
     *      report before shipping.
     *    - 'fix-and-ship': fix the root cause AND ship right away when no other
     *      work is in progress. */
    agent_issuewatch_policy?: 'surface' | 'fix' | 'fix-and-ship';
}

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
        default_editor: out['default_editor'] ?? 'cursor',
        default_editor_cmd: out['default_editor_cmd'],
        default_start_cmd: out['default_start_cmd'] ?? 'npm run dev',
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
        track_cwd: (out['track_cwd'] as 'on' | 'off') ?? 'on',
        detached_terminals: (out['detached_terminals'] as 'on' | 'off') ?? 'on',
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
        mobile_port: out['mobile_port'] ?? '51718',
        mcp_sync_claude: (out['mcp_sync_claude'] as 'on' | 'off') ?? 'on',
        mcp_sync_cursor: (out['mcp_sync_cursor'] as 'on' | 'off') ?? 'on',
        mcp_sync_agents: (out['mcp_sync_agents'] as 'on' | 'off') ?? 'on',
        ops_auto_provision_workspaces:
            (out['ops_auto_provision_workspaces'] as 'on' | 'off') ?? 'off',
        terminal_copy_paste:
            (out['terminal_copy_paste'] as 'contextmenu' | 'linux' | 'winmac') ?? 'contextmenu',
        collapsed_workspaces: out['collapsed_workspaces'] ?? '[]',
        agent_command_claude: out['agent_command_claude'] ?? 'claude',
        agent_command_codex: out['agent_command_codex'] ?? 'codex',
        agent_command_custom: out['agent_command_custom'] ?? '',
        agent_issuewatch_policy:
            (out['agent_issuewatch_policy'] as Settings['agent_issuewatch_policy']) ??
            'surface',
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
}

export function listWorkspaces(): WorkspaceRow[] {
    return getDb()
        .prepare<[], WorkspaceRow>(
            `SELECT * FROM workspaces
             ORDER BY sort_order ASC, (last_opened_at IS NULL) ASC, last_opened_at DESC, project_name ASC`,
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

export function addWorkspace(
    row: Omit<
        WorkspaceRow,
        'sort_order' | 'mcp_enabled' | 'process_approval' | 'terminal_approval'
    > & {
        sort_order?: number;
        mcp_enabled?: number;
        process_approval?: number;
        terminal_approval?: number;
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
    };
    getDb()
        .prepare(
            `INSERT INTO workspaces
             (id, backend, project_id, project_name, tynn_project_id, tynn_project_name, shape, path, editor, editor_cmd, start_cmd, env_file, last_opened_at, created_by_genie, sort_order, mcp_enabled)
             VALUES (@id, @backend, @project_id, @project_name, @tynn_project_id, @tynn_project_name, @shape, @path, @editor, @editor_cmd, @start_cmd, @env_file, @last_opened_at, @created_by_genie, @sort_order, @mcp_enabled)`,
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
export type TerminalSpecType = 'terminal' | 'code' | 'process';

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
     * System Workspace tag: the spec belongs to the synthetic System Workspace
     * (which has no `workspaces` row), so it persists with `workspace_id: null`
     * + `system: true` and is grouped under the System Workspace in the UI.
     */
    system?: boolean;
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
        r.type === 'code' ? 'code' : r.type === 'process' ? 'process' : 'terminal';
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
