import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db';

/**
 * v75 — a pending ForceTheQuestion survives a restart.
 *
 * ## What was true before this
 *
 * The pending-question queue was an in-memory array in `main/ask/force-question.ts`
 * and nothing else. An upgrade, a crash, or a killed process took every pending
 * question with it. The agent that asked was left waiting on an answer that could
 * never arrive, and the human never learned a question had existed at all. Genie
 * upgrades constantly, so this fired often.
 *
 * ## Why a table and not a settings blob
 *
 * `ask_drafts` — the part-typed ANSWERS — lives in a settings row, and that is
 * right for it: it is one small map, read and rewritten whole. A pending question
 * is looked up by two different keys (its id, and the re-attach key), pruned by a
 * third (its terminal), and must not lose the whole set when one row is malformed.
 *
 * ## `ask_key` is UNIQUE, and that is the re-attach guarantee
 *
 * The key is derived from (terminalId + question content) — never supplied by the
 * agent (see `main/ask/ask-key.ts`). The UNIQUE constraint is what makes a
 * reconnecting agent's re-ask land on the row it already has instead of raising a
 * second question the human would see as a duplicate.
 */

function tables(d: Database.Database): Set<string> {
    return new Set(
        d
            .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
            .all()
            .map((r) => r.name),
    );
}

function columns(d: Database.Database, table: string): Map<string, { notnull: number }> {
    return new Map(
        d
            .prepare<[], { name: string; notnull: number }>(`PRAGMA table_info(${table})`)
            .all()
            .map((r) => [r.name, { notnull: r.notnull }]),
    );
}

describe('v75 — the pending_questions table', () => {
    it('does not exist before v75 (positive control: the db is otherwise migrated)', () => {
        const d = new Database(':memory:');
        runMigrations(d, { upTo: 74 });
        const t = tables(d);
        expect(t.has('pending_questions')).toBe(false);
        // The negative above would also pass against an empty database, so pin
        // that the migrations really did run up to 74.
        expect(t.has('terminal_specs')).toBe(true);
    });

    it('creates the table with the columns a question has to be rebuilt from', () => {
        const d = new Database(':memory:');
        runMigrations(d);
        const c = columns(d, 'pending_questions');
        for (const name of [
            'id',
            'ask_key',
            'terminal_id',
            'questions_json',
            'workspace_id',
            'workspace_label',
            'workspace_path',
            'priority',
            'deferred',
            'created_at',
        ]) {
            expect(c.has(name), `pending_questions.${name}`).toBe(true);
        }
        // A row that cannot say WHO asked it cannot be delivered back to anyone,
        // so the two identity columns are NOT NULL rather than best-effort.
        expect(c.get('ask_key')?.notnull).toBe(1);
        expect(c.get('terminal_id')?.notnull).toBe(1);
    });

    it('refuses a second row with the same ask_key — the re-attach guarantee', () => {
        const d = new Database(':memory:');
        runMigrations(d);
        const insert = d.prepare(
            `INSERT INTO pending_questions
               (id, ask_key, terminal_id, questions_json, deferred, created_at)
             VALUES (?, ?, ?, ?, 0, ?)`,
        );
        insert.run('q1', 'KEY-A', 'T1', '[]', 1000);
        expect(() => insert.run('q2', 'KEY-A', 'T1', '[]', 2000)).toThrow(/UNIQUE/i);
        // Positive control: a DIFFERENT key is still perfectly insertable, so the
        // constraint is rejecting duplicates and not simply rejecting everything.
        expect(() => insert.run('q2', 'KEY-B', 'T1', '[]', 2000)).not.toThrow();
    });

    it('is idempotent — re-running converges without throwing', () => {
        const d = new Database(':memory:');
        runMigrations(d);
        expect(() => runMigrations(d)).not.toThrow();
        expect(tables(d).has('pending_questions')).toBe(true);
    });

    it('replays cleanly when the suite rewinds schema_version', () => {
        // The migration suite rewinds `schema_version` and replays the tail; a
        // CREATE without IF NOT EXISTS took 36 tests down at v47.
        const d = new Database(':memory:');
        runMigrations(d);
        d.prepare('DELETE FROM schema_version WHERE version = 75').run();
        expect(() => runMigrations(d)).not.toThrow();
    });
});
