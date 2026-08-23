import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
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

describe('db migration v24 (workspace-assignment deprovision marker)', () => {
    const insertWs = (db: Database.Database, id: string, extra = '') =>
        db.prepare(
            `INSERT INTO workspaces
               (id, backend, project_id, project_name, tynn_project_id, tynn_project_name, shape, path, last_opened_at, created_by_genie${extra ? ', assignment_managed' : ''})
             VALUES (@id, 'tynn', 'p', 'P', 'p', 'P', 'agi', @path, NULL, 1${extra})`,
        ).run({ id, path: `/tmp/${id}` });

    it('adds the assignment_managed column to workspaces', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(cols(db, 'workspaces').has('assignment_managed')).toBe(true);
    });

    // The safe default is 0 (NOT managed): an existing ops-provisioned or
    // user-local row must never be seen by the convergent reconcile.
    it('a raw workspace row defaults to assignment_managed=0', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        insertWs(db, 'w-am');
        const row = db
            .prepare<[string], { assignment_managed: number }>(
                'SELECT assignment_managed FROM workspaces WHERE id = ?',
            )
            .get('w-am');
        expect(row?.assignment_managed).toBe(0);
    });

    it('round-trips an assignment-managed (=1) row and filters on it', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        insertWs(db, 'w-managed', ', 1');
        insertWs(db, 'w-plain'); // default 0
        const managed = db
            .prepare<[], { id: string }>(
                'SELECT id FROM workspaces WHERE assignment_managed = 1',
            )
            .all()
            .map((r) => r.id);
        expect(managed).toEqual(['w-managed']);
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'workspaces').has('assignment_managed')).toBe(true);
    });
});

describe('db migration v25 (retire tynn-cli settings)', () => {
    it('deletes only the retired CLI toggles', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        // Force v25 to re-run: drop every schema_version row at/above 25 so the
        // high-water mark falls below 25 and the runner re-applies from there
        // (later ADD COLUMN migrations are idempotent, so re-running them no-ops).
        db.prepare('DELETE FROM schema_version WHERE version >= 25').run();
        const insert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
        insert.run('cli_tools_in_terminals', 'on');
        insert.run('cli_install_systemwide', 'on');
        insert.run('notify_sound', 'on');

        runMigrations(db);

        const settings = db.prepare<[], { key: string }>('SELECT key FROM settings ORDER BY key').all();
        expect(settings.map((row) => row.key)).toEqual(['notify_sound']);
    });
});

describe('db migration v26 (IssueWatch designated handlers column)', () => {
    const insertWs = (db: Database.Database, id: string) =>
        db.prepare(
            `INSERT INTO workspaces
               (id, backend, project_id, project_name, tynn_project_id, tynn_project_name, shape, path, last_opened_at, created_by_genie)
             VALUES (@id, 'tynn', 'p', 'P', 'p', 'P', 'agi', @path, NULL, 1)`,
        ).run({ id, path: `/tmp/${id}` });

    it('adds the issuewatch_handlers column to workspaces', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(cols(db, 'workspaces').has('issuewatch_handlers')).toBe(true);
    });

    it('a raw workspace row defaults issuewatch_handlers to NULL (not designated)', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        insertWs(db, 'w-iw');
        const row = db
            .prepare<[string], { issuewatch_handlers: string | null }>(
                'SELECT issuewatch_handlers FROM workspaces WHERE id = ?',
            )
            .get('w-iw');
        expect(row?.issuewatch_handlers).toBeNull();
    });

    it('round-trips a JSON handler array', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        insertWs(db, 'w-iw2');
        db.prepare('UPDATE workspaces SET issuewatch_handlers = ? WHERE id = ?').run(
            JSON.stringify(['term-a', 'term-b']),
            'w-iw2',
        );
        const row = db
            .prepare<[string], { issuewatch_handlers: string | null }>(
                'SELECT issuewatch_handlers FROM workspaces WHERE id = ?',
            )
            .get('w-iw2');
        expect(JSON.parse(row?.issuewatch_handlers ?? 'null')).toEqual(['term-a', 'term-b']);
    });
});

