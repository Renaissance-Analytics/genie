import { DatabaseSync } from 'node:sqlite';

/**
 * A SQLite database a TEST builds as its fixture (Genie 1's `genie.db`, invented rows) — written the way a fixture
 * needs, not the way the product's own data needs (B13).
 *
 * - `synchronous = OFF`: a fixture has no power cut to survive, so its commits are not synced to disk. Every row the
 *   test wrote is still in the file (or the WAL) for the reader under test — SQLite hands the bytes to the OS either
 *   way; OFF only skips the wait for the disk.
 * - One transaction for the whole build (`inOneTransaction`), not a commit per statement.
 *
 * Counted cost of NOT doing this: v1-schedules' `writeV1` was 23 autocommits in rollback-journal mode — roughly three
 * syncs each, ~70 per call, ~9 calls a file — and a sync under a parallel suite waits behind every other write on the
 * machine. Its tests timed out in 1 run of 3, never alone. What the readers are tested FOR (read-only opens, rows still
 * in the WAL, the bytes unchanged) does not depend on the fixture's durability, so nothing they assert changes.
 */
export function openFixtureDb(file: string): DatabaseSync {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA synchronous = OFF');
    return db;
}

/** Runs `build` as ONE transaction on `db`; rolled back (and rethrown) when it throws. */
export function inOneTransaction(db: DatabaseSync, build: () => void): void {
    db.exec('BEGIN');
    try {
        build();
        db.exec('COMMIT');
    } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* the error already ended it */ }
        throw error;
    }
}
