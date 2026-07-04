import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
    runMigrations,
    parseGranularity,
    DEFAULT_ISSUEWATCH_GRANULARITY,
    parsePolicyBuckets,
} from '../db';

/**
 * Schema migrations are exercised against a real in-memory better-sqlite3
 * (the binary is NOT mocked — see vitest.config.ts). The v4 migration adds
 * `type`/`meta_json` to `terminal_specs` as idempotent ADD COLUMNs; the key
 * guarantee is that a row written under the v3 schema reads back with the
 * v4 defaults (`type='terminal'`, `meta={}`) without a rewrite.
 */

function cols(db: Database.Database, table: string): Set<string> {
    return new Set(
        db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
            .all()
            .map((r) => r.name),
    );
}

describe('db migration v4 (typed view specs)', () => {
    it('adds type + meta_json columns to terminal_specs', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        const c = cols(db, 'terminal_specs');
        expect(c.has('type')).toBe(true);
        expect(c.has('meta_json')).toBe(true);
    });

    it('a pre-existing (v3-shaped) spec row reads back type=terminal, meta={}', () => {
        const db = new Database(':memory:');
        runMigrations(db);

        // Insert with ONLY the v3 columns — the v4 columns must fall back to
        // their declared defaults, exactly as a row migrated from v3 would.
        db.prepare(
            `INSERT INTO terminal_specs
               (id, workspace_id, label, cwd, shell, args_json, env_json, sort_order, created_at)
             VALUES (@id, NULL, @label, @cwd, NULL, '[]', '{}', 0, @now)`,
        ).run({ id: 'spec-legacy', label: 'legacy', cwd: '/tmp', now: new Date().toISOString() });

        const row = db
            .prepare<[string], { type: string; meta_json: string }>(
                'SELECT type, meta_json FROM terminal_specs WHERE id = ?',
            )
            .get('spec-legacy');

        expect(row?.type).toBe('terminal');
        expect(row?.meta_json).toBe('{}');
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        // Second run is a no-op: schema_version already past v4, so the
        // migration list is skipped entirely. Must not throw.
        expect(() => runMigrations(db)).not.toThrow();
        const c = cols(db, 'terminal_specs');
        expect(c.has('type')).toBe(true);
        expect(c.has('meta_json')).toBe(true);
    });

    it('round-trips a code view spec with file_path meta', () => {
        const db = new Database(':memory:');
        runMigrations(db);

        db.prepare(
            `INSERT INTO terminal_specs
               (id, workspace_id, label, cwd, shell, args_json, env_json, type, meta_json, sort_order, created_at)
             VALUES (@id, NULL, @label, @cwd, NULL, '[]', '{}', 'code', @meta, 0, @now)`,
        ).run({
            id: 'spec-code',
            label: 'app-code',
            cwd: '/tmp',
            meta: JSON.stringify({ file_path: 'src/index.ts' }),
            now: new Date().toISOString(),
        });

        const row = db
            .prepare<[string], { type: string; meta_json: string }>(
                'SELECT type, meta_json FROM terminal_specs WHERE id = ?',
            )
            .get('spec-code');

        expect(row?.type).toBe('code');
        expect(JSON.parse(row!.meta_json)).toEqual({ file_path: 'src/index.ts' });
    });
});