describe('db migration v28 (per-workspace scheduled-task approval gate)', () => {
    it('adds the schedule_approval column to workspaces', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(cols(db, 'workspaces').has('schedule_approval')).toBe(true);
    });

    // The safe default is require-approval (1), exactly like process_approval
    // (v13) and terminal_approval (v14): an agent must NOT be able to arm a
    // recurring task that runs unattended, forever, without the user seeing it.
    it('a raw workspace row defaults to schedule_approval=1 (require approval)', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        db.prepare(
            `INSERT INTO workspaces
               (id, backend, project_id, project_name, tynn_project_id, tynn_project_name, shape, path, last_opened_at, created_by_genie)
             VALUES ('w-sa', 'tynn', 'p', 'P', 'p', 'P', 'simple', '/tmp/sa', NULL, 0)`,
        ).run();
        const row = db
            .prepare<[string], { schedule_approval: number }>(
                'SELECT schedule_approval FROM workspaces WHERE id = ?',
            )
            .get('w-sa');
        expect(row?.schedule_approval).toBe(1);
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'workspaces').has('schedule_approval')).toBe(true);
    });
});

describe('db migration v34 (retiring the beta.218 native hosting columns, #234 P4)', () => {
    it('drops hosted_sites and workspace_services, and leaves the rest of the row intact', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        const c = cols(db, 'workspaces');
        expect(c.has('hosted_sites')).toBe(false);
        expect(c.has('workspace_services')).toBe(false);
        // The neighbouring JSON-blob columns are untouched — a DROP COLUMN that
        // took a sibling with it would silently lose every workspace's tunnel
        // sites or dev-server definitions.
        expect(c.has('tunnel_sites')).toBe(true);
        expect(c.has('dev_sites')).toBe(true);
        expect(c.has('dev_services')).toBe(true);
        expect(c.has('path')).toBe(true);
    });

    it('drops them on an UPGRADE too, not just a fresh database', () => {
        // The case that matters: a user on beta.218 has both columns, full of
        // configuration for a runtime that no longer exists. A migration that
        // only worked on a fresh install would leave every existing machine
        // carrying dead columns forever.
        const db = new Database(':memory:');
        db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)');
        const upTo33 = () => {
            runMigrations(db);
            // Rewind to v33. The runner resumes from the HIGHEST recorded
            // version, so every row above 33 has to go — dropping only the v34
            // row would leave a later migration's version as the max and v34
            // would never re-run (which is exactly how this stopped testing
            // anything the first time a v35 landed).
            db.exec('DELETE FROM schema_version WHERE version >= 34');
            db.exec('ALTER TABLE workspaces ADD COLUMN hosted_sites TEXT');
            db.exec('ALTER TABLE workspaces ADD COLUMN workspace_services TEXT');
        };
        upTo33();
        expect(cols(db, 'workspaces').has('hosted_sites')).toBe(true);

        runMigrations(db);

        const c = cols(db, 'workspaces');
        expect(c.has('hosted_sites')).toBe(false);
        expect(c.has('workspace_services')).toBe(false);
    });

    it('is idempotent — a database that already lacks them converges', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'workspaces').has('hosted_sites')).toBe(false);
    });
});

describe('db migration v35 (AgentInbox file attachments)', () => {
    it('adds the attachment METADATA table — the bytes deliberately live outside the db', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        const c = cols(db, 'agentinbox_attachments');
        expect([...c].sort()).toEqual(
            ['bytes', 'created_at', 'filename', 'id', 'message_id', 'mime', 'sha256'].sort(),
        );
        // No blob column: a 25 MB payload in a WAL-journalled database that every
        // spec, message and cursor write goes through would tax every one of them.
        expect(c.has('data')).toBe(false);
        expect(c.has('blob')).toBe(false);
    });

    it('CASCADES with the message, so wiping a conversation takes its attachments', () => {
        const db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db);

        db.prepare(
            `INSERT INTO whisper_messages (id, seq, kind, from_id, from_label, to_id, channel_key, text, ts, interrupt)
             VALUES ('m1', 1, 'dm', 'a', 'A', 'b', NULL, 'hi', 1, 0)`,
        ).run();
        db.prepare(
            `INSERT INTO agentinbox_attachments (id, message_id, filename, bytes, mime, sha256, created_at)
             VALUES ('f1', 'm1', 'a.md', 4, 'text/markdown', 'aa', 1)`,
        ).run();

        db.prepare("DELETE FROM whisper_messages WHERE id = 'm1'").run();

        const left = db
            .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM agentinbox_attachments')
            .get();
        expect(left?.n).toBe(0);
    });

    it('applies to an EXISTING database, not just a fresh one', () => {
        const db = new Database(':memory:');
        db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)');
        runMigrations(db);
        db.exec('DELETE FROM schema_version WHERE version >= 35');
        db.exec('DROP TABLE agentinbox_attachments');
        // PRAGMA table_info on a missing table reports no columns — that empty
        // set is the proof the table really is gone before the re-run.
        expect(cols(db, 'agentinbox_attachments').size).toBe(0);

        runMigrations(db);

        expect(cols(db, 'agentinbox_attachments').has('sha256')).toBe(true);
    });
});

