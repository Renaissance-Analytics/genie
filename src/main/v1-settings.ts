import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * v1's SETTINGS, read once for the carry-over the owner asked for (2026-10-10): "settings that
 * still exist in Genie 2 carry over".
 *
 * v1 keeps them in `genie.db` (Electron's `userData` for the old app: `%APPDATA%\genie`), in a
 * `settings(key, value)` table, and that database runs in WAL mode — while v1 is open, a third
 * of its content can sit in the `-wal` sidecar. So the reader is SQLite itself, through the
 * `node:sqlite` builtin (not third-party: a platform module, like `node:fs`), which resolves
 * the WAL; a hand-written parser of the main file would return old values and never say so.
 *
 * Read-only, always: this migrates OUT of v1 and must not be able to touch a database the old
 * app may still have open.
 *
 * `null` means "cannot see" — no file, not a database, no `settings` table; an empty object is
 * "measured none". §5 keeps those apart everywhere, and a migration that treated a missing
 * table as "no settings" would silently start a user clean.
 *
 * What Genie 2 does with the keys is the settings surface's business (not built yet); this
 * returns every key so that decision is made there, once, against real names.
 */
/** The one way this module opens a database. Exported so a test can hold the mode, not guess it. */
export const V1_OPEN_OPTIONS = Object.freeze({ readOnly: true });

export function readV1Settings(dbFile: string): Record<string, string> | null {
    if (!existsSync(dbFile)) return null;
    let db: DatabaseSync | null = null;
    try {
        db = new DatabaseSync(dbFile, V1_OPEN_OPTIONS);
        const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get();
        if (!table) return null;
        const rows = db.prepare('SELECT key, value FROM settings').all() as { key: unknown; value: unknown }[];
        const out: Record<string, string> = {};
        for (const row of rows) {
            if (typeof row.key !== 'string') continue;
            out[row.key] = row.value === null || row.value === undefined ? '' : String(row.value);
        }
        return out;
    } catch {
        // Not a database, locked beyond reading, or a schema we do not understand: cannot see.
        return null;
    } finally {
        try { db?.close(); } catch { /* already closed or never opened */ }
    }
}
