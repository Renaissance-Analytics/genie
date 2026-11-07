import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeStore, ftsQuery, type Hit, type KnowledgeNode, type ListInput, type MemoryClass, type Scope, type SearchInput } from '../src/main/knowledge-store.js';
import { WINDOW_CALLS } from '../src/main/agent-stores-host.js';
import { runtimeDir } from '../src/main/paths.js';

/*
 * beta.60 host stall diagnosis: the Dashboard's knowledge read (every feature snapshot) asked for 200 nodes, and the store
 * read EVERY matching row and body out of SQLite, paged in JavaScript, then hydrated links and backlinks per node that the
 * snapshot threw away. Now the paging is in SQL, the Dashboard reads summaries (no full bodies, no edges), and each page is
 * the same page the old code returned.
 *
 * THE OLD CODE, verbatim, is below (`oldList`, `oldSearch`, `oldSummaries`) over a second handle on the same database file:
 * each new result is compared to it page by page, so "identical" is measured, not asserted.
 */

let dir: string;
let store: KnowledgeStore;
const clock = 1_700_000_000_000;
let step = 0;
/*
 * For the lists, two nodes share each timestamp, so ties in created_at are in the data (the rowid breaks them). The old
 * search broke a tie of rank AND time by nothing at all, so its tests use distinct times, where the old order is defined.
 */
let ties = true;
const now = () => new Date(clock + (ties ? Math.floor(step++ / 2) : step++)).toISOString();
const system: Scope = { kind: 'system' };
const tynn: Scope = { kind: 'workspace', id: 'tynn' };
const fancy: Scope = { kind: 'workspace', id: 'fancy' };
const classes: MemoryClass[] = ['knowledge', 'procedural', 'episodic', 'profile'];

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-knowledge-paged-'));
    step = 0;
    ties = true;
    store = KnowledgeStore.open(dir, now);
});

afterEach(async () => {
    vi.restoreAllMocks();
    store.close();
    await rm(dir, { recursive: true, force: true });
});

function fill(n: number, bodyChars = 300): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
        const scope = i % 3 === 0 ? system : i % 3 === 1 ? tynn : fancy;
        const tags = [`t${i % 4}`, ...(i % 5 === 0 ? ['shared'] : [])];
        // Leading and repeated whitespace (the snippet collapses it), a wikilink to an earlier node, and to a missing one.
        const pad = i % 7 === 0 ? '  \n\n\t   '.repeat(200) : '';
        const body = `${pad}Note ${i} about redis and caddy.  ${i > 0 ? `See [[Note ${i - 1}]].` : ''} ${i % 6 === 0 ? '[[nowhere]]' : ''}\n${'word '.repeat(Math.ceil(bodyChars / 5))}`;
        const { id } = store.add({ title: `Note ${i}`, body, class: classes[i % 4]!, tags, scope, source: i % 2 ? 'agent' : 'user', ...(i % 9 === 0 && i > 0 ? { links: [ids[0]!] } : {}) });
        ids.push(id);
    }
    return ids;
}

/*
 * The same nodes as fill() (titles, bodies, tags, scopes, classes, times, wikilink and explicit edges), written through
 * the store's own one-transaction path (importFromV1) instead of one add() and one commit each. 600 commits with large
 * bodies took this file over vitest's 30 s on Windows runners (genie#1648's unit (windows), job 128340139784); the rows
 * that need 600 nodes read them, they do not test add(), which fill() and the 90-node rows still go through.
 */
