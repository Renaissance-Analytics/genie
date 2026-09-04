import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../db';
import { KnowledgeStore } from '../store';

/**
 * The store side of the namespaced resolver (spec §4.5) — the ladder itself is
 * pinned pure in `resolve.test.ts`; what is at stake here is that the store
 * actually uses it, and that a link it cannot resolve is REPORTED rather than
 * swallowed.
 *
 * A silent mis-link is the failure the rule exists to prevent. A silent NON-link
 * would be the same fault wearing the fix's clothes, so `unresolved[]` rides
 * beside `links` on every node the store hands back.
 */
let db: Database.Database;
let store: KnowledgeStore;

beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    store = new KnowledgeStore(db);
});

afterEach(() => {
    db.close();
});

/** Mark an existing node as belonging to a pack — P1 has no installer yet, so
 *  the provenance columns are written directly, exactly as the converger will. */
function asPackNode(id: string, ns: string, key: string): void {
    db.prepare(
        `UPDATE knowledge_nodes SET origin = 'pack', origin_ns = ?, origin_key = ? WHERE id = ?`,
    ).run(ns, `${ns}/${key}`, id);
}

describe('ambiguity resolves to nothing, and says so', () => {
    it('two nodes with the same title mean the link resolves to NEITHER', () => {
        store.add({ title: 'Volume 1', body: 'first', source: 'user' });
        store.add({ title: 'Volume 1', body: 'second', source: 'user' });
        const src = store.add({ title: 'Index', body: 'see [[Volume 1]]', source: 'user' });

        // Last-row-wins used to hand back one of them, chosen by scan order.
        expect(store.get(src.id)?.links).toEqual([]);
    });

    it('reports the ambiguous ref with its candidate count', () => {
        store.add({ title: 'Volume 1', source: 'user' });
        store.add({ title: 'Volume 1', source: 'user' });
        const src = store.add({ title: 'Index', body: 'see [[Volume 1]]', source: 'user' });

        expect(store.get(src.id)?.unresolved).toEqual([
            { ref: 'Volume 1', reason: 'ambiguous', candidates: 2 },
        ]);
    });

    it('positive control — one node with that title still links, and reports nothing unresolved', () => {
        // Without this the assertions above would also pass on a store that had
        // stopped resolving links at all.
        const target = store.add({ title: 'Volume 1', source: 'user' });
        const src = store.add({ title: 'Index', body: 'see [[Volume 1]]', source: 'user' });

        const node = store.get(src.id);
        expect(node?.links).toEqual([target.id]);
        expect(node?.unresolved).toEqual([]);
    });

    it('a ref that matches nothing reads as missing — the forward-reference case', () => {
        const src = store.add({ title: 'Index', body: 'see [[Not Yet]]', source: 'user' });
        expect(store.get(src.id)?.unresolved).toEqual([
            { ref: 'Not Yet', reason: 'missing', candidates: 0 },
        ]);

        const later = store.add({ title: 'Not Yet', source: 'user' });
        expect(store.get(src.id)?.links).toEqual([later.id]);
        expect(store.get(src.id)?.unresolved).toEqual([]);
    });
});

describe('a pack’s links stay inside the pack', () => {
    it('the index node’s [[Volume 1]] finds its OWN pack’s volume', () => {
        const mine = store.add({ title: 'Volume 1', body: 'the buyer’s own', source: 'user' });
        const packVol = store.add({ title: 'Volume 1', body: 'pack A', source: 'agent' });
        asPackNode(packVol.id, 'ai.stunspot.guide', 'volume-1');
        const index = store.add({ title: 'Canon Map', body: 'see [[Volume 1]]', source: 'agent' });
        asPackNode(index.id, 'ai.stunspot.guide', 'canon-map');

        expect(store.get(index.id)?.links).toEqual([packVol.id]);
        expect(store.get(index.id)?.links).not.toContain(mine.id);
    });

    it('reaches another pack only through an explicit `pack:` ref', () => {
        const other = store.add({ title: 'Volume 1', source: 'agent' });
        asPackNode(other.id, 'ai.stunspot.guide', 'volume-1');
        const src = store.add({
            title: 'Part 2',
            body: 'as in [[pack:ai.stunspot.guide/volume-1]]',
            source: 'agent',
        });
        asPackNode(src.id, 'com.example.gamification', 'part-2');

        expect(store.get(src.id)?.links).toEqual([other.id]);
    });

    it('a bare title only ANOTHER pack has is out-of-namespace, not a link', () => {
        const other = store.add({ title: 'Volume 1', source: 'agent' });
        asPackNode(other.id, 'ai.stunspot.guide', 'volume-1');
        const src = store.add({ title: 'Part 2', body: 'see [[Volume 1]]', source: 'agent' });
        asPackNode(src.id, 'com.example.gamification', 'part-2');

        const node = store.get(src.id);
        expect(node?.links).toEqual([]);
        expect(node?.unresolved).toEqual([
            { ref: 'Volume 1', reason: 'out-of-namespace', candidates: 1 },
        ]);
    });

    it('`local:` reaches the buyer’s own note', () => {
        const mine = store.add({ title: 'Reverb', source: 'user' });
        const src = store.add({
            title: 'Volume 5',
            body: 'your own [[local:Reverb]]',
            source: 'agent',
        });
        asPackNode(src.id, 'ai.stunspot.guide', 'volume-5');

        expect(store.get(src.id)?.links).toEqual([mine.id]);
    });
});