describe('db migrations v32 + v33 (the container Dev Server’s services, #234 P3)', () => {
    it('adds the per-workspace dev_services column, defaulting to nothing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(cols(db, 'workspaces').has('dev_services')).toBe(true);

        db.prepare(
            `INSERT INTO workspaces
               (id, backend, project_id, project_name, tynn_project_id, tynn_project_name, shape, path, last_opened_at, created_by_genie)
             VALUES ('w-svc', 'tynn', 'p', 'P', 'p', 'P', 'simple', '/tmp/svc', NULL, 0)`,
        ).run();
        const row = db
            .prepare<[string], { dev_services: string | null }>(
                'SELECT dev_services FROM workspaces WHERE id = ?',
            )
            .get('w-svc');
        // NULL, not '{}' — an existing workspace gains the column with the safe
        // default (nothing configured, nothing running).
        expect(row?.dev_services ?? null).toBeNull();
    });

    it('kept dev_services SEPARATE from workspace_services, which is what let P4 DELETE it', () => {
        // v31/v32 were third and fourth columns rather than reuses of v29/v30
        // precisely so that retiring the beta.218 path would be a deletion and
        // not a data migration. v34 collects: the container columns survive, the
        // native ones are gone, and nothing had to be copied between them.
        const db = new Database(':memory:');
        runMigrations(db);
        const c = cols(db, 'workspaces');
        expect(c.has('dev_sites')).toBe(true);
        expect(c.has('dev_services')).toBe(true);
        expect(c.has('hosted_sites')).toBe(false);
        expect(c.has('workspace_services')).toBe(false);
    });

    it('creates the machine-scoped engine table — a shared engine belongs to no workspace', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        const c = cols(db, 'dev_service_engines');
        expect([...c].sort()).toEqual(
            ['admin_password', 'admin_user', 'created_at', 'engine', 'key', 'version', 'workspace_id'].sort(),
        );
        // Nullable workspace: NULL is the shared engine, a value is a
        // workspace's opt-in dedicated one.
        db.prepare(
            `INSERT INTO dev_service_engines (key, engine, version, workspace_id, admin_user, admin_password, created_at)
             VALUES ('postgres-16', 'postgres', '16', NULL, 'postgres', 'pw', 1)`,
        ).run();
        expect(
            db
                .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM dev_service_engines')
                .get()?.n,
        ).toBe(1);
    });

    it('keys an engine record by the CONTAINER, so a second insert cannot fork the credential', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        const insert = () =>
            db
                .prepare(
                    `INSERT OR IGNORE INTO dev_service_engines (key, engine, version, workspace_id, admin_user, admin_password, created_at)
                     VALUES ('postgres-16', 'postgres', '16', NULL, 'postgres', ?, 1)`,
                )
                .run('pw-' + Math.random());
        insert();
        insert();
        const rows = db
            .prepare<[], { admin_password: string }>('SELECT admin_password FROM dev_service_engines')
            .all();
        expect(rows).toHaveLength(1);
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'workspaces').has('dev_services')).toBe(true);
    });
});

