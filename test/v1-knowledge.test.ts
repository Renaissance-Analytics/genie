import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planV1KnowledgeImport, type V1Knowledge } from '../src/core/v1-import.js';
import { KnowledgeStore } from '../src/main/knowledge-store.js';
import { readV1Knowledge } from '../src/main/v1-import.js';

/**
 * IMPORTING GENIE 1's KNOWLEDGE GRAPH. v1 kept its memories in `genie.db` (`knowledge_nodes`,
 * `knowledge_edges`); Genie 2 keeps them in `~/.genie/runtime/knowledge.db`. The planner is pure; the
 * reader opens a database built here with v1's REAL `CREATE TABLE` statements (copied from a v1
 * `genie.db`); the values are invented.
 */

const v1Nodes = `CREATE TABLE knowledge_nodes ( id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', slug TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('agent', 'user')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL , class TEXT NOT NULL DEFAULT 'knowledge', scope_kind TEXT NOT NULL DEFAULT 'system', scope_ref TEXT, origin TEXT NOT NULL DEFAULT 'local', origin_key TEXT, origin_ns TEXT CHECK (origin_ns IS NULL OR (origin_key IS NOT NULL AND origin_key LIKE origin_ns || '/%')), origin_revision INTEGER, origin_hash TEXT, role TEXT NOT NULL DEFAULT 'part', sort_order INTEGER NOT NULL DEFAULT 0, pending_revision INTEGER, pending_body TEXT, pending_hash TEXT)`;
const v1Edges = `CREATE TABLE knowledge_edges ( from_id TEXT NOT NULL, to_ref TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'wiki' CHECK (kind IN ('wiki', 'explicit')), PRIMARY KEY (from_id, to_ref, kind), FOREIGN KEY (from_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE )`;

const node = (over: Partial<V1Knowledge['nodes'][number]> = {}): V1Knowledge['nodes'][number] => ({
    id: 'n1', title: 'A note', body: '', tags: '[]', source: 'agent', class: 'knowledge', scopeKind: 'system', scopeRef: null, createdAt: Date.UTC(2026, 0, 2), updatedAt: Date.UTC(2026, 0, 3), ...over,
});