describe('the graph view resolves the same way', () => {
    it('an ambiguous ref produces no edge', () => {
        store.add({ title: 'Volume 1', source: 'user' });
        store.add({ title: 'Volume 1', source: 'user' });
        store.add({ title: 'Index', body: 'see [[Volume 1]]', source: 'user' });

        expect(store.graph().edges).toEqual([]);
    });

    it('positive control — an unambiguous ref still produces one edge', () => {
        const target = store.add({ title: 'Volume 1', source: 'user' });
        const src = store.add({ title: 'Index', body: 'see [[Volume 1]]', source: 'user' });

        expect(store.graph().edges).toEqual([{ source: src.id, target: target.id }]);
    });
});

/**
 * The one-time link audit, as the WINDOW reads it (spec §6.5).
 *
 * The migration records every link that used to resolve by last-row-wins and now
 * resolves to nothing. A row nobody can see is the failure the audit exists to
 * prevent, one table further along — so the store exposes the unreviewed rows and
 * a way to mark them seen, and the window shows a one-time notice.
 *
 * Rows are marked reviewed, never deleted: "I dismissed it and now I want it
 * back" has to have an answer.
 */
describe('the tightened-link audit is readable and dismissable', () => {
    function record(fromId: string, toRef: string, wasId: string, candidates: number): void {
        db.prepare(
            `INSERT INTO knowledge_link_audit (from_id, to_ref, was_id, candidates)
             VALUES (?, ?, ?, ?)`,
        ).run(fromId, toRef, wasId, candidates);
    }

    it('is empty on a machine the change broke nothing on', () => {
        // The expected result almost everywhere, and the positive control for
        // every assertion below: an empty list must mean "nothing to review",
        // not "the reader is broken".
        expect(store.linkAudit()).toEqual([]);
    });

    it('reports each recorded link with what it used to point at', () => {
        const a = store.add({ title: 'Volume 1', source: 'user' });
        const b = store.add({ title: 'Volume 1', source: 'user' });
        const idx = store.add({ title: 'Index', body: 'see [[Volume 1]]', source: 'user' });
        record(idx.id, 'Volume 1', b.id, 2);

        expect(store.linkAudit()).toEqual([
            {
                fromId: idx.id,
                fromTitle: 'Index',
                toRef: 'Volume 1',
                wasId: b.id,
                wasTitle: 'Volume 1',
                candidates: 2,
            },
        ]);
        // The other "Volume 1" is a candidate, not the recorded target — the row
        // says what the OLD resolver picked, which is the thing being retired.
        expect(store.linkAudit()[0]?.wasId).not.toBe(a.id);
    });

    it('titles what it can and survives a target that has since been deleted', () => {
        const idx = store.add({ title: 'Index', source: 'user' });
        record(idx.id, 'Gone', 'deleted-node-id', 2);

        expect(store.linkAudit()[0]).toMatchObject({
            fromTitle: 'Index',
            wasTitle: null,
        });
    });

    it('dismissing marks the rows reviewed and stops reporting them', () => {
        const idx = store.add({ title: 'Index', source: 'user' });
        record(idx.id, 'Volume 1', 'somewhere', 2);
        expect(store.linkAudit()).toHaveLength(1);

        store.dismissLinkAudit();

        expect(store.linkAudit()).toEqual([]);
        // KEPT, not deleted — the notice is dismissed, the finding is not.
        expect(db.prepare('SELECT COUNT(*) n FROM knowledge_link_audit').get()).toEqual({ n: 1 });
    });
});