describe('db migration v5 (session-persistence pointers)', () => {
    it('adds snapshot_at + snapshot_bytes + live_cwd columns', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        const c = cols(db, 'terminal_specs');
        expect(c.has('snapshot_at')).toBe(true);
        expect(c.has('snapshot_bytes')).toBe(true);
        expect(c.has('live_cwd')).toBe(true);
    });

    it('a pre-existing spec row reads back NULL for all three pointer columns', () => {
        const db = new Database(':memory:');
        runMigrations(db);

        // Insert with only the pre-v5 columns — the v5 columns must be NULL,
        // exactly as a row migrated up from v3/v4 would be.
        db.prepare(
            `INSERT INTO terminal_specs
               (id, workspace_id, label, cwd, shell, args_json, env_json, type, meta_json, sort_order, created_at)
             VALUES (@id, NULL, @label, @cwd, NULL, '[]', '{}', 'terminal', '{}', 0, @now)`,
        ).run({ id: 'spec-pre-v5', label: 'pre', cwd: '/tmp', now: new Date().toISOString() });

        const row = db
            .prepare<
                [string],
                {
                    snapshot_at: number | null;
                    snapshot_bytes: number | null;
                    live_cwd: string | null;
                }
            >(
                'SELECT snapshot_at, snapshot_bytes, live_cwd FROM terminal_specs WHERE id = ?',
            )
            .get('spec-pre-v5');

        expect(row?.snapshot_at).toBeNull();
        expect(row?.snapshot_bytes).toBeNull();
        expect(row?.live_cwd).toBeNull();
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        const c = cols(db, 'terminal_specs');
        expect(c.has('snapshot_at')).toBe(true);
        expect(c.has('live_cwd')).toBe(true);
    });

    it('persists snapshot/cwd pointers on a spec row', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        db.prepare(
            `INSERT INTO terminal_specs
               (id, workspace_id, label, cwd, shell, args_json, env_json, type, meta_json, sort_order, created_at)
             VALUES ('s1', NULL, 'l', '/tmp', NULL, '[]', '{}', 'terminal', '{}', 0, @now)`,
        ).run({ now: new Date().toISOString() });

        db.prepare(
            `UPDATE terminal_specs SET snapshot_at = ?, snapshot_bytes = ?, live_cwd = ? WHERE id = 's1'`,
        ).run(1234567890, 4096, 'C:\\work\\proj');

        const row = db
            .prepare<
                [],
                { snapshot_at: number; snapshot_bytes: number; live_cwd: string }
            >(
                'SELECT snapshot_at, snapshot_bytes, live_cwd FROM terminal_specs WHERE id = \'s1\'',
            )
            .get();
        expect(row?.snapshot_at).toBe(1234567890);
        expect(row?.snapshot_bytes).toBe(4096);
        expect(row?.live_cwd).toBe('C:\\work\\proj');
    });
});

describe('db migration v6 (Tier 2 enabled column)', () => {
    it('adds the enabled column to terminal_specs', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(cols(db, 'terminal_specs').has('enabled')).toBe(true);
    });

    it('a pre-existing (pre-v6) spec row defaults to enabled=1', () => {
        const db = new Database(':memory:');
        runMigrations(db);

        // Insert with only the pre-v6 columns — `enabled` must fall back to its
        // declared DEFAULT 1, exactly as a row migrated up from an older DB.
        db.prepare(
            `INSERT INTO terminal_specs
               (id, workspace_id, label, cwd, shell, args_json, env_json, type, meta_json, sort_order, created_at)
             VALUES (@id, NULL, @label, @cwd, NULL, '[]', '{}', 'terminal', '{}', 0, @now)`,
        ).run({ id: 'spec-pre-v6', label: 'pre', cwd: '/tmp', now: new Date().toISOString() });

        const row = db
            .prepare<[string], { enabled: number }>(
                'SELECT enabled FROM terminal_specs WHERE id = ?',
            )
            .get('spec-pre-v6');
        expect(row?.enabled).toBe(1);
    });

    it('round-trips a disabled (enabled=0) spec row', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        db.prepare(
            `INSERT INTO terminal_specs
               (id, workspace_id, label, cwd, shell, args_json, env_json, type, meta_json, sort_order, created_at, enabled)
             VALUES ('s-dis', NULL, 'l', '/tmp', NULL, '[]', '{}', 'terminal', '{}', 0, @now, 0)`,
        ).run({ now: new Date().toISOString() });

        const row = db
            .prepare<[], { enabled: number }>(
                "SELECT enabled FROM terminal_specs WHERE id = 's-dis'",
            )
            .get();
        expect(row?.enabled).toBe(0);
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'terminal_specs').has('enabled')).toBe(true);
    });
});

