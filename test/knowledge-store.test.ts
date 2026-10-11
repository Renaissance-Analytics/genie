import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeStore, type Scope } from '../src/main/knowledge-store.js';

/**
 * THE KNOWLEDGE GRAPH (§6.7) — one LOCAL store per workstation, shared by every workspace.
 *
 * Markdown "memory" nodes; `[[wikilinks]]` in a body become edges, resolved at READ time so a
 * forward reference links up once its target exists; an ambiguous link resolves to NOTHING
 * rather than guessing. Four memory classes answer four different questions. Scope is noise
 * reduction, not a security boundary, and the test below says so in code: `all` always works.
 *
 * `node:sqlite` with FTS5 — measured available in Electron's bundled Node by the P7 probe.
 */

let dir: string;
let store: KnowledgeStore;
let clock = 1_700_000_000_000;
const now = () => new Date(clock++).toISOString();
const system: Scope = { kind: 'system' };
const tynn: Scope = { kind: 'workspace', id: 'tynn' };
const fancy: Scope = { kind: 'workspace', id: 'fancy' };

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-knowledge-'));
    store = KnowledgeStore.open(dir, now);
});

afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
});

describe('nodes', () => {
    it('adds a node and gets it back whole, with its class, tags, scope and source', () => {
        const { id } = store.add({ title: 'Redis ACL trap', body: '`--aclfile` resets the default user.', class: 'procedural', tags: ['redis', 'security'], scope: system, source: 'agent' });
        expect(id).toMatch(/^kn_/);
        const node = store.get(id);
        expect(node).toMatchObject({ id, title: 'Redis ACL trap', class: 'procedural', tags: ['redis', 'security'], scope: system, source: 'agent' });
        expect(node!.body).toContain('--aclfile');
    });

    it('defaults the class to `knowledge` and stores the body as written', () => {
        const { id } = store.add({ title: 'Plain', body: 'text', scope: tynn, source: 'user' });
        expect(store.get(id)).toMatchObject({ class: 'knowledge', body: 'text' });
    });

    it('survives a restart', () => {
        const { id } = store.add({ title: 'Durable', body: 'x', scope: system, source: 'agent' });
        store.close();
        store = KnowledgeStore.open(dir, now);
        expect(store.get(id)?.title).toBe('Durable');
    });

    it('get of an unknown id is null, never a guess', () => {
        expect(store.get('kn_nope')).toBeNull();
    });
});

describe('wikilinks are edges, resolved at read time', () => {
    it('a [[Title]] in the body links to the node with that title', () => {
        const a = store.add({ title: 'Caddy replace breaks h2 websockets', body: 'see [[Genie service ports go stale]]', scope: system, source: 'agent' });
        const b = store.add({ title: 'Genie service ports go stale', body: 'refused is not dead', scope: system, source: 'agent' });
        expect(store.get(a.id)!.links).toEqual([b.id]);
        // and the edge is visible from the other side
        expect(store.get(b.id)!.backlinks).toEqual([a.id]);
    });

    it('a FORWARD reference is reported missing, then resolves once the target exists — without re-saving', () => {
        const a = store.add({ title: 'A', body: 'needs [[B]]', scope: system, source: 'agent' });
        expect(a.unresolved).toEqual([{ ref: 'B', reason: 'missing' }]);
        expect(store.get(a.id)!.links).toEqual([]);
        const b = store.add({ title: 'B', body: '', scope: system, source: 'agent' });
        expect(store.get(a.id)!.links).toEqual([b.id]);
        expect(store.get(a.id)!.unresolved).toEqual([]);
    });

    it('an AMBIGUOUS link resolves to NOTHING, and says so', () => {
        store.add({ title: 'Setup', body: 'tynn setup', scope: tynn, source: 'agent' });
        store.add({ title: 'Setup', body: 'fancy setup', scope: fancy, source: 'agent' });
        const a = store.add({ title: 'Index', body: 'start at [[Setup]]', scope: system, source: 'agent' });
        expect(a.unresolved).toEqual([{ ref: 'Setup', reason: 'ambiguous' }]);
        // COUNTED: zero edges, not one to whichever came first.
        expect(store.get(a.id)!.links).toHaveLength(0);
    });

    it('a link by id or by slug resolves, and an explicit `links` entry is an edge too', () => {
        const target = store.add({ title: 'Target Node Here', body: '', scope: system, source: 'agent' });
        const byId = store.add({ title: 'ById', body: `[[${target.id}]]`, scope: system, source: 'agent' });
        const bySlug = store.add({ title: 'BySlug', body: '[[target-node-here]]', scope: system, source: 'agent' });
        const explicit = store.add({ title: 'Explicit', body: 'no wikilink', links: ['Target Node Here'], scope: system, source: 'agent' });
        expect(store.get(byId.id)!.links).toEqual([target.id]);
        expect(store.get(bySlug.id)!.links).toEqual([target.id]);
        expect(store.get(explicit.id)!.links).toEqual([target.id]);
    });

    it('`link` adds an edge after the fact, and refuses an unknown source', () => {
        const a = store.add({ title: 'A', body: '', scope: system, source: 'agent' });
        const b = store.add({ title: 'B', body: '', scope: system, source: 'agent' });
        expect(store.link(a.id, 'B')).toEqual({ ok: true, to: b.id });
        expect(store.get(a.id)!.links).toEqual([b.id]);
        expect(store.link('kn_nope', 'B')).toMatchObject({ ok: false });
        expect(store.link(a.id, 'Nobody')).toEqual({ ok: false, reason: 'missing' });
    });
});