function fillFast(n: number, bodyChars = 300): string[] {
    const ids: string[] = [];
    const nodes = [];
    for (let i = 0; i < n; i += 1) {
        const id = `kn_fast${String(i).padStart(5, '0')}`;
        const pad = i % 7 === 0 ? '  \n\n\t   '.repeat(200) : '';
        const body = `${pad}Note ${i} about redis and caddy.  ${i > 0 ? `See [[Note ${i - 1}]].` : ''} ${i % 6 === 0 ? '[[nowhere]]' : ''}\n${'word '.repeat(Math.ceil(bodyChars / 5))}`;
        const edges = [
            ...(i > 0 ? [{ toRef: `Note ${i - 1}`, kind: 'wiki' as const }] : []),
            ...(i % 6 === 0 ? [{ toRef: 'nowhere', kind: 'wiki' as const }] : []),
            ...(i % 9 === 0 && i > 0 ? [{ toRef: ids[0]!, kind: 'explicit' as const }] : []),
        ];
        const at = now();
        nodes.push({
            id, title: `Note ${i}`, body, class: classes[i % 4]!, tags: [`t${i % 4}`, ...(i % 5 === 0 ? ['shared'] : [])],
            scope: i % 3 === 0 ? system : i % 3 === 1 ? tynn : fancy, source: (i % 2 ? 'agent' : 'user') as 'agent' | 'user',
            createdAt: at, updatedAt: at, edges,
        });
        ids.push(id);
    }
    const r = store.importFromV1({ nodes, notes: [] });
    if (r.imported !== n) throw new Error(`fillFast imported ${r.imported} of ${n}`);
    return ids;
}

/** A read-only second handle on the same file, for the reference (old) algorithm. */
function reference(): DatabaseSync {
    return new DatabaseSync(join(runtimeDir(dir), 'knowledge.db'), { readOnly: true });
}

interface Row { id: string; title: string; body: string; class: MemoryClass; tags: string; slug: string; scope_kind: string; scope_id: string | null; created_at: string }

function oldFilters(scopes: ListInput['scopes'], cls: MemoryClass | undefined): { where: string; params: (string | null)[] } {
    const clauses: string[] = [];
    const params: (string | null)[] = [];
    if (scopes !== 'all') {
        const parts = scopes.map((s) => {
            if (s.kind === 'system') return "(n.scope_kind = 'system')";
            params.push(s.kind, s.id);
            return '(n.scope_kind = ? AND n.scope_id = ?)';
        });
        clauses.push(parts.length > 0 ? `(${parts.join(' OR ')})` : '(0 = 1)');
    }
    if (cls) { clauses.push('n.class = ?'); params.push(cls); }
    return { where: clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '', params };
}

function oldPage<R>(rows: readonly R[], limit: number | undefined, cursor: string | undefined): { items: R[]; nextCursor: string | null } {
    const size = Math.max(1, Math.min(limit ?? 20, 200));
    const n = cursor ? Number(Buffer.from(cursor, 'base64url').toString()) : 0;
    const offset = Number.isInteger(n) && n >= 0 ? n : 0;
    return { items: rows.slice(offset, offset + size), nextCursor: offset + size < rows.length ? Buffer.from(String(offset + size)).toString('base64url') : null };
}

function oldList(db: DatabaseSync, input: ListInput): { nodes: KnowledgeNode[]; nextCursor: string | null } {
    const { where, params } = oldFilters(input.scopes, input.class);
    const rows = (db.prepare(`SELECT n.* FROM nodes n WHERE 1 = 1 ${where} ORDER BY n.created_at DESC, n.rowid DESC`).all(...params) as unknown as Row[])
        .filter((r) => input.tag === undefined || (JSON.parse(r.tags) as string[]).includes(input.tag));
    const page = oldPage(rows, input.limit, input.cursor);
    // The old list hydrated every node exactly as get() does.
    return { nodes: page.items.map((r) => store.get(r.id)!), nextCursor: page.nextCursor };
}