describe('db migration v7 (Tier 3 host_session_id)', () => {
    it('adds the host_session_id column to terminal_specs', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(cols(db, 'terminal_specs').has('host_session_id')).toBe(true);
    });

    it('a pre-existing (pre-v7) spec row reads back NULL for host_session_id', () => {
        const db = new Database(':memory:');
        runMigrations(db);

        db.prepare(
            `INSERT INTO terminal_specs
               (id, workspace_id, label, cwd, shell, args_json, env_json, type, meta_json, sort_order, created_at)
             VALUES (@id, NULL, @label, @cwd, NULL, '[]', '{}', 'terminal', '{}', 0, @now)`,
        ).run({ id: 'spec-pre-v7', label: 'pre', cwd: '/tmp', now: new Date().toISOString() });

        const row = db
            .prepare<[string], { host_session_id: string | null }>(
                'SELECT host_session_id FROM terminal_specs WHERE id = ?',
            )
            .get('spec-pre-v7');
        expect(row?.host_session_id).toBeNull();
    });

    it('round-trips a host_session_id on a spec row', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        db.prepare(
            `INSERT INTO terminal_specs
               (id, workspace_id, label, cwd, shell, args_json, env_json, type, meta_json, sort_order, created_at, host_session_id)
             VALUES ('s-host', NULL, 'l', '/tmp', NULL, '[]', '{}', 'terminal', '{}', 0, @now, 'host-pty-7')`,
        ).run({ now: new Date().toISOString() });

        const row = db
            .prepare<[], { host_session_id: string }>(
                "SELECT host_session_id FROM terminal_specs WHERE id = 's-host'",
            )
            .get();
        expect(row?.host_session_id).toBe('host-pty-7');
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'terminal_specs').has('host_session_id')).toBe(true);
    });
});

describe('db migration v8 (workspace sort_order)', () => {
    /** Insert a workspace populating only the v1-required NOT NULL columns. */
    const insertWs = (
        db: Database.Database,
        id: string,
        name: string,
        extra: Record<string, unknown> = {},
    ) =>
        db.prepare(
            `INSERT INTO workspaces
               (id, backend, project_id, project_name, tynn_project_id, tynn_project_name, shape, path, last_opened_at, created_by_genie${
                   'sort_order' in extra ? ', sort_order' : ''
               })
             VALUES (@id, 'tynn', @pid, @name, @pid, @name, 'simple', @path, @opened, 0${
                 'sort_order' in extra ? ', @sort_order' : ''
             })`,
        ).run({
            id,
            pid: `p-${id}`,
            name,
            path: `/tmp/${id}`,
            opened: (extra.opened as string) ?? null,
            sort_order: extra.sort_order,
        });

    it('adds the sort_order column to workspaces', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(cols(db, 'workspaces').has('sort_order')).toBe(true);
    });

    it('a pre-existing (pre-v8) workspace row defaults to sort_order=0', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        insertWs(db, 'ws-pre-v8', 'pre');
        const row = db
            .prepare<[string], { sort_order: number }>(
                'SELECT sort_order FROM workspaces WHERE id = ?',
            )
            .get('ws-pre-v8');
        expect(row?.sort_order).toBe(0);
    });

    it('sort_order takes precedence over last_opened_at in the list ordering', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        // 'a' opened most recently but ordered last; 'c' ordered first.
        insertWs(db, 'a', 'A', { sort_order: 2, opened: '2026-01-03T00:00:00Z' });
        insertWs(db, 'b', 'B', { sort_order: 1, opened: '2026-01-02T00:00:00Z' });
        insertWs(db, 'c', 'C', { sort_order: 0, opened: '2026-01-01T00:00:00Z' });

        const ids = db
            .prepare<[], { id: string }>(
                `SELECT id FROM workspaces
                 ORDER BY sort_order ASC, (last_opened_at IS NULL) ASC, last_opened_at DESC, project_name ASC`,
            )
            .all()
            .map((r) => r.id);
        expect(ids).toEqual(['c', 'b', 'a']);
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'workspaces').has('sort_order')).toBe(true);
    });
});

describe('db migration v9 (per-workspace MCP toggle)', () => {
    it('adds the mcp_enabled column to workspaces', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(cols(db, 'workspaces').has('mcp_enabled')).toBe(true);
    });

    // The COLUMN default is still 0; the product default-on is applied by
    // addWorkspace (new rows) + the v11 backfill (existing rows). This asserts
    // the raw column behaviour, which v11 doesn't change (it ran on the empty
    // table before this insert).
    it('a raw workspace row uses the column default mcp_enabled=0', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        db.prepare(
            `INSERT INTO workspaces
               (id, backend, project_id, project_name, tynn_project_id, tynn_project_name, shape, path, last_opened_at, created_by_genie)
             VALUES ('w-mcp', 'tynn', 'p', 'P', 'p', 'P', 'simple', '/tmp/p', NULL, 0)`,
        ).run();
        const row = db
            .prepare<[string], { mcp_enabled: number }>(
                'SELECT mcp_enabled FROM workspaces WHERE id = ?',
            )
            .get('w-mcp');
        expect(row?.mcp_enabled).toBe(0);
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'workspaces').has('mcp_enabled')).toBe(true);
    });
});