describe('search — keyword, ranked, FTS5', () => {
    beforeEach(() => {
        store.add({ title: 'Caddy replace kills WebSockets over h2', body: 'the replace handler buffers the upgrade', tags: ['caddy', 'hosting'], scope: system, source: 'agent' });
        store.add({ title: 'Herd on Windows', body: 'composer is a phar under Herd', tags: ['php'], scope: tynn, source: 'agent' });
        store.add({ title: 'Owner prefers Fancy components', body: 'never hand-roll a modal', class: 'profile', tags: ['ux'], scope: system, source: 'user' });
        store.add({ title: 'Caddy config in fancy', body: 'the fancy site uses caddy too', tags: ['caddy'], scope: fancy, source: 'agent' });
    });

    it('finds by a word in the title or body, with a snippet and a positive score', () => {
        const r = store.search({ query: 'caddy', scopes: 'all' });
        expect(r.hits.map((h) => h.title).sort()).toEqual(['Caddy config in fancy', 'Caddy replace kills WebSockets over h2']);
        for (const h of r.hits) {
            expect(h.snippet.toLowerCase()).toContain('caddy');
            expect(h.score).toBeGreaterThan(0);
        }
    });

    it('a TITLE match outranks a body-only match', () => {
        store.add({ title: 'Herd', body: 'nothing about php here', scope: system, source: 'agent' });
        const r = store.search({ query: 'herd', scopes: 'all' });
        // "Herd" (title) before "Herd on Windows" (title, longer) before a body-only mention.
        store.add({ title: 'Composer notes', body: 'composer is a phar under Herd on this machine', scope: system, source: 'agent' });
        const again = store.search({ query: 'herd', scopes: 'all' });
        expect(again.hits.at(-1)!.title).toBe('Composer notes');
        expect(r.hits[0]!.title).toBe('Herd');
    });

    it('matches a PREFIX, so a half-typed word still finds the node', () => {
        expect(store.search({ query: 'websock', scopes: 'all' }).hits).toHaveLength(1);
    });

    it('a query of nothing but punctuation returns no hits rather than an FTS syntax error', () => {
        expect(store.search({ query: '"(*', scopes: 'all' }).hits).toEqual([]);
    });

    it('`class` restricts to ONE kind, because "what does the user prefer" and "find the section" are different questions', () => {
        expect(store.search({ query: 'fancy', scopes: 'all', class: 'profile' }).hits.map((h) => h.title)).toEqual(['Owner prefers Fancy components']);
        expect(store.search({ query: 'fancy', scopes: 'all', class: 'knowledge' }).hits.map((h) => h.title)).toEqual(['Caddy config in fancy']);
    });

    it('`tags` requires ALL of them', () => {
        expect(store.search({ query: 'caddy', scopes: 'all', tags: ['caddy', 'hosting'] }).hits).toHaveLength(1);
        expect(store.search({ query: 'caddy', scopes: 'all', tags: ['caddy'] }).hits).toHaveLength(2);
        expect(store.search({ query: 'caddy', scopes: 'all', tags: ['caddy', 'php'] }).hits).toHaveLength(0);
    });

    it('scope narrows to system + the named workspace by default, and `all` always covers everything', () => {
        expect(store.search({ query: 'caddy', scopes: [system, tynn] }).hits.map((h) => h.title)).toEqual(['Caddy replace kills WebSockets over h2']);
        expect(store.search({ query: 'caddy', scopes: [system, fancy] }).hits).toHaveLength(2);
        // NOT A SECURITY BOUNDARY: every caller may ask for all, and gets all.
        expect(store.search({ query: 'caddy', scopes: 'all' }).hits).toHaveLength(2);
    });

    it('pages with a cursor, and the last page says so with null', () => {
        const p1 = store.search({ query: 'caddy', scopes: 'all', limit: 1 });
        expect(p1.hits).toHaveLength(1);
        expect(p1.nextCursor).not.toBeNull();
        const p2 = store.search({ query: 'caddy', scopes: 'all', limit: 1, cursor: p1.nextCursor! });
        expect(p2.hits).toHaveLength(1);
        expect(p2.hits[0]!.id).not.toBe(p1.hits[0]!.id);
        expect(p2.nextCursor).toBeNull();
    });
});