describe('planV1KnowledgeImport', () => {
    it('cannot-see stays null: nothing is planned and nothing is claimed', () => {
        expect(planV1KnowledgeImport(null)).toBeNull();
    });

    it('maps a node faithfully: id kept, epoch-ms times become ISO, tags parse from JSON, class and source carried, edges attached to their node', () => {
        const plan = planV1KnowledgeImport({
            nodes: [node({ id: 'n1', title: 'Ports', body: 'See [[Other]].', tags: '["a","b"]', class: 'episodic', source: 'user' }), node({ id: 'n2', title: 'Other' })],
            edges: [{ fromId: 'n1', toRef: 'Other', kind: 'wiki' }, { fromId: 'n1', toRef: 'n2', kind: 'explicit' }],
        })!;
        expect(plan.nodes[0]).toEqual({
            id: 'n1', title: 'Ports', body: 'See [[Other]].', class: 'episodic', tags: ['a', 'b'], scope: { kind: 'system' }, source: 'user',
            createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z',
            edges: [{ toRef: 'Other', kind: 'wiki' }, { toRef: 'n2', kind: 'explicit' }],
        });
        expect(plan.nodes[1]!.edges).toEqual([]);
        expect(plan.notes).toEqual([]);
    });

    it("scope: system stays system; a workspace keeps v1's id (the workspace import keeps v1 ids); v1's __system__ workspace becomes this machine; gapp is carried; anything else is this machine, said", () => {
        const plan = planV1KnowledgeImport({
            nodes: [
                node({ id: 's', scopeKind: 'system' }),
                node({ id: 'w', scopeKind: 'workspace', scopeRef: '01k95ewyzkvkbxtpdt8b3qvyqk' }),
                node({ id: 'osa', scopeKind: 'workspace', scopeRef: '__system__' }),
                node({ id: 'g', scopeKind: 'gapp', scopeRef: 'example-gapp' }),
                node({ id: 'noref', scopeKind: 'workspace', scopeRef: null }),
                node({ id: 'odd', scopeKind: 'team', scopeRef: 'x' }),
            ],
            edges: [],
        })!;
        expect(plan.nodes.map((n) => [n.id, n.scope])).toEqual([
            ['s', { kind: 'system' }],
            ['w', { kind: 'workspace', id: '01k95ewyzkvkbxtpdt8b3qvyqk' }],
            ['osa', { kind: 'system' }],
            ['g', { kind: 'gapp', id: 'example-gapp' }],
            ['noref', { kind: 'system' }],
            ['odd', { kind: 'system' }],
        ]);
        expect(plan.notes).toContainEqual(expect.stringMatching(/node noref: workspace scope without a workspace id/));
        expect(plan.notes).toContainEqual(expect.stringMatching(/node odd: scope "team"/));
        // __system__ → system is the rule, not a problem: not a note.
        expect(plan.notes.some((n) => n.startsWith('node osa'))).toBe(false);
    });

    it('what v1 could hold and Genie 2 cannot is mapped to the nearest and SAID, never swallowed: an unknown class, unreadable tags, an unknown source', () => {
        const plan = planV1KnowledgeImport({
            nodes: [node({ id: 'c', class: 'reference' }), node({ id: 't', tags: 'not json' }), node({ id: 'u', tags: '["ok", 7, null]' }), node({ id: 'src', source: 'robot' })],
            edges: [],
        })!;
        expect(plan.nodes.map((n) => [n.id, n.class, n.tags, n.source])).toEqual([
            ['c', 'knowledge', [], 'agent'],
            ['t', 'knowledge', [], 'agent'],
            ['u', 'knowledge', ['ok'], 'agent'],
            ['src', 'knowledge', [], 'agent'],
        ]);
        expect(plan.notes).toContainEqual(expect.stringMatching(/node c: class "reference" .*imported as knowledge/));
        expect(plan.notes).toContainEqual(expect.stringMatching(/node t: tags were not readable/));
        expect(plan.notes).toContainEqual(expect.stringMatching(/node src: source "robot"/));
    });

    it('a row without an id is dropped and said; an edge from a node that is not imported, or of a kind Genie 2 does not have, is dropped and said', () => {
        const plan = planV1KnowledgeImport({
            nodes: [node({ id: '' }), node({ id: 'keep' })],
            edges: [{ fromId: 'ghost', toRef: 'keep', kind: 'wiki' }, { fromId: 'keep', toRef: 'x', kind: 'mention' }, { fromId: 'keep', toRef: 'y', kind: 'explicit' }],
        })!;
        expect(plan.nodes.map((n) => n.id)).toEqual(['keep']);
        expect(plan.nodes[0]!.edges).toEqual([{ toRef: 'y', kind: 'explicit' }]);
        expect(plan.notes).toContainEqual(expect.stringMatching(/a node without an id/));
        expect(plan.notes).toContainEqual(expect.stringMatching(/edge ghost → keep: its node was not imported/));
        expect(plan.notes).toContainEqual(expect.stringMatching(/edge keep → x: kind "mention"/));
    });
});

