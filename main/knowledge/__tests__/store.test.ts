import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../db';
import { KnowledgeStore } from '../store';
import { parseWikilinks, slugify } from '../types';

/**
 * Store tests run against a REAL better-sqlite3 `:memory:` db (per vitest.config)
 * with the actual migrations applied — so the FTS5 index, the edge cascade, and
 * the JSON tag filter are exercised end to end, not mocked.
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

describe('KnowledgeStore — CRUD', () => {
    it('adds and gets a node with tags + timestamps', () => {
        const node = store.add({
            title: 'First memory',
            body: 'Hello world',
            tags: ['alpha', 'Beta', 'alpha'], // de-duped case-insensitively
            source: 'user',
        });
        expect(node.id).toBeTruthy();
        expect(node.title).toBe('First memory');
        expect(node.body).toBe('Hello world');
        expect(node.tags).toEqual(['alpha', 'Beta']);
        expect(node.source).toBe('user');
        expect(node.links).toEqual([]);
        expect(node.createdAt).toBeGreaterThan(0);
        expect(node.updatedAt).toBe(node.createdAt);

        const got = store.get(node.id);
        expect(got?.title).toBe('First memory');
    });

    it('stamps source agent vs user', () => {
        const a = store.add({ title: 'A', source: 'agent' });
        const u = store.add({ title: 'U', source: 'user' });
        expect(store.get(a.id)?.source).toBe('agent');
        expect(store.get(u.id)?.source).toBe('user');
    });

    it('updates only the provided fields and bumps updatedAt', () => {
        const node = store.add({ title: 'Old', body: 'body', tags: ['x'], source: 'user' });
        const updated = store.update(node.id, { title: 'New title' });
        expect(updated?.title).toBe('New title');
        expect(updated?.body).toBe('body'); // untouched
        expect(updated?.tags).toEqual(['x']); // untouched
        expect(updated!.updatedAt).toBeGreaterThanOrEqual(node.updatedAt);
    });

    it('returns null updating an unknown node', () => {
        expect(store.update('nope', { title: 'x' })).toBeNull();
    });

    it('deletes a node', () => {
        const node = store.add({ title: 'Doomed', source: 'user' });
        expect(store.delete(node.id)).toEqual({ ok: true });
        expect(store.get(node.id)).toBeNull();
        expect(store.delete(node.id)).toEqual({ ok: false }); // already gone
    });
});

describe('KnowledgeStore — wikilinks → edges', () => {
    it('parses [[wikilink]] targets from a body (pure helper)', () => {
        expect(parseWikilinks('see [[Foo]] and [[Bar Baz|alias]] and [[Foo]]')).toEqual([
            'Foo',
            'Bar Baz',
        ]);
    });

    it('resolves a wikilink to an existing node id (by title, case-insensitive)', () => {
        const target = store.add({ title: 'Target Node', source: 'user' });
        const source = store.add({
            title: 'Source',
            body: 'links to [[target node]]',
            source: 'user',
        });
        expect(store.get(source.id)?.links).toEqual([target.id]);
    });

    it('resolves a FORWARD reference once the target is later created', () => {
        const source = store.add({
            title: 'Source',
            body: 'points at [[Future]]',
            source: 'user',
        });
        // Target doesn't exist yet → no resolved link.
        expect(store.get(source.id)?.links).toEqual([]);
        const future = store.add({ title: 'Future', source: 'user' });
        // Now the earlier wikilink resolves — edges resolve at read time.
        expect(store.get(source.id)?.links).toEqual([future.id]);
    });

    it('resolves explicit links by id, title, or slug', () => {
        const a = store.add({ title: 'Node A', source: 'user' });
        const b = store.add({ title: 'Node B', source: 'user' });
        const c = store.add({ title: 'Node C', source: 'user' });
        const n = store.add({
            title: 'Linker',
            source: 'user',
            links: [a.id, 'Node B', slugify('Node C')],
        });
        expect(store.get(n.id)?.links.sort()).toEqual([a.id, b.id, c.id].sort());
    });

    it('recomputes wiki edges on a body update but keeps explicit links', () => {
        const x = store.add({ title: 'X', source: 'user' });
        const y = store.add({ title: 'Y', source: 'user' });
        const n = store.add({
            title: 'N',
            body: 'see [[X]]',
            links: [y.id],
            source: 'user',
        });
        expect(store.get(n.id)?.links.sort()).toEqual([x.id, y.id].sort());

        // Body no longer references X → wiki edge drops; explicit Y stays.
        store.update(n.id, { body: 'nothing here' });
        expect(store.get(n.id)?.links).toEqual([y.id]);
    });

    it('replaces explicit links on a links update but keeps wiki edges', () => {
        const x = store.add({ title: 'X', source: 'user' });
        const y = store.add({ title: 'Y', source: 'user' });
        const z = store.add({ title: 'Z', source: 'user' });
        const n = store.add({ title: 'N', body: 'see [[X]]', links: [y.id], source: 'user' });
        store.update(n.id, { links: [z.id] });
        expect(store.get(n.id)?.links.sort()).toEqual([x.id, z.id].sort());
    });

    it('drops a deleted node from inbound links', () => {
        const target = store.add({ title: 'Target', source: 'user' });
        const source = store.add({ title: 'Source', body: '[[Target]]', source: 'user' });
        expect(store.get(source.id)?.links).toEqual([target.id]);
        store.delete(target.id);
        expect(store.get(source.id)?.links).toEqual([]);
    });

    it('adds an explicit edge via link()', () => {
        const a = store.add({ title: 'A', source: 'user' });
        const b = store.add({ title: 'B', source: 'user' });
        expect(store.link(a.id, b.id)).toEqual({ ok: true });
        expect(store.get(a.id)?.links).toEqual([b.id]);
        // Unknown source is rejected.
        expect(store.link('ghost', b.id).ok).toBe(false);
    });

    it('never self-links', () => {
        const a = store.add({ title: 'Self', body: 'I mention [[Self]]', source: 'user' });
        expect(store.get(a.id)?.links).toEqual([]);
    });
});

describe('KnowledgeStore — graph', () => {
    it('returns every node + every resolved edge', () => {
        const a = store.add({ title: 'A', body: 'to [[B]]', source: 'user' });
        const b = store.add({ title: 'B', body: 'to [[C]]', source: 'user' });
        const c = store.add({ title: 'C', source: 'user' });
        const g = store.graph();
        expect(g.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id, c.id].sort());
        expect(g.edges).toContainEqual({ source: a.id, target: b.id });
        expect(g.edges).toContainEqual({ source: b.id, target: c.id });
        expect(g.edges.length).toBe(2);
    });
});

describe('KnowledgeStore — list', () => {
    it('lists newest-first and honours the tag filter + limit', () => {
        const a = store.add({ title: 'A', tags: ['red'], source: 'user' });
        const b = store.add({ title: 'B', tags: ['blue'], source: 'user' });
        const c = store.add({ title: 'C', tags: ['red', 'blue'], source: 'user' });

        const all = store.list();
        expect(all.map((n) => n.id)).toEqual([c.id, b.id, a.id]); // newest first

        const red = store.list({ tag: 'RED' }); // case-insensitive
        expect(red.map((n) => n.id).sort()).toEqual([a.id, c.id].sort());

        expect(store.list({ limit: 1 })).toHaveLength(1);
    });
});

describe('KnowledgeStore — search (FTS keyword floor)', () => {
    it('finds nodes by title, body, and tags', () => {
        const t = store.add({ title: 'Deployment runbook', body: 'restart the server', source: 'user' });
        store.add({ title: 'Unrelated', body: 'lorem ipsum', source: 'user' });
        const byTitle = store.search({ query: 'deployment' });
        expect(byTitle.map((r) => r.id)).toContain(t.id);
        const byBody = store.search({ query: 'restart' });
        expect(byBody.map((r) => r.id)).toContain(t.id);
    });

    it('matches on a prefix and returns a snippet + score', () => {
        const t = store.add({ title: 'Kubernetes', body: 'orchestrates containers', source: 'user' });
        const hits = store.search({ query: 'kube' }); // prefix
        expect(hits.map((h) => h.id)).toContain(t.id);
        const hit = hits.find((h) => h.id === t.id)!;
        expect(typeof hit.score).toBe('number');
        expect(hit.title).toBe('Kubernetes');
        expect(hit.snippet.length).toBeGreaterThan(0);
    });

    it('ranks a title+body match above a single-field match', () => {
        const strong = store.add({ title: 'alpha alpha', body: 'alpha alpha alpha', source: 'user' });
        const weak = store.add({ title: 'other', body: 'alpha once', source: 'user' });
        const hits = store.search({ query: 'alpha' });
        const ids = hits.map((h) => h.id);
        expect(ids.indexOf(strong.id)).toBeLessThan(ids.indexOf(weak.id));
    });

    it('narrows hits to nodes carrying ALL requested tags', () => {
        const both = store.add({ title: 'match one', tags: ['ops', 'urgent'], source: 'user' });
        store.add({ title: 'match two', tags: ['ops'], source: 'user' });
        const hits = store.search({ query: 'match', tags: ['ops', 'urgent'] });
        expect(hits.map((h) => h.id)).toEqual([both.id]);
    });

    it('falls back to a LIKE scan when the query has no indexable terms', () => {
        const t = store.add({ title: 'C++ pointers', body: 'memory notes', source: 'user' });
        // "++" tokenizes to nothing for FTS → LIKE fallback on the raw substring.
        const hits = store.search({ query: '++' });
        expect(hits.map((h) => h.id)).toContain(t.id);
    });

    it('keeps FTS in sync across an update', () => {
        const t = store.add({ title: 'original', body: 'first', source: 'user' });
        store.update(t.id, { body: 'replaced keyword zebra' });
        expect(store.search({ query: 'zebra' }).map((h) => h.id)).toContain(t.id);
        expect(store.search({ query: 'first' }).map((h) => h.id)).not.toContain(t.id);
    });

    it('drops a deleted node from search', () => {
        const t = store.add({ title: 'ephemeral', source: 'user' });
        store.delete(t.id);
        expect(store.search({ query: 'ephemeral' })).toHaveLength(0);
    });
});

describe('KnowledgeStore — change events', () => {
    it('emits on add / update / delete / link', () => {
        const spy = vi.fn();
        store.setEmitter(spy);
        const a = store.add({ title: 'A', source: 'user' });
        const b = store.add({ title: 'B', source: 'user' });
        store.update(a.id, { title: 'A2' });
        store.link(a.id, b.id);
        store.delete(a.id);
        const actions = spy.mock.calls.map((c) => c[0].action);
        expect(actions).toEqual(['add', 'add', 'update', 'link', 'delete']);
    });
});