describe('db migration v13 (per-workspace process-approval gate)', () => {
    it('adds the process_approval column to workspaces', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(cols(db, 'workspaces').has('process_approval')).toBe(true);
    });

    // The safe default is require-approval (1): an agent must NOT be able to
    // silently spawn a process. A raw insert that omits the column gets it.
    it('a raw workspace row defaults to process_approval=1 (require approval)', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        db.prepare(
            `INSERT INTO workspaces
               (id, backend, project_id, project_name, tynn_project_id, tynn_project_name, shape, path, last_opened_at, created_by_genie)
             VALUES ('w-pa', 'tynn', 'p', 'P', 'p', 'P', 'simple', '/tmp/pa', NULL, 0)`,
        ).run();
        const row = db
            .prepare<[string], { process_approval: number }>(
                'SELECT process_approval FROM workspaces WHERE id = ?',
            )
            .get('w-pa');
        expect(row?.process_approval).toBe(1);
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'workspaces').has('process_approval')).toBe(true);
    });
});

describe('db migration v14 (per-workspace terminal/agent-approval gate)', () => {
    it('adds the terminal_approval column to workspaces', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(cols(db, 'workspaces').has('terminal_approval')).toBe(true);
    });

    // The safe default is require-approval (1): an agent must NOT be able to
    // silently spawn a terminal / run code / launch a sub-agent.
    it('a raw workspace row defaults to terminal_approval=1 (require approval)', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        db.prepare(
            `INSERT INTO workspaces
               (id, backend, project_id, project_name, tynn_project_id, tynn_project_name, shape, path, last_opened_at, created_by_genie)
             VALUES ('w-ta', 'tynn', 'p', 'P', 'p', 'P', 'simple', '/tmp/ta', NULL, 0)`,
        ).run();
        const row = db
            .prepare<[string], { terminal_approval: number }>(
                'SELECT terminal_approval FROM workspaces WHERE id = ?',
            )
            .get('w-ta');
        expect(row?.terminal_approval).toBe(1);
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'workspaces').has('terminal_approval')).toBe(true);
    });
});

