import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../db';
import { KnowledgeStore } from '../store';

/**
 * SCOPE on a knowledge node (spec §4.2) — `system | workspace | gapp`.
 *
 * SCOPE IS NOISE REDUCTION IN AGENT REASONING. IT IS NOT A SECURITY BOUNDARY.
 * Any caller may ask for every node on the machine and the store must not refuse
 * it. That is asserted here deliberately, and it is the test that stops the
 * design calcifying into a security assumption somebody later builds on.
 *
 * The other thing pinned here is WHERE the filtering happens. Class and tags were
 * filtered in JavaScript after FTS returned `max(limit*5, 50)` candidates. Adding
 * scope to that post-filter would STARVE results: a workspace-scoped agent on a
 * machine holding thousands of system nodes gets an empty page while matches
 * exist. Scope and class are therefore in the SQL `WHERE`, and the starvation
 * cases below fail loudly if either drifts back out of it.
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

describe('a node carries a scope', () => {
    it('defaults to system when nothing says otherwise', () => {
        const n = store.add({ title: 'Anywhere', source: 'user' });
        expect(n.scope).toEqual({ kind: 'system' });
    });

    it('round-trips a workspace scope', () => {
        const n = store.add({
            title: 'Local note',
            source: 'agent',
            scope: { kind: 'workspace', workspaceId: 'ws-1' },
        });
        expect(store.get(n.id)?.scope).toEqual({ kind: 'workspace', workspaceId: 'ws-1' });
    });

    it('round-trips a gapp scope', () => {
        const n = store.add({
            title: 'App note',
            source: 'agent',
            scope: { kind: 'gapp', appId: 'com.example.app' },
        });
        expect(store.get(n.id)?.scope).toEqual({ kind: 'gapp', appId: 'com.example.app' });
    });

    it('a node written before scope existed reads as system — visible, exactly as it was', () => {
        // The migration backfill's direction: showing too much is recoverable,
        // hiding knowledge is not.
        const n = store.add({ title: 'Legacy', source: 'user' });
        db.prepare('UPDATE knowledge_nodes SET scope_kind = ?, scope_ref = NULL WHERE id = ?').run(
            'system',
            n.id,
        );
        expect(store.get(n.id)?.scope).toEqual({ kind: 'system' });
    });
});

describe('list narrows by scope', () => {
    beforeEach(() => {
        store.add({ title: 'System wide', source: 'user' });
        store.add({ title: 'In one', source: 'user', scope: { kind: 'workspace', workspaceId: 'ws-1' } });
        store.add({ title: 'In two', source: 'user', scope: { kind: 'workspace', workspaceId: 'ws-2' } });
        store.add({ title: 'In app', source: 'user', scope: { kind: 'gapp', appId: 'app-a' } });
    });

    it('with no scope option at all, lists everything — every existing caller is untouched', () => {
        expect(
            store
                .list()
                .map((n) => n.title)
                .sort(),
        ).toEqual(['In app', 'In one', 'In two', 'System wide']);
    });

    it('the caller default is system + its own workspace + its own app', () => {
        const titles = store
            .list({ scope: { workspaceId: 'ws-1', appId: 'app-a' } })
            .map((n) => n.title)
            .sort();
        expect(titles).toEqual(['In app', 'In one', 'System wide']);
    });

    it('`workspace` restricts to that one workspace', () => {
        expect(
            store.list({ scope: { kind: 'workspace', workspaceId: 'ws-2' } }).map((n) => n.title),
        ).toEqual(['In two']);
    });

    it('`system` restricts to system nodes', () => {
        expect(
            store.list({ scope: { kind: 'system', workspaceId: 'ws-1' } }).map((n) => n.title),
        ).toEqual(['System wide']);
    });

    it('`gapp` restricts to that one app', () => {
        expect(
            store
                .list({ scope: { kind: 'gapp', workspaceId: 'ws-1', appId: 'app-a' } })
                .map((n) => n.title),
        ).toEqual(['In app']);
    });
});

describe('SCOPE IS NOT A SECURITY BOUNDARY', () => {
    it('`all` from a workspace-bound caller reads every node on the machine, and SUCCEEDS', () => {
        store.add({ title: 'System wide', source: 'user' });
        store.add({
            title: 'Someone else’s workspace',
            source: 'agent',
            scope: { kind: 'workspace', workspaceId: 'ws-other' },
        });
        store.add({
            title: 'Someone else’s app',
            source: 'agent',
            scope: { kind: 'gapp', appId: 'app-other' },
        });

        // A caller in ws-1 with no app. Its DEFAULT view shows one node…
        expect(store.list({ scope: { workspaceId: 'ws-1', appId: null } })).toHaveLength(1);

        // …and asking for everything is ALLOWED. Not an error, not an empty
        // result: the full machine. Scope exists so an agent's context is not
        // polluted, not to withhold anything. Anything that must actually be
        // withheld from an agent does not belong in this store.
        const all = store.list({ scope: { kind: 'all', workspaceId: 'ws-1', appId: null } });
        expect(all.map((n) => n.title).sort()).toEqual([
            'Someone else’s app',
            'Someone else’s workspace',
            'System wide',
        ]);
    });

    it('`all` works for search too', () => {
        store.add({
            title: 'Reverb notes',
            body: 'reverb',
            source: 'agent',
            scope: { kind: 'workspace', workspaceId: 'ws-other' },
        });

        expect(
            store.search({ query: 'reverb', scope: { workspaceId: 'ws-1', appId: null } }),
        ).toHaveLength(0);
        expect(
            store.search({
                query: 'reverb',
                scope: { kind: 'all', workspaceId: 'ws-1', appId: null },
            }),
        ).toHaveLength(1);
    });
});

describe('scope and class are filtered in SQL, not after FTS', () => {
    it('a workspace match is found behind 200 system nodes that also match', () => {
        // THE starvation case. Over-fetching `max(limit*5, 50)` candidates and
        // narrowing in JS returns an EMPTY page here while a match exists.
        for (let i = 0; i < 200; i++) {
            store.add({ title: `System note ${i}`, body: 'caddy routing', source: 'agent' });
        }
        store.add({
            title: 'The one that matters',
            body: 'caddy routing',
            source: 'agent',
            scope: { kind: 'workspace', workspaceId: 'ws-1' },
        });

        const hits = store.search({
            query: 'caddy',
            limit: 10,
            scope: { kind: 'workspace', workspaceId: 'ws-1' },
        });
        expect(hits.map((h) => h.title)).toEqual(['The one that matters']);
    });

    it('a class match is found behind 200 knowledge nodes that also match', () => {
        for (let i = 0; i < 200; i++) {
            store.add({
                title: `Doc ${i}`,
                body: 'caddy routing',
                source: 'agent',
                class: 'knowledge',
            });
        }
        store.add({
            title: 'What we learned',
            body: 'caddy routing',
            source: 'agent',
            class: 'procedural',
        });

        const hits = store.search({ query: 'caddy', limit: 10, class: 'procedural' });
        expect(hits.map((h) => h.title)).toEqual(['What we learned']);
    });

    it('list is not starved either', () => {
        for (let i = 0; i < 200; i++) store.add({ title: `System note ${i}`, source: 'agent' });
        store.add({ title: 'Mine', source: 'agent', scope: { kind: 'workspace', workspaceId: 'ws-1' } });

        expect(
            store
                .list({ limit: 5, scope: { kind: 'workspace', workspaceId: 'ws-1' } })
                .map((n) => n.title),
        ).toEqual(['Mine']);
    });
});

describe('paging', () => {
    it('lists a page at a time and walks the whole set with the cursor', () => {
        for (let i = 0; i < 7; i++) store.add({ title: `N${i}`, source: 'user' });

        const seen: string[] = [];
        let cursor: string | null | undefined;
        for (let page = 0; page < 10; page++) {
            const res = store.listPage({ limit: 3, cursor: cursor ?? undefined });
            seen.push(...res.nodes.map((n) => n.title));
            cursor = res.nextCursor;
            if (!cursor) break;
        }

        // Newest-first, every node exactly once, no repeats across pages.
        expect(seen).toEqual(['N6', 'N5', 'N4', 'N3', 'N2', 'N1', 'N0']);
    });

    it('the last page reports no next cursor', () => {
        store.add({ title: 'Only', source: 'user' });
        expect(store.listPage({ limit: 3 }).nextCursor).toBeNull();
    });

    it('pages a search without repeating or skipping a hit', () => {
        for (let i = 0; i < 5; i++) store.add({ title: `Caddy ${i}`, body: 'caddy', source: 'user' });

        const first = store.searchPage({ query: 'caddy', limit: 2 });
        expect(first.results).toHaveLength(2);
        const second = store.searchPage({
            query: 'caddy',
            limit: 2,
            cursor: first.nextCursor ?? undefined,
        });
        const third = store.searchPage({
            query: 'caddy',
            limit: 2,
            cursor: second.nextCursor ?? undefined,
        });

        const ids = [...first.results, ...second.results, ...third.results].map((r) => r.id);
        expect(new Set(ids).size).toBe(5);
        expect(third.nextCursor).toBeNull();
    });
});
