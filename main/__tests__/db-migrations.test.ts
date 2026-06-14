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