describe('v37 — App workspaces (Tynn #250)', () => {
    it('adds app_kind, and every EXISTING workspace stays an ordinary one', () => {
        // The migration must not retroactively turn anybody's project into an App.
        const db = new Database(':memory:');
        runMigrations(db);
        db.prepare(
            `INSERT INTO workspaces
                (id, project_id, project_name, tynn_project_id, tynn_project_name, shape, path, sort_order)
             VALUES ('ws-1', 'p1', 'A Project', 'p1', 'A Project', 'simple', '/tmp/a', 0)`,
        ).run();

        expect(cols(db, 'workspaces').has('app_kind')).toBe(true);
        const row = db
            .prepare<[], { app_kind: string | null }>('SELECT app_kind FROM workspaces')
            .get();
        expect(row?.app_kind ?? null).toBeNull();
    });

    it('leaves `shape` and its CHECK constraint alone', () => {
        // The reason app_kind is a separate column: `shape` carries
        // CHECK (shape IN ('agi','simple')), and SQLite cannot alter a CHECK
        // without rebuilding the table. Rebuilding `workspaces` — the table every
        // other feature keys off — is the wrong risk for a label. If a later
        // change ever does relax that constraint, this fails and asks why.
        const db = new Database(':memory:');
        runMigrations(db);

        expect(() =>
            db
                .prepare(
                    `INSERT INTO workspaces
                        (id, project_id, project_name, tynn_project_id, tynn_project_name, shape, path, sort_order)
                     VALUES ('ws-2', 'p2', 'B', 'p2', 'B', 'app', '/tmp/b', 0)`,
                )
                .run(),
        ).toThrow();
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'workspaces').has('app_kind')).toBe(true);
    });
});

/**
 * v45 — how many agent terminals a workspace may run (Tynn #117).
 *
 * The column is only half the feature. The other half is that an AGENT cannot
 * write it, and that half is structural rather than a runtime check: the column is
 * absent from `updateWorkspace`'s allowlist, so a patch naming it is dropped. That
 * omission is easy to "fix" by someone adding the column to the allowlist for
 * consistency, which would silently hand agents the ability to raise their own
 * cap — so it is pinned here.
 */
describe('migration v45 — the agent-terminal cap', () => {
    const insertWorkspace = (db: Database.Database, id: string) =>
        db
            .prepare(
                `INSERT INTO workspaces
                    (id, project_id, project_name, tynn_project_id, tynn_project_name, shape, path, sort_order)
                 VALUES (?, 'p1', 'A Project', 'p1', 'A Project', 'simple', '/tmp/a', 0)`,
            )
            .run(id);

    it('adds max_agent_terminals, and every existing workspace inherits', () => {
        // NULL is the only honest default: a workspace that predates this expressed
        // no opinion, and stamping one on it would either loosen or tighten a limit
        // nobody chose.
        const db = new Database(':memory:');
        runMigrations(db);
        insertWorkspace(db, 'ws-1');

        expect(cols(db, 'workspaces').has('max_agent_terminals')).toBe(true);
        const row = db
            .prepare<[], { max_agent_terminals: number | null }>(
                'SELECT max_agent_terminals FROM workspaces',
            )
            .get();
        expect(row?.max_agent_terminals ?? null).toBeNull();
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'workspaces').has('max_agent_terminals')).toBe(true);
    });

    it('is NOT writable through the generic workspace patch', () => {
        // The load-bearing guard. `updateWorkspace` UPDATEs a hardcoded column list;
        // governed columns are deliberately missing from it, so a patch naming one
        // is dropped rather than applied. If someone ever adds this column to that
        // list, an agent calling the generic update path could raise its own cap,
        // and this test is what says so.
        const source = fs.readFileSync(path.join(__dirname, '..', 'db.ts'), 'utf8');
        const updateFn = source.slice(source.indexOf('export function updateWorkspace'));
        const body = updateFn.slice(0, updateFn.indexOf('\n}'));

        expect(body).not.toContain('max_agent_terminals');
        // Positive control: the same slice DOES contain a column the patch path is
        // supposed to write, so this is asserting against a real function body and
        // not an empty string that would pass no matter what.
        expect(body).toContain('editor_cmd');
    });

    it('has no setter reachable from the MCP surface', () => {
        // The other half of "only a person sets this". An agent-facing tool that
        // imported the setter would defeat the column-allowlist guard above without
        // touching db.ts at all.
        const mcpDir = path.join(__dirname, '..', 'mcp');
        const sources = fs
            .readdirSync(mcpDir)
            .filter((f) => f.endsWith('.ts'))
            .map((f) => [f, fs.readFileSync(path.join(mcpDir, f), 'utf8')] as const);

        const mentions = (symbol: string) =>
            sources.filter(([, src]) => src.includes(symbol)).map(([f]) => f);

        expect(mentions('setWorkspaceAgentCap')).toEqual([]);

        // POSITIVE CONTROL. "No file mentions X" passes just as happily when the
        // directory failed to read, the filter is wrong, or the files are empty.
        // `isWorkstationOperator` is the READ side of the sibling human-only
        // setting and is definitely imported here, so finding it proves this scan
        // can actually see the source it claims to be checking.
        expect(mentions('isWorkstationOperator').length).toBeGreaterThan(0);
    });
});