function oldSnippet(row: Row, tokens: readonly string[]): string {
    const body = row.body;
    const lower = body.toLowerCase();
    for (const t of tokens) {
        const i = lower.indexOf(t);
        if (i >= 0) {
            const start = Math.max(0, i - 60);
            const end = Math.min(body.length, i + t.length + 60);
            return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`;
        }
    }
    return row.title;
}

function oldSearch(db: DatabaseSync, input: SearchInput): { hits: Hit[]; nextCursor: string | null } {
    const match = ftsQuery(input.query);
    if (match === null) return { hits: [], nextCursor: null };
    const { where, params } = oldFilters(input.scopes, input.class);
    const rows = db.prepare(`SELECT n.*, bm25(nodes_fts, 0.0, 10.0, 1.0, 2.0) AS rank FROM nodes_fts f JOIN nodes n ON n.id = f.id WHERE nodes_fts MATCH ? ${where} ORDER BY rank ASC, n.created_at DESC`)
        .all(match, ...params) as unknown as Array<Row & { rank: number }>;
    const wanted = input.tags ?? [];
    const filtered = rows.filter((r) => wanted.every((t) => (JSON.parse(r.tags) as string[]).includes(t)));
    const tokens = (input.query.match(/[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.toLowerCase());
    const page = oldPage(filtered, input.limit, input.cursor);
    return { hits: page.items.map((r) => ({ id: r.id, title: r.title, snippet: oldSnippet(r, tokens), score: -r.rank, tags: JSON.parse(r.tags) as string[], class: r.class })), nextCursor: page.nextCursor };
}

/** What the feature snapshot made of the old list (feature-ipc.ts, before). */
function oldSummaries(db: DatabaseSync, input: ListInput): { hits: Hit[]; nextCursor: string | null } {
    const r = oldList(db, input);
    return { hits: r.nodes.map((n) => ({ id: n.id, title: n.title, snippet: n.body.replace(/\s+/g, ' ').trim().slice(0, 160), score: 0, tags: n.tags, class: n.class })), nextCursor: r.nextCursor };
}

/** Every page, by following the cursors. */
function pages<T>(read: (cursor: string | undefined) => { nextCursor: string | null } & T): T[] {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 1000; guard += 1) {
        const page = read(cursor);
        out.push(page);
        if (page.nextCursor === null) return out;
        cursor = page.nextCursor;
    }
    throw new Error('the cursors never ended');
}

/** Counts what the store reads out of SQLite: rows that carry a body, the body characters, and the edge queries. */
function meter(): { bodyRows: number; bodyChars: number; edgeQueries: number; reset(): void } {
    const m = { bodyRows: 0, bodyChars: 0, edgeQueries: 0, reset() { m.bodyRows = 0; m.bodyChars = 0; m.edgeQueries = 0; } };
    const count = (row: unknown): void => {
        if (row && typeof row === 'object') {
            for (const [k, v] of Object.entries(row)) {
                if ((k === 'body' || k === 'head') && typeof v === 'string') { m.bodyRows += 1; m.bodyChars += v.length; }
            }
        }
    };
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
        const stmt = prepare.call(this, sql);
        if (/\bedges\b/.test(sql) && /^\s*SELECT/i.test(sql)) m.edgeQueries += 1;
        const all = stmt.all.bind(stmt);
        const get = stmt.get.bind(stmt);
        stmt.all = ((...a: never[]) => { const rows = all(...a); rows.forEach(count); return rows; }) as typeof stmt.all;
        stmt.get = ((...a: never[]) => { const row = get(...a); count(row); return row; }) as typeof stmt.get;
        return stmt;
    });
    return m;
}

const LIST_INPUTS: ListInput[] = [
    { scopes: 'all' },
    { scopes: 'all', limit: 200 },
    { scopes: 'all', limit: 7 },
    { scopes: [system, tynn], limit: 9 },
    { scopes: [fancy], class: 'procedural', limit: 3 },
    { scopes: 'all', tag: 'shared', limit: 4 },
    { scopes: 'all', tag: 't2', class: 'episodic' },
    { scopes: [], limit: 5 },
];

const SEARCH_INPUTS: SearchInput[] = [
    { query: 'redis', scopes: 'all' },
    { query: 'Note 1', scopes: 'all', limit: 6 },
    { query: 'caddy', scopes: [tynn], limit: 4 },
    { query: 'word', scopes: 'all', tags: ['shared'], limit: 3 },
    { query: 'redis', scopes: 'all', tags: ['t1', 'shared'], class: 'procedural' },
    { query: '!!!', scopes: 'all' },
];

describe('knowledge list: the same pages as before, paged in SQL', () => {
    it('every page of every list matches the old list, node for node, links and backlinks included', () => {
        fill(90);
        const db = reference();
        try {
            for (const input of LIST_INPUTS) {
                const got = pages((cursor) => store.list({ ...input, ...(cursor ? { cursor } : {}) }));
                const want = pages((cursor) => oldList(db, { ...input, ...(cursor ? { cursor } : {}) }));
                expect(got).toEqual(want);
            }
            // A cursor from nowhere (garbage, past the end) reads the way it always did.
            for (const cursor of ['%%%', Buffer.from('9999').toString('base64url'), Buffer.from('-3').toString('base64url')]) {
                expect(store.list({ scopes: 'all', limit: 5, cursor })).toEqual(oldList(db, { scopes: 'all', limit: 5, cursor }));
            }
        } finally { db.close(); }
    });

    it('a page of 20 out of 600 reads at most 21 rows with a body, not 600', () => {
        fillFast(600);
        const m = meter();
        const r = store.list({ scopes: 'all', limit: 20 });
        expect(r.nodes).toHaveLength(20);
        expect(r.nextCursor).not.toBeNull();
        expect(m.bodyRows).toBeLessThanOrEqual(21);
    });
});

describe('knowledge search: the same hits as before, paged in SQL', () => {
    it('every page of every search matches the old search, hit for hit', () => {
        ties = false;
        fill(90);
        const db = reference();
        try {
            for (const input of SEARCH_INPUTS) {
                const got = pages((cursor) => store.search({ ...input, ...(cursor ? { cursor } : {}) }));
                const want = pages((cursor) => oldSearch(db, { ...input, ...(cursor ? { cursor } : {}) }));
                expect(got).toEqual(want);
            }
        } finally { db.close(); }
    });

    it('a page of 20 hits out of 600 matches reads at most 21 rows with a body', () => {
        ties = false;
        fillFast(600);
        const m = meter();
        const r = store.search({ query: 'redis', scopes: 'all', limit: 20 });
        expect(r.hits).toHaveLength(20);
        expect(m.bodyRows).toBeLessThanOrEqual(21);
    });
});

describe('knowledge summaries: what the Dashboard shows, without full bodies or edges', () => {
    it('every page matches what the snapshot made of the old list', () => {
        fill(90);
        const db = reference();
        try {
            for (const input of LIST_INPUTS) {
                const got = pages((cursor) => store.summaries({ ...input, ...(cursor ? { cursor } : {}) }));
                const want = pages((cursor) => oldSummaries(db, { ...input, ...(cursor ? { cursor } : {}) }));
                expect(got).toEqual(want);
            }
        } finally { db.close(); }
    });

    it('a body that is mostly whitespace still gives the same snippet', () => {
        const { id } = store.add({ title: 'Spacey', body: `${' \n'.repeat(5000)}the words come late${' '.repeat(3000)}and then more`, scope: system, source: 'user' });
        const db = reference();
        try {
            expect(store.summaries({ scopes: 'all' }).hits).toEqual(oldSummaries(db, { scopes: 'all' }).hits);
            expect(store.summaries({ scopes: 'all' }).hits[0]!.id).toBe(id);
        } finally { db.close(); }
    });

    it('200 summaries out of 600 nodes with 4 KB bodies: no edge query, at most 201 rows, and a bounded prefix of each body', () => {
        fillFast(600, 4_000);
        // Each body is about 4,065 characters; every seventh is 1,800 more of leading whitespace (about 5,865).
        const m = meter();
        const r = store.summaries({ scopes: 'all', limit: 200 });
        expect(r.hits).toHaveLength(200);
        expect(m.edgeQueries).toBe(0);
        // Every seventh body starts with 1,800 whitespace characters: those (29 of the 200) are read whole, once more, so
        // their snippet stays exact. Every other row is read as a 1,024-character head.
        expect(m.bodyRows).toBeLessThanOrEqual(201 + 30);
        // What separates new from old: the old read took every matching body whole (600 x about 4,300 = about 2.6 M
        // characters, before paging); this page reads 201 heads of 1,024 and the 29 whitespace-headed bodies whole (about
        // 375 K). The bound sits between them.
        expect(m.bodyChars).toBeLessThan(201 * 1024 + 30 * 6_000);
    });

    it('a window can ask the host for summaries', () => {
        expect(WINDOW_CALLS.knowledge).toContain('summaries');
    });

    it('the feature snapshot reads summaries, not the full list', () => {
        const src = readFileSync('src/main/feature-ipc.ts', 'utf8');
        expect(src).not.toMatch(/services\.knowledge\.list\(/);
        expect(src).toMatch(/services\.knowledge\.summaries\(\{ scopes: 'all', limit: 200 \}\)/);
    });
});
