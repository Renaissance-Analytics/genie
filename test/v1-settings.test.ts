import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readV1Settings, V1_OPEN_OPTIONS } from '../src/main/v1-settings.js';

/**
 * READING v1's SETTINGS — the owner's ruling (2026-10-10): "settings that still exist in Genie 2
 * carry over". v1 keeps them in `%APPDATA%\genie\genie.db`, a `settings(key, value)` table, and
 * that database is in WAL mode with a third of its content in the `-wal` sidecar while v1 runs.
 *
 * The reader is `node:sqlite` — a Node builtin, so not third-party (Fancy measured it unflagged
 * on Node 22.23.2 and against a live WAL writer). Three rules, each with a test:
 *
 * - **Read-only, always.** We migrate OUT of v1, never into it; a read-only open cannot corrupt
 *   a database the old app may still have open.
 * - **WAL rows are seen.** A reader that parsed only the main file would return settings that
 *   are silently STALE — old values, not missing ones — which is the worst shape a migration
 *   can have. The test writes through an open writer and reads from a second connection.
 * - **Cannot-see is `null`, measured-none is an empty map.** No database, or a database with no
 *   `settings` table, answers `null`; a settings table with no rows answers `{}`. §5.
 */
describe('readV1Settings', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'genie2-v1-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

    function v1db(file: string): DatabaseSync {
        const db = new DatabaseSync(file);
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
        return db;
    }

    it('reads every key and value from the settings table', () => {
        const file = join(dir, 'genie.db');
        const db = v1db(file);
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('theme', 'dark');
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('workstation_name', 'alphar');
        db.close();
        expect(readV1Settings(file)).toEqual({ theme: 'dark', workstation_name: 'alphar' });
    });

    it('sees a row that is still only in the WAL, with v1 holding the database open', () => {
        const file = join(dir, 'genie.db');
        const writer = v1db(file);
        writer.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('theme', 'light');
        // The writer stays OPEN — that is the real situation: the old Genie may be running.
        const seen = readV1Settings(file);
        writer.close();
        expect(seen).toEqual({ theme: 'light' });
    });

    it('opens read-only — the mode the reader uses refuses a write; the reader exposes no other open', () => {
        const file = join(dir, 'genie.db');
        const db = v1db(file);
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('theme', 'dark');
        db.close();
        // The mode is held as a value so this test asserts what the reader DOES, not a copy of
        // it; and the probe shows what that value means — DML is refused on such a connection.
        expect(V1_OPEN_OPTIONS.readOnly).toBe(true);
        const ro = new DatabaseSync(file, V1_OPEN_OPTIONS);
        expect(() => ro.exec("INSERT INTO settings VALUES ('x', 'y')")).toThrow();
        ro.close();
        // POSITIVE CONTROL for the probe: the same statement on a read-write open succeeds.
        const rw = new DatabaseSync(file);
        expect(() => rw.exec("INSERT INTO settings VALUES ('x', 'y')")).not.toThrow();
        rw.close();
        expect(readV1Settings(file)).toEqual({ theme: 'dark', x: 'y' });
    });

    it('answers null — cannot see — for a missing file, and for a database with no settings table', () => {
        expect(readV1Settings(join(dir, 'nothing-here.db'))).toBeNull();
        const file = join(dir, 'other.db');
        const db = new DatabaseSync(file);
        db.exec('CREATE TABLE agents (id TEXT)');
        db.close();
        expect(readV1Settings(file)).toBeNull();
    });

    it('answers an EMPTY map — measured none — for a settings table with no rows (§5: not the same as null)', () => {
        const file = join(dir, 'genie.db');
        v1db(file).close();
        expect(readV1Settings(file)).toEqual({});
    });

    it('answers null rather than throwing for a file that is not a database', () => {
        const file = join(dir, 'genie.db');
        writeFileSync(file, 'this is not sqlite');
        expect(readV1Settings(file)).toBeNull();
    });
});