describe('v39 — what the user granted a GApp (Tynn #250)', () => {
    const install = (db: Database.Database, over: Record<string, unknown> = {}) =>
        db
            .prepare(
                `INSERT INTO app_grants
                    (app_id, workspace_id, name, version, slug, scope, workspaces_json,
                     capabilities_json, manifest_json, install_path, revoked, installed_at, updated_at)
                 VALUES (@app_id, @workspace_id, @name, @version, @slug, @scope, @workspaces_json,
                     @capabilities_json, @manifest_json, @install_path, @revoked, @now, @now)`,
            )
            .run({
                app_id: 'com.example.trader',
                workspace_id: 'ws-app',
                name: 'Example Trader',
                version: '1.0.0',
                slug: 'trader',
                scope: 'self',
                workspaces_json: '[]',
                capabilities_json: '["hosting"]',
                manifest_json: '{}',
                install_path: '/tmp/trader',
                revoked: 0,
                now: '2026-01-01T00:00:00.000Z',
                ...over,
            });

    it('records the grant, keyed by the app id', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        install(db);

        const row = db
            .prepare<[], { scope: string; capabilities_json: string; revoked: number }>(
                'SELECT scope, capabilities_json, revoked FROM app_grants',
            )
            .get();
        expect(row?.scope).toBe('self');
        expect(row?.capabilities_json).toBe('["hosting"]');
        expect(row?.revoked).toBe(0);
    });

    it('refuses a scope the permission model does not have', () => {
        // A grant row is authority. An unrecognised scope must not be storable at
        // all, rather than sit there waiting for a reader to interpret it
        // generously.
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => install(db, { scope: 'everything' })).toThrow();
    });

    it('cannot install the same app twice', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        install(db);
        // Two grant rows for one app is two answers to "what may this app do?".
        expect(() => install(db)).toThrow();
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'app_grants').has('capabilities_json')).toBe(true);
    });
});

describe('v40 — an app you are BUILDING (Tynn #250)', () => {
    it('adds dev_mode, and every EXISTING app stays a normal one', () => {
        // A dev app runs from a folder Genie does not control and gets dev tools.
        // Nobody's installed apps should acquire that by upgrading.
        const db = new Database(':memory:');
        runMigrations(db);
        db.prepare(
            `INSERT INTO app_grants
                (app_id, workspace_id, name, version, slug, scope, manifest_json, install_path, installed_at, updated_at)
             VALUES ('com.a.b', 'ws', 'A', '1.0.0', 'a', 'self', '{}', '/tmp/a', 'now', 'now')`,
        ).run();

        expect(cols(db, 'app_grants').has('dev_mode')).toBe(true);
        const row = db.prepare<[], { dev_mode: number }>('SELECT dev_mode FROM app_grants').get();
        expect(row?.dev_mode).toBe(0);
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'app_grants').has('dev_mode')).toBe(true);
    });
});

