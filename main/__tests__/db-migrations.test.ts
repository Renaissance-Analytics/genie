import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db';

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
