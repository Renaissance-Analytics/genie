import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db';

/**
 * A RETIRED command must not survive in the two places that outrank the registry.
 *
 * `resolveAgentCommand` reads, in order: an explicit override on the spec
 * (`meta.agent_command`), the owner's `agent_command_<id>` SETTING, then the
 * registry default. The Genie TUI shipped with a default of `genie-tui`, which
 * is not a binary — selecting it produced `bash: genie-tui: command not found`.
 *
 * Fixing the registry fixed NOTHING on a machine that had already run Genie,
 * because both higher-precedence copies had the dead string baked in: the
 * setting was written once from the old default, and the spec's meta carried
 * its own copy. The owner's Genie OS agent kept failing after the fix shipped,
 * and the release notes claimed it was repaired.
 *
 * That is the real defect — a DEFAULT was persisted into two caches, so
 * changing it could never reach an existing install. This migration clears the
 * caches wherever they hold a string that is no longer any tui's command.
 *
 * It matches EXACT retired values only. A command the owner actually chose must
 * survive untouched, or the repair becomes a different bug.
 */

function fresh(): Database.Database {
    const db = new Database(':memory:');
    runMigrations(db);
    return db;
}

/** Rewind to before v58 and plant the stale rows a real install carries. */
function withStale(
    db: Database.Database,
    opts: { setting?: string; specCommand?: string },
): string {
    if (opts.setting !== undefined) {
        db.prepare(
            `INSERT INTO settings (key, value) VALUES ('agent_command_genie', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run(opts.setting);
    }
    const id = 'spec-1';
    db.prepare(
        `INSERT INTO terminal_specs (id, label, cwd, type, meta_json, created_at)
         VALUES (?, 'Genie', '/tmp', 'terminal', ?, ?)`,
    ).run(
        id,
        JSON.stringify({ agent: 'genie', agent_command: opts.specCommand }),
        Date.now(),
    );
    return id;
}

const settingOf = (db: Database.Database) =>
    (
        db.prepare("SELECT value FROM settings WHERE key = 'agent_command_genie'").get() as
            | { value: string }
            | undefined
    )?.value;

const specCommandOf = (db: Database.Database, id: string) =>
    (
        db
            .prepare("SELECT json_extract(meta_json,'$.agent_command') AS c FROM terminal_specs WHERE id = ?")
            .get(id) as { c: string | null }
    ).c;

/** Re-run the migration set after planting stale rows, as an upgrade would. */
function migrateAgain(db: Database.Database): void {
    db.prepare('DELETE FROM schema_version WHERE version >= 58').run();
    runMigrations(db);
}

describe('retiring `genie-tui`', () => {
    it('clears the stale SETTING, which outranks the registry', () => {
        const db = fresh();
        withStale(db, { setting: 'genie-tui' });
        migrateAgain(db);
        // Cleared, not rewritten to 'genie': the registry is the one place the
        // default belongs, and writing a second copy is what caused this.
        expect(settingOf(db) ?? '').toBe('');
    });

    it('clears the stale command baked into a SPEC', () => {
        const db = fresh();
        const id = withStale(db, { specCommand: 'genie-tui' });
        migrateAgain(db);
        expect(specCommandOf(db, id)).toBeNull();
    });

    it('leaves a command the owner actually chose alone', () => {
        // POSITIVE CONTROL, and the one that keeps this from becoming a worse
        // bug: only the exact retired string goes.
        const db = fresh();
        const id = withStale(db, { setting: '/opt/mine/genie', specCommand: 'npx genie@next' });
        migrateAgain(db);
        expect(settingOf(db)).toBe('/opt/mine/genie');
        expect(specCommandOf(db, id)).toBe('npx genie@next');
    });

    it('leaves other providers untouched', () => {
        const db = fresh();
        db.prepare(
            `INSERT INTO settings (key, value) VALUES ('agent_command_claude', 'claude')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run();
        migrateAgain(db);
        expect(
            (db.prepare("SELECT value FROM settings WHERE key='agent_command_claude'").get() as { value: string }).value,
        ).toBe('claude');
    });
});