describe('readV1Knowledge', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'genie2-v1-knowledge-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

    it("reads nodes and edges from a database with v1's real schema — and leaves the file exactly as it was", () => {
        const file = join(dir, 'genie.db');
        const db = new DatabaseSync(file);
        db.exec(v1Nodes);
        db.exec(v1Edges);
        const ins = db.prepare('INSERT INTO knowledge_nodes (id, title, slug, body, tags, source, created_at, updated_at, class, scope_kind, scope_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        ins.run('n-older', 'Older', 'older', 'body one [[Newer]]', '["x"]', 'user', 1000, 2000, 'procedural', 'workspace', 'ws-1');
        ins.run('n-newer', 'Newer', 'newer', 'body two', '[]', 'agent', 3000, 4000, 'knowledge', 'system', null);
        db.prepare('INSERT INTO knowledge_edges (from_id, to_ref, kind) VALUES (?, ?, ?)').run('n-older', 'Newer', 'wiki');
        db.prepare('INSERT INTO knowledge_edges (from_id, to_ref, kind) VALUES (?, ?, ?)').run('n-newer', 'n-older', 'explicit');
        db.close();
        const md5 = () => createHash('md5').update(readFileSync(file)).digest('hex');
        const before = md5();
        expect(readV1Knowledge(file)).toEqual({
            nodes: [
                { id: 'n-older', title: 'Older', body: 'body one [[Newer]]', tags: '["x"]', source: 'user', class: 'procedural', scopeKind: 'workspace', scopeRef: 'ws-1', createdAt: 1000, updatedAt: 2000 },
                { id: 'n-newer', title: 'Newer', body: 'body two', tags: '[]', source: 'agent', class: 'knowledge', scopeKind: 'system', scopeRef: null, createdAt: 3000, updatedAt: 4000 },
            ],
            edges: [
                { fromId: 'n-older', toRef: 'Newer', kind: 'wiki' },
                { fromId: 'n-newer', toRef: 'n-older', kind: 'explicit' },
            ],
        });
        expect(md5()).toBe(before);
    });

    it('cannot-see is null: no file, or a database without knowledge_nodes; the tables with no rows is an empty graph', () => {
        expect(readV1Knowledge(join(dir, 'missing.db'))).toBeNull();
        const bare = join(dir, 'bare.db');
        const db = new DatabaseSync(bare);
        db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
        db.close();
        expect(readV1Knowledge(bare)).toBeNull();
        const empty = join(dir, 'empty.db');
        const db2 = new DatabaseSync(empty);
        db2.exec(v1Nodes);
        db2.exec(v1Edges);
        db2.close();
        expect(readV1Knowledge(empty)).toEqual({ nodes: [], edges: [] });
    });
});

describe('KnowledgeStore.importFromV1', () => {
    let dir: string;
    let store: KnowledgeStore;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'genie2-v1-knowledge-store-')); store = KnowledgeStore.open(dir, () => '2026-10-14T00:00:00.000Z'); });
    afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

    const plan = (nodes: V1Knowledge['nodes'], edges: V1Knowledge['edges'] = []) => planV1KnowledgeImport({ nodes, edges });

    it('records what it did in the store itself, and a second call is a no-op that says so', () => {
        expect(store.v1Import()).toBeNull();
        expect(store.importFromV1(plan([node({ id: 'n1' }), node({ id: 'n2', class: 'oops' })]))).toEqual({ imported: 2, kept: 0 });
        expect(store.v1Import()).toMatchObject({ sawV1: true, imported: 2, kept: 0, notes: [expect.stringMatching(/node n2: class "oops"/)] });
        expect(store.importFromV1(plan([node({ id: 'n3' })]))).toEqual({ imported: 0, kept: 0, alreadyDone: true });
        expect(store.list({ scopes: 'all' }).nodes.map((n) => n.id).sort()).toEqual(['n1', 'n2']);
    });

    it('a blind call (cannot see v1) is recorded as provisional and does not spend the import', () => {
        expect(store.importFromV1(null)).toEqual({ imported: 0, kept: 0, noV1: true });
        expect(store.v1Import()).toMatchObject({ sawV1: false, imported: 0 });
        expect(store.importFromV1(plan([node({ id: 'n1' })]))).toEqual({ imported: 1, kept: 0 });
    });

    it('a node whose id is already in the store is left exactly as it is — never overwritten', () => {
        const twice = plan([node({ id: 'same', title: 'First', body: 'kept' }), node({ id: 'same', title: 'Second', body: 'must not replace' })]);
        expect(store.importFromV1(twice)).toEqual({ imported: 1, kept: 1 });
        expect(store.get('same')).toMatchObject({ title: 'First', body: 'kept' });
        expect(store.search({ query: 'replace', scopes: 'all' }).hits).toEqual([]);
    });
});