describe('db migration v16 (fork→upstream cache)', () => {
    it('creates the fork_upstream table with its columns', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        const c = cols(db, 'fork_upstream');
        expect(c.has('owner')).toBe(true);
        expect(c.has('repo')).toBe(true);
        expect(c.has('is_fork')).toBe(true);
        expect(c.has('upstream_owner')).toBe(true);
        expect(c.has('upstream_repo')).toBe(true);
        expect(c.has('checked_at')).toBe(true);
    });

    it('round-trips a fork row and a non-fork row', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        const insert = db.prepare(
            `INSERT INTO fork_upstream (owner, repo, is_fork, upstream_owner, upstream_repo, checked_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        );
        insert.run('me', 'forked', 1, 'upstream-org', 'canonical', '2026-06-20T00:00:00.000Z');
        insert.run('me', 'original', 0, null, null, '2026-06-20T00:00:00.000Z');

        const fork = db
            .prepare<[], { is_fork: number; upstream_owner: string | null; upstream_repo: string | null }>(
                "SELECT is_fork, upstream_owner, upstream_repo FROM fork_upstream WHERE owner='me' AND repo='forked'",
            )
            .get();
        expect(fork).toEqual({ is_fork: 1, upstream_owner: 'upstream-org', upstream_repo: 'canonical' });

        const orig = db
            .prepare<[], { is_fork: number; upstream_owner: string | null }>(
                "SELECT is_fork, upstream_owner FROM fork_upstream WHERE owner='me' AND repo='original'",
            )
            .get();
        expect(orig).toEqual({ is_fork: 0, upstream_owner: null });
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'fork_upstream').has('checked_at')).toBe(true);
    });
});

describe('db migration v17 (per-workspace IssueWatch granularity)', () => {
    const insertWs = (db: Database.Database, id: string) =>
        db.prepare(
            `INSERT INTO workspaces
               (id, backend, project_id, project_name, tynn_project_id, tynn_project_name, shape, path, last_opened_at, created_by_genie)
             VALUES (@id, 'tynn', 'p', 'P', 'p', 'P', 'simple', @path, NULL, 0)`,
        ).run({ id, path: `/tmp/${id}` });

    it('adds the issuewatch_granularity column to workspaces', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(cols(db, 'workspaces').has('issuewatch_granularity')).toBe(true);
    });

    it('a pre-existing workspace row reads back NULL (⇒ the all-on defaults)', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        insertWs(db, 'w-iwg');
        const row = db
            .prepare<[string], { issuewatch_granularity: string | null }>(
                'SELECT issuewatch_granularity FROM workspaces WHERE id = ?',
            )
            .get('w-iwg');
        expect(row?.issuewatch_granularity).toBeNull();
        // NULL resolves to the documented defaults (every own kind ON + upstream issues+prs).
        expect(parseGranularity(row?.issuewatch_granularity ?? null)).toEqual(
            DEFAULT_ISSUEWATCH_GRANULARITY,
        );
    });

    it('round-trips a stored granularity JSON blob', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        insertWs(db, 'w-iwg2');
        const stored = JSON.stringify({
            own: { issues: true, pulls: false, security: false },
            upstream: 'issues',
        });
        db.prepare('UPDATE workspaces SET issuewatch_granularity = ? WHERE id = ?').run(
            stored,
            'w-iwg2',
        );
        const row = db
            .prepare<[string], { issuewatch_granularity: string | null }>(
                'SELECT issuewatch_granularity FROM workspaces WHERE id = ?',
            )
            .get('w-iwg2');
        expect(parseGranularity(row?.issuewatch_granularity ?? null)).toEqual({
            own: { issues: true, pulls: false, security: false },
            upstream: 'issues',
        });
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'workspaces').has('issuewatch_granularity')).toBe(true);
    });
});

describe('parseGranularity (defaulting + robustness)', () => {
    it('defaults NULL/empty to all-on + upstream issues+prs', () => {
        expect(parseGranularity(null)).toEqual(DEFAULT_ISSUEWATCH_GRANULARITY);
        expect(parseGranularity('')).toEqual(DEFAULT_ISSUEWATCH_GRANULARITY);
    });

    it('treats only an explicit false as off (missing own kinds default ON)', () => {
        expect(parseGranularity(JSON.stringify({ own: { security: false } }))).toEqual({
            own: { issues: true, pulls: true, security: false },
            upstream: 'issues+prs',
        });
    });

    it('falls back to issues+prs for an unrecognized upstream value', () => {
        expect(parseGranularity(JSON.stringify({ upstream: 'everything' })).upstream).toBe(
            'issues+prs',
        );
    });

    it('survives corrupt JSON by returning the defaults', () => {
        expect(parseGranularity('{not json')).toEqual(DEFAULT_ISSUEWATCH_GRANULARITY);
    });
});

describe('db migration v18 (per-bucket IssueWatch remediation policy)', () => {
    const insertWs = (db: Database.Database, id: string) =>
        db.prepare(
            `INSERT INTO workspaces
               (id, backend, project_id, project_name, tynn_project_id, tynn_project_name, shape, path, last_opened_at, created_by_genie)
             VALUES (@id, 'tynn', 'p', 'P', 'p', 'P', 'simple', @path, NULL, 0)`,
        ).run({ id, path: `/tmp/${id}` });

    it('adds the issuewatch_policy_buckets column to workspaces', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(cols(db, 'workspaces').has('issuewatch_policy_buckets')).toBe(true);
    });

    it('a pre-existing workspace row (both columns NULL) resolves to all-surface', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        insertWs(db, 'w-iwp');
        const row = db
            .prepare<
                [string],
                { issuewatch_policy_buckets: string | null; issuewatch_policy: string | null }
            >(
                'SELECT issuewatch_policy_buckets, issuewatch_policy FROM workspaces WHERE id = ?',
            )
            .get('w-iwp');
        expect(row?.issuewatch_policy_buckets).toBeNull();
        expect(
            parsePolicyBuckets(row?.issuewatch_policy_buckets ?? null, row?.issuewatch_policy ?? null),
        ).toEqual({ security: 'surface', issue: 'surface', pr: 'surface' });
    });

    it('BACKWARD COMPAT: a legacy single issuewatch_policy applies to all buckets', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        insertWs(db, 'w-legacy');
        // A row set under the OLD single-value scheme, with no per-bucket blob.
        db.prepare('UPDATE workspaces SET issuewatch_policy = ? WHERE id = ?').run(
            'fix-and-ship',
            'w-legacy',
        );
        const row = db
            .prepare<
                [string],
                { issuewatch_policy_buckets: string | null; issuewatch_policy: string | null }
            >(
                'SELECT issuewatch_policy_buckets, issuewatch_policy FROM workspaces WHERE id = ?',
            )
            .get('w-legacy');
        expect(row?.issuewatch_policy_buckets).toBeNull();
        expect(
            parsePolicyBuckets(row?.issuewatch_policy_buckets ?? null, row?.issuewatch_policy ?? null),
        ).toEqual({ security: 'fix-and-ship', issue: 'fix-and-ship', pr: 'fix-and-ship' });
    });

    it('round-trips a stored per-bucket policy JSON blob (wins over legacy)', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        insertWs(db, 'w-iwp2');
        db.prepare(
            'UPDATE workspaces SET issuewatch_policy = ?, issuewatch_policy_buckets = ? WHERE id = ?',
        ).run(
            'surface', // legacy value present — the per-bucket blob must override it
            JSON.stringify({ security: 'fix-and-ship', issue: 'surface', pr: 'fix' }),
            'w-iwp2',
        );
        const row = db
            .prepare<
                [string],
                { issuewatch_policy_buckets: string | null; issuewatch_policy: string | null }
            >(
                'SELECT issuewatch_policy_buckets, issuewatch_policy FROM workspaces WHERE id = ?',
            )
            .get('w-iwp2');
        expect(
            parsePolicyBuckets(row?.issuewatch_policy_buckets ?? null, row?.issuewatch_policy ?? null),
        ).toEqual({ security: 'fix-and-ship', issue: 'surface', pr: 'fix' });
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'workspaces').has('issuewatch_policy_buckets')).toBe(true);
    });
});

describe('parsePolicyBuckets (defaulting + backward compat + robustness)', () => {
    it('defaults NULL/empty (no legacy) to surface for every bucket', () => {
        expect(parsePolicyBuckets(null)).toEqual({
            security: 'surface',
            issue: 'surface',
            pr: 'surface',
        });
        expect(parsePolicyBuckets('', null)).toEqual({
            security: 'surface',
            issue: 'surface',
            pr: 'surface',
        });
    });

    it('applies a legacy single value to all buckets when no blob is stored', () => {
        expect(parsePolicyBuckets(null, 'fix')).toEqual({
            security: 'fix',
            issue: 'fix',
            pr: 'fix',
        });
    });

    it('reads a full per-bucket blob and ignores the legacy value', () => {
        expect(
            parsePolicyBuckets(
                JSON.stringify({ security: 'fix-and-ship', issue: 'surface', pr: 'fix' }),
                'fix',
            ),
        ).toEqual({ security: 'fix-and-ship', issue: 'surface', pr: 'fix' });
    });

    it('fills a partial blob’s missing buckets from the legacy fallback', () => {
        // Only `security` set → issue/pr fall back to the legacy 'fix-and-ship'.
        expect(
            parsePolicyBuckets(JSON.stringify({ security: 'surface' }), 'fix-and-ship'),
        ).toEqual({ security: 'surface', issue: 'fix-and-ship', pr: 'fix-and-ship' });
    });

    it('coerces invalid enum values to the fallback', () => {
        expect(
            parsePolicyBuckets(JSON.stringify({ security: 'nuke', issue: 'fix', pr: 42 }), null),
        ).toEqual({ security: 'surface', issue: 'fix', pr: 'surface' });
    });

    it('survives corrupt JSON by falling back (to legacy, else surface)', () => {
        expect(parsePolicyBuckets('{not json', 'fix')).toEqual({
            security: 'fix',
            issue: 'fix',
            pr: 'fix',
        });
        expect(parsePolicyBuckets('{not json')).toEqual({
            security: 'surface',
            issue: 'surface',
            pr: 'surface',
        });
    });
});

describe('db migration v20 (Plugin System tables)', () => {
    it('creates plugins + plugin_marketplaces with their key columns', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        const p = cols(db, 'plugins');
        for (const c of ['id', 'namespace', 'source_type', 'enabled', 'manifest_json', 'granted_json', 'marketplace_id', 'integrity']) {
            expect(p.has(c)).toBe(true);
        }
        const m = cols(db, 'plugin_marketplaces');
        for (const c of ['id', 'name', 'url', 'official', 'manifest_json']) {
            expect(m.has(c)).toBe(true);
        }
    });

    it('enforces the source_type CHECK constraint', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        const insert = (type: string) =>
            db.prepare(
                `INSERT INTO plugins (id, namespace, name, version, source_type, install_path, manifest_json, installed_at, updated_at)
                 VALUES ('p','n','N','1.0.0', ?, '/tmp/p', '{}', '', '')`,
            ).run(type);
        expect(() => insert('nonsense')).toThrow();
        expect(() => insert('repo')).not.toThrow();
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'plugins').has('granted_json')).toBe(true);
    });
});

describe('db migration v10 (reclassify mis-stored process specs)', () => {
    const insertSpec = (
        db: Database.Database,
        id: string,
        type: string,
        meta: Record<string, unknown>,
    ) =>
        db.prepare(
            `INSERT INTO terminal_specs
               (id, workspace_id, label, cwd, shell, args_json, env_json, type, meta_json, sort_order, created_at)
             VALUES (@id, NULL, @id, '/tmp', NULL, '[]', '{}', @type, @meta, 0, @now)`,
        ).run({ id, type, meta: JSON.stringify(meta), now: new Date().toISOString() });

    // The migration body is this UPDATE; assert it reclassifies the right rows.
    const heal = (db: Database.Database) =>
        db.exec(
            `UPDATE terminal_specs SET type = 'process'
             WHERE type = 'terminal' AND meta_json LIKE '%"command"%'`,
        );

    it('promotes a terminal-typed row carrying meta.command to process', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        insertSpec(db, 'p1', 'terminal', { command: 'php artisan queue:work' });
        heal(db);
        expect(
            db.prepare<[], { type: string }>("SELECT type FROM terminal_specs WHERE id='p1'").get()?.type,
        ).toBe('process');
    });

    it('leaves a plain terminal (no command) and a code view untouched', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        insertSpec(db, 't1', 'terminal', {});
        insertSpec(db, 'c1', 'code', { file_path: 'x.ts' });
        heal(db);
        const get = (id: string) =>
            db.prepare<[], { type: string }>(`SELECT type FROM terminal_specs WHERE id='${id}'`).get()?.type;
        expect(get('t1')).toBe('terminal');
        expect(get('c1')).toBe('code');
    });
});

describe('db migration v11 (enable MCP for all workspaces by default)', () => {
    // The migration body is this UPDATE; test it directly (runMigrations runs
    // the whole chain in one call, so v11 fires on the empty table before any
    // test row exists — exercise the backfill against seeded rows instead).
    const backfill = (db: Database.Database) =>
        db.exec(`UPDATE workspaces SET mcp_enabled = 1`);

    const insertWs = (db: Database.Database, id: string, mcp: number) =>
        db.prepare(
            `INSERT INTO workspaces
               (id, backend, project_id, project_name, tynn_project_id, tynn_project_name, shape, path, last_opened_at, created_by_genie, mcp_enabled)
             VALUES (@id, 'tynn', 'p', 'P', 'p', 'P', 'simple', @path, NULL, 0, @mcp)`,
        ).run({ id, path: `/tmp/${id}`, mcp });

    it('flips every workspace to mcp_enabled=1', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        insertWs(db, 'w-off', 0);
        insertWs(db, 'w-on', 1);
        backfill(db);
        const mcp = (id: string) =>
            db
                .prepare<[string], { mcp_enabled: number }>(
                    'SELECT mcp_enabled FROM workspaces WHERE id = ?',
                )
                .get(id)?.mcp_enabled;
        expect(mcp('w-off')).toBe(1);
        expect(mcp('w-on')).toBe(1);
    });
});
