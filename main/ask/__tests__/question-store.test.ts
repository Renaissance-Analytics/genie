import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations, upsertPendingQuestion } from '../../db';
import { makeQuestionStore, type PersistedQuestion } from '../question-store';
import type { ForceQuestion } from '../../mcp/protocol';

/**
 * The durable side of the pending-question queue.
 *
 * `force-question.ts` holds the live queue in memory — that is right, it is what
 * the modal reads on every keystroke. This is the mirror that lets the queue be
 * REBUILT after the process that held it goes away, which for Genie is a routine
 * event (it upgrades constantly) rather than a disaster scenario.
 *
 * Exercised against a real in-memory better-sqlite3 (the binary is not mocked),
 * because the parts that matter here — the UNIQUE re-attach key, a malformed row
 * not taking the rest of the set with it — are database behaviour, and a fake
 * would only prove the fake works.
 */

const Q = (header: string): ForceQuestion[] => [
    { header, question: `${header}?`, options: [{ label: 'Yes' }, { label: 'No' }] },
];

const row = (over: Partial<PersistedQuestion> = {}): PersistedQuestion => ({
    id: 'q1',
    askKey: 'KEY-1',
    terminalId: 'T1',
    questions: Q('Ship'),
    workspaceId: 'ws-1',
    workspaceLabel: 'Wonder',
    workspacePath: 'C:/work/wonder',
    priority: 'high',
    deferred: false,
    createdAt: 1_700_000_000_000,
    ...over,
});

describe('question store', () => {
    let db: Database.Database;
    let store: ReturnType<typeof makeQuestionStore>;

    beforeEach(() => {
        db = new Database(':memory:');
        runMigrations(db);
        store = makeQuestionStore(() => db);
    });

    it('round-trips every field a question has to be rebuilt from', () => {
        const q = row();
        store.save(q);
        expect(store.load()).toEqual([q]);
    });

    it('save is an UPSERT by id — a question that changes state does not duplicate', () => {
        store.save(row());
        // The modal could not be shown, so the same question moves to the inbox.
        store.save(row({ deferred: true, deferralReason: 'unshowable' }));
        const loaded = store.load();
        expect(loaded).toHaveLength(1);
        expect(loaded[0].deferred).toBe(true);
        expect(loaded[0].deferralReason).toBe('unshowable');
    });

    it('remove drops the row — an answered question must not come back', () => {
        store.save(row());
        store.save(row({ id: 'q2', askKey: 'KEY-2' }));
        store.remove('q1');
        // Negative half: q1 is gone. Positive control in the same assertion: q2,
        // which was NOT answered, is still there — so `remove` removed one row
        // rather than emptying the table.
        expect(store.load().map((q) => q.id)).toEqual(['q2']);
    });

    it('remove of an unknown id is a no-op, not a throw', () => {
        store.save(row());
        expect(() => store.remove('never-existed')).not.toThrow();
        expect(store.load()).toHaveLength(1);
    });

    it('rejects a second row with the same ask_key rather than storing a duplicate', () => {
        store.save(row({ id: 'q1', askKey: 'SAME' }));
        store.save(row({ id: 'q2', askKey: 'SAME' }));
        // The re-attach guarantee: one key, one question. A second id carrying a
        // key that already exists is refused — the caller is expected to have
        // rejoined the existing question instead.
        expect(store.load().map((q) => q.id)).toEqual(['q1']);
    });

    it('handles the duplicate key IN THE STATEMENT, not by swallowing an exception', () => {
        // The assertion above cannot tell the two apart: `save` catches, so a
        // constraint violation and a deliberate no-op look identical from
        // outside. Asserted one layer down, where a throw is visible, because a
        // write that only "works" because its error is discarded is a write
        // nobody will notice breaking.
        const rec = {
            id: 'a',
            ask_key: 'DUP',
            terminal_id: 'T1',
            questions_json: '[{"header":"H"}]',
            workspace_id: null,
            workspace_label: null,
            workspace_path: null,
            priority: null,
            deferred: 0,
            deferral_reason: null,
            created_at: 1,
        };
        upsertPendingQuestion(db, rec);
        expect(() => upsertPendingQuestion(db, { ...rec, id: 'b' })).not.toThrow();
        expect(store.load().map((q) => q.id)).toEqual(['a']);
    });

    it('drops a single unreadable row instead of losing the whole set', () => {
        store.save(row({ id: 'good', askKey: 'K-GOOD' }));
        db.prepare(
            `INSERT INTO pending_questions
               (id, ask_key, terminal_id, questions_json, deferred, created_at)
             VALUES ('bad', 'K-BAD', 'T1', 'not json{', 0, 1)`,
        ).run();
        const loaded = store.load();
        // The bad row is skipped, and the good one still loads — a corrupted
        // question must cost its own row, never the queue.
        expect(loaded.map((q) => q.id)).toEqual(['good']);
    });

    it('never throws when the database is unavailable — a question outranks its backup', () => {
        // Every call site is on the path that RAISES a question. Losing the
        // durable copy is bad; failing to ask the user is worse.
        const broken = makeQuestionStore(() => {
            throw new Error('Database not initialised. Call initDatabase().');
        });
        expect(() => broken.save(row())).not.toThrow();
        expect(() => broken.remove('q1')).not.toThrow();
        expect(broken.load()).toEqual([]);
    });

    it('loads oldest first, so a rebuilt queue keeps its arrival order', () => {
        store.save(row({ id: 'later', askKey: 'K2', createdAt: 2000 }));
        store.save(row({ id: 'earlier', askKey: 'K1', createdAt: 1000 }));
        expect(store.load().map((q) => q.id)).toEqual(['earlier', 'later']);
    });
});
