import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
    runMigrations,
    clearDrainRoster,
    readDrainRoster,
    recordDrainRoster,
} from '../db';

/**
 * THE DRAIN ROSTER HAS TO OUTLIVE THE UPGRADE (genie#389).
 *
 * The roster is built before the restart and read after it, by a different
 * process image. In memory it would be gone at exactly the moment it is needed,
 * so it is a table — migration **v72**. (v71 is the websockets engine rename,
 * which landed on main while this was in review; 67-70 were already taken.)
 *
 * It records what was RUNNING when the drain began, and nothing else. That is
 * the whole discipline: the restore starts from this list rather than from
 * "everything configured", which is what would resurrect what the user
 * deliberately switched off (genie#407).
 */

function cols(db: Database.Database, table: string): Set<string> {
    return new Set(
        db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all().map((r) => r.name),
    );
}

const fresh = (): Database.Database => {
    const db = new Database(':memory:');
    runMigrations(db);
    return db;
};

describe('db migration v72 (the drain roster)', () => {
    it('creates the roster table', () => {
        const c = cols(fresh(), 'drain_roster');
        expect(c.has('kind')).toBe(true);
        expect(c.has('ref')).toBe(true);
        expect(c.has('label')).toBe(true);
        expect(c.has('workspace_id')).toBe(true);
        expect(c.has('recorded_at')).toBe(true);
    });

    it('is idempotent — re-running keeps a roster written before it', () => {
        const db = fresh();
        recordDrainRoster(db, [
            { kind: 'site', ref: 'ws1/web', label: 'web', workspaceId: 'ws1' },
        ]);

        expect(() => runMigrations(db)).not.toThrow();
        // A migration that recreated the table would drop the restore list of a
        // drain that is, by construction, mid-upgrade.
        expect(readDrainRoster(db)).toHaveLength(1);
    });
});

describe('the roster store', () => {
    it('reads back exactly what was recorded, in the order it was recorded', () => {
        const db = fresh();
        recordDrainRoster(db, [
            { kind: 'agent', ref: 'ws1:moic', label: 'moic', workspaceId: 'ws1' },
            { kind: 'site', ref: 'ws1/web', label: 'web', workspaceId: 'ws1' },
            { kind: 'process', ref: 'proc-queue', label: 'queue', workspaceId: 'ws1' },
        ]);

        expect(readDrainRoster(db).map((e) => [e.kind, e.ref])).toEqual([
            ['agent', 'ws1:moic'],
            ['site', 'ws1/web'],
            ['process', 'proc-queue'],
        ]);
    });

    it('REPLACES the previous roster — a stale list is a restore of the wrong set', () => {
        const db = fresh();
        recordDrainRoster(db, [
            { kind: 'site', ref: 'ws1/old', label: 'old', workspaceId: 'ws1' },
        ]);
        recordDrainRoster(db, [
            { kind: 'site', ref: 'ws1/new', label: 'new', workspaceId: 'ws1' },
        ]);

        expect(readDrainRoster(db).map((e) => e.ref)).toEqual(['ws1/new']);
    });

    it('recording NOTHING clears the roster rather than leaving the last one', () => {
        // A drain that found nothing running must not restore the previous
        // drain's list — which is a restore of things the user may since have
        // stopped, from a set they never drained.
        const db = fresh();
        recordDrainRoster(db, [
            { kind: 'site', ref: 'ws1/web', label: 'web', workspaceId: 'ws1' },
        ]);
        recordDrainRoster(db, []);
        expect(readDrainRoster(db)).toEqual([]);
    });

    it('clears once consumed, so the NEXT ordinary launch restores nothing', () => {
        const db = fresh();
        recordDrainRoster(db, [
            { kind: 'agent', ref: 'ws1:moic', label: 'moic', workspaceId: 'ws1' },
        ]);
        // POSITIVE CONTROL: the read that proves the clear did something.
        expect(readDrainRoster(db)).toHaveLength(1);

        clearDrainRoster(db);
        expect(readDrainRoster(db)).toEqual([]);
    });

    it('holds one row per (kind, ref) — a double record is not a double restart', () => {
        const db = fresh();
        recordDrainRoster(db, [
            { kind: 'site', ref: 'ws1/web', label: 'web', workspaceId: 'ws1' },
            { kind: 'site', ref: 'ws1/web', label: 'web', workspaceId: 'ws1' },
        ]);
        expect(readDrainRoster(db)).toHaveLength(1);
    });
});