describe('v41 — where an app came from (Tynn #250)', () => {
    it('adds the provenance columns, NULL for apps installed before them', () => {
        // Honest rather than convenient: Genie does not know where those came
        // from, and inventing "folder" would be a provenance claim it cannot back.
        const db = new Database(':memory:');
        runMigrations(db);
        db.prepare(
            `INSERT INTO app_grants
                (app_id, workspace_id, name, version, slug, scope, manifest_json, install_path, installed_at, updated_at)
             VALUES ('com.a.b', 'ws', 'A', '1.0.0', 'a', 'self', '{}', '/tmp/a', 'now', 'now')`,
        ).run();

        const c = cols(db, 'app_grants');
        expect(c.has('source_kind')).toBe(true);
        expect(c.has('source_origin')).toBe(true);
        expect(c.has('source_commit')).toBe(true);

        const row = db
            .prepare<[], { source_kind: string | null }>('SELECT source_kind FROM app_grants')
            .get();
        expect(row?.source_kind ?? null).toBeNull();
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'app_grants').has('source_origin')).toBe(true);
    });
});

describe('v42 — data kept from an uninstalled app (Tynn #250)', () => {
    it('remembers WHICH ORIGIN the kept data belongs to', () => {
        // The second column is the whole point: data is kept for an app from a
        // particular place, so a reinstall from anywhere else cannot inherit it.
        const db = new Database(':memory:');
        runMigrations(db);
        db.prepare(
            `INSERT INTO app_retained_data (app_id, source_origin, retained_at)
             VALUES ('com.a.b', 'github.com/acme/trader', 'now')`,
        ).run();

        const row = db
            .prepare<[], { source_origin: string }>('SELECT source_origin FROM app_retained_data')
            .get();
        expect(row?.source_origin).toBe('github.com/acme/trader');
    });

    it('holds one record per app, so a second uninstall replaces the first', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        const insert = () =>
            db
                .prepare(
                    `INSERT INTO app_retained_data (app_id, source_origin, retained_at)
                     VALUES ('com.a.b', 'x', 'now')`,
                )
                .run();
        insert();
        expect(insert).toThrow();
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'app_retained_data').has('source_origin')).toBe(true);
    });
});

describe('v46 — the terminal service-env record is GONE (genie#242)', () => {
    it('drops v43’s table, because there is nothing left to drift', () => {
        // v43 persisted what Genie baked into each pty so a later read could
        // notice the values had moved and tell the user to open a new terminal.
        // That was a signal ABOUT a bug: the app's configuration lived in a
        // shell's environment instead of in the `.env` the app reads, where a
        // stale copy silently OVERRODE a correct file. The bug is fixed at the
        // source now — Genie writes the connection into the repo's `.env` and
        // keeps it current, and a terminal carries no name a framework reads —
        // so there is nothing to record and no notice to give.
        const db = new Database(':memory:');
        runMigrations(db);

        const tables = db
            .prepare<[], { name: string }>(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'terminal_service_env'",
            )
            .all();
        expect(tables).toEqual([]);
    });

    it('is idempotent — re-running converges without throwing', () => {
        // A POSITIVE control alongside the absence above: a migrator that failed
        // to run at all would also leave no `terminal_service_env`, so assert the
        // rest of the schema is genuinely there.
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'workspaces').has('max_agent_terminals')).toBe(true);
    });
});

describe('v44 — where a GApp’s backups go (Tynn #250, step 4)', () => {
    it('adds a per-app override column, and every existing app keeps the workstation default', () => {
        // NULL means "no override", which is the only honest default: an app
        // installed before this had no opinion about where its dumps land.
        const db = new Database(':memory:');
        runMigrations(db);
        db.prepare(
            `INSERT INTO app_grants
                (app_id, workspace_id, name, version, slug, scope, manifest_json, install_path,
                 installed_at, updated_at)
             VALUES ('app-1', 'ws-1', 'Notes', '1.0.0', 'notes', 'self', '{}', '/tmp/notes',
                     '2026-08-22', '2026-08-22')`,
        ).run();

        expect(cols(db, 'app_grants').has('backup_json')).toBe(true);
        const row = db
            .prepare<[], { backup_json: string | null }>('SELECT backup_json FROM app_grants')
            .get();
        expect(row?.backup_json ?? null).toBeNull();
    });

    it('is idempotent — re-running converges without throwing', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(() => runMigrations(db)).not.toThrow();
        expect(cols(db, 'app_grants').has('backup_json')).toBe(true);
    });
});
