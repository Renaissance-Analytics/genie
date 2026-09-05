import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db';

/**
 * `kiwi` BECOMES `kilo`, ON MACHINES THAT ALREADY RAN GENIE.
 *
 * Genie shipped a provider called "Kiwi Code" whose own registry comment
 * admitted no public source for a `kiwi` binary could be found. The reason is
 * that no such product exists: the npm registry and the open web have nothing
 * called Kiwi Code, and the `kiwi-cli` package is an unrelated general-purpose
 * tool. The real neighbours are Kilo Code (`@kilocode/cli`, bin `kilo`) and
 * Kimi Code (`@moonshot-ai/kimi-code`, bin `kimi`); the owner confirmed Kilo.
 *
 * Renaming the registry entry is not enough, and that is the whole point of this
 * migration — it is v58's lesson repeated. A provider id is PERSISTED: in each
 * agent terminal's `meta.agent`, and in the `agent_command_<id>` /
 * `agent_flags_<id>` settings, and in `agent_default`. Change the registry alone
 * and every existing Kiwi agent keeps a provider id nothing in the new build
 * recognises — `isTuiId('kiwi')` is false, so it falls out of the roster, out of
 * the reconnect table, and off the Toolchain page, silently.
 *
 * The stored COMMAND is cleared rather than rewritten, exactly as v58 did: a
 * default belongs in the registry and nowhere else, and `kiwi` was never a
 * binary anybody could have run on purpose. A command the owner actually typed
 * survives — that is the difference between a repair and a second bug.
 */

function fresh(): Database.Database {
    const db = new Database(':memory:');
    runMigrations(db);
    return db;
}

/** Re-run the migration set after planting pre-rename rows, as an upgrade does. */
function migrateAgain(db: Database.Database): void {
    db.prepare('DELETE FROM schema_version WHERE version >= 73').run();
    runMigrations(db);
}

function setSetting(db: Database.Database, key: string, value: string): void {
    db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
}

const settingOf = (db: Database.Database, key: string) =>
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)
        ?.value;

function plantSpec(db: Database.Database, meta: Record<string, unknown>, id = 'spec-kiwi'): string {
    db.prepare(
        `INSERT INTO terminal_specs (id, label, cwd, type, meta_json, created_at)
         VALUES (?, 'Kiwi', '/tmp', 'terminal', ?, ?)`,
    ).run(id, JSON.stringify(meta), Date.now());
    return id;
}

const metaOf = (db: Database.Database, id: string, field: string) =>
    (
        db
            .prepare(`SELECT json_extract(meta_json, '$.${field}') AS v FROM terminal_specs WHERE id = ?`)
            .get(id) as { v: string | null }
    ).v;

describe('the kiwi to kilo rename reaches an existing install', () => {
    it('moves a stored agent terminal onto the provider that exists', () => {
        const db = fresh();
        const id = plantSpec(db, { agent: 'kiwi', agent_command: 'kiwi' });
        migrateAgain(db);
        expect(metaOf(db, id, 'agent')).toBe('kilo');
    });

    it('clears the command that was never a binary, so the registry default wins', () => {
        const db = fresh();
        const id = plantSpec(db, { agent: 'kiwi', agent_command: 'kiwi' });
        migrateAgain(db);
        expect(metaOf(db, id, 'agent_command')).toBeNull();
    });

    it('KEEPS a command the owner actually chose — a repair, not a second bug', () => {
        const db = fresh();
        const id = plantSpec(db, { agent: 'kiwi', agent_command: '/opt/mine/kiwi --wrapped' });
        migrateAgain(db);
        expect(metaOf(db, id, 'agent')).toBe('kilo');
        expect(metaOf(db, id, 'agent_command')).toBe('/opt/mine/kiwi --wrapped');
    });

    it('carries the owner flags across to the key the new build reads', () => {
        const db = fresh();
        setSetting(db, 'agent_flags_kiwi', '--verbose');
        migrateAgain(db);
        expect(settingOf(db, 'agent_flags_kilo')).toBe('--verbose');
        expect(settingOf(db, 'agent_flags_kiwi')).toBeUndefined();
    });

    it('does NOT carry the dead default command across as if it were a choice', () => {
        const db = fresh();
        setSetting(db, 'agent_command_kiwi', 'kiwi');
        migrateAgain(db);
        // `kiwi` was never a binary. Carrying it to `agent_command_kilo` would
        // move a broken value onto a working provider and shadow `kilo` forever
        // — v58's exact failure, with a new name on it.
        expect(settingOf(db, 'agent_command_kilo') ?? '').toBe('');
        expect(settingOf(db, 'agent_command_kiwi')).toBeUndefined();
    });

    it('carries a REAL command the owner set, because that was their choice', () => {
        const db = fresh();
        setSetting(db, 'agent_command_kiwi', '/opt/mine/kiwi');
        migrateAgain(db);
        expect(settingOf(db, 'agent_command_kilo')).toBe('/opt/mine/kiwi');
    });

    it('moves the workstation default when it pointed at the phantom provider', () => {
        const db = fresh();
        setSetting(db, 'agent_default', 'kiwi');
        migrateAgain(db);
        expect(settingOf(db, 'agent_default')).toBe('kilo');
    });

    it('leaves every other provider alone', () => {
        // POSITIVE CONTROL. A migration that renames too much is worse than one
        // that renames nothing, because nobody goes looking.
        const db = fresh();
        setSetting(db, 'agent_command_claude', 'claude');
        setSetting(db, 'agent_default', 'claude');
        const id = plantSpec(db, { agent: 'codex', agent_command: 'codex' }, 'spec-codex');
        migrateAgain(db);
        expect(settingOf(db, 'agent_command_claude')).toBe('claude');
        expect(settingOf(db, 'agent_default')).toBe('claude');
        expect(metaOf(db, id, 'agent')).toBe('codex');
        expect(metaOf(db, id, 'agent_command')).toBe('codex');
    });

    it('does not clobber a kilo setting the owner already has', () => {
        // Both keys present is possible on a machine that ran a build with the
        // new provider before this migration reached it. The owner's CURRENT
        // choice wins; the phantom's leftover is dropped.
        const db = fresh();
        setSetting(db, 'agent_command_kiwi', '/old/kiwi');
        setSetting(db, 'agent_command_kilo', '/new/kilo');
        migrateAgain(db);
        expect(settingOf(db, 'agent_command_kilo')).toBe('/new/kilo');
        expect(settingOf(db, 'agent_command_kiwi')).toBeUndefined();
    });
});