describe('list — the EPISODIC question, which has no query string', () => {
    it('returns the most recent first, filtered by class and tag, paged', () => {
        store.add({ title: 'older', body: '', class: 'episodic', tags: ['run'], scope: tynn, source: 'agent' });
        store.add({ title: 'newer', body: '', class: 'episodic', tags: ['run'], scope: tynn, source: 'agent' });
        store.add({ title: 'other class', body: '', class: 'knowledge', tags: ['run'], scope: tynn, source: 'agent' });

        const r = store.list({ scopes: [tynn], class: 'episodic' });
        expect(r.nodes.map((n) => n.title)).toEqual(['newer', 'older']);
        expect(store.list({ scopes: [tynn], tag: 'run' }).nodes).toHaveLength(3);
        const p1 = store.list({ scopes: [tynn], limit: 2 });
        expect(p1.nextCursor).not.toBeNull();
        expect(store.list({ scopes: [tynn], limit: 2, cursor: p1.nextCursor! }).nodes).toHaveLength(1);
    });
});

describe('update and delete', () => {
    it('an edit to the body recomputes its wiki edges and leaves explicit ones alone', () => {
        const b = store.add({ title: 'B', body: '', scope: system, source: 'agent' });
        const c = store.add({ title: 'C', body: '', scope: system, source: 'agent' });
        const a = store.add({ title: 'A', body: 'see [[B]]', links: ['C'], scope: system, source: 'agent' });
        expect([...store.get(a.id)!.links].sort()).toEqual([b.id, c.id].sort());
        store.update(a.id, { body: 'nothing linked now' });
        expect(store.get(a.id)!.links).toEqual([c.id]);
    });

    it('delete removes the node and the edges that pointed at it; the pointing node reports the link as missing', () => {
        const b = store.add({ title: 'B', body: '', scope: system, source: 'agent' });
        const a = store.add({ title: 'A', body: 'see [[B]]', scope: system, source: 'agent' });
        expect(store.remove(b.id)).toBe(true);
        expect(store.get(b.id)).toBeNull();
        expect(store.get(a.id)!.links).toEqual([]);
        expect(store.get(a.id)!.unresolved).toEqual([{ ref: 'B', reason: 'missing' }]);
        expect(store.remove(b.id)).toBe(false);
    });
});
