import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runtimeDir } from './paths.js';

/**
 * THE KNOWLEDGE GRAPH (§6.7) — one LOCAL store per workstation, shared by every workspace.
 *
 * Markdown "memory" nodes in `node:sqlite` (a platform module, not a third-party dependency;
 * measured available in Electron's bundled Node by the P7 probe) with an FTS5 index for keyword
 * retrieval. No embeddings: no model download, no API key, works offline, and `search()` is the
 * one seam a semantic layer would sit behind later.
 *
 * ## Edges are references, resolved at READ time
 *
 * A `[[wikilink]]` is stored as the text the author wrote — an id, a slug or a title — not as a
 * node id. Resolution happens on every read, so a forward reference links up the moment its
 * target is created, with nothing re-saved; and **an ambiguous reference resolves to nothing**
 * and is reported as such, because a guess would be a silent wrong edge. Edge `kind` separates
 * body wikilinks from explicit `links`, so editing the body recomputes the one and not the other.
 *
 * ## Scope is noise reduction, NOT a security boundary
 *
 * `scopes: 'all'` is allowed from every caller and returns everything. Scope exists so an
 * agent's context is not polluted by knowledge it has no business acting on. Nothing that must
 * be withheld from an agent belongs in this store, and no code may treat scope as a permission.
 */

export type MemoryClass = 'profile' | 'episodic' | 'procedural' | 'knowledge';
export type Scope = { kind: 'system' } | { kind: 'workspace'; id: string } | { kind: 'gapp'; id: string };
export type Source = 'agent' | 'user';

export interface Unresolved {
    readonly ref: string;
    readonly reason: 'ambiguous' | 'missing';
}

export interface KnowledgeNode {
    readonly id: string;
    readonly title: string;
    readonly slug: string;
    readonly body: string;
    readonly class: MemoryClass;
    readonly tags: readonly string[];
    readonly scope: Scope;
    readonly source: Source;
    readonly createdAt: string;
    readonly updatedAt: string;
    /** Resolved outgoing edges, de-duplicated. */
    readonly links: readonly string[];
    /** Nodes whose edges resolve to this one. */
    readonly backlinks: readonly string[];
    readonly unresolved: readonly Unresolved[];
}

export interface AddInput {
    readonly title: string;
    readonly body?: string;
    readonly class?: MemoryClass;
    readonly tags?: readonly string[];
    /** Explicit edge targets (id, title or slug), in addition to the body's wikilinks. */
    readonly links?: readonly string[];
    readonly scope: Scope;
    readonly source: Source;
}

export interface Hit {
    readonly id: string;
    readonly title: string;
    readonly snippet: string;
    readonly score: number;
    readonly tags: readonly string[];
    readonly class: MemoryClass;
}

export type ScopeFilter = 'all' | readonly Scope[];

export interface SearchInput {
    readonly query: string;
    readonly scopes: ScopeFilter;
    readonly class?: MemoryClass;
    readonly tags?: readonly string[];
    readonly limit?: number;
    readonly cursor?: string;
}

export interface ListInput {
    readonly scopes: ScopeFilter;
    readonly class?: MemoryClass;
    readonly tag?: string;
    readonly limit?: number;
    readonly cursor?: string;
}

export type LinkResult = { ok: true; to: string } | { ok: false; reason: 'missing' | 'ambiguous' | 'no such source' };

interface Row {
    id: string;
    title: string;
    slug: string;
    body: string;
    class: MemoryClass;
    tags: string;
    scope_kind: Scope['kind'];
    scope_id: string | null;
    source: Source;
    created_at: string;
    updated_at: string;
}

const WIKILINK = /\[\[([^\]]+)\]\]/g;
const DEFAULT_LIMIT = 20;

export function slugify(title: string): string {
    return title
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '');
}

export function wikilinksIn(body: string): string[] {
    const refs: string[] = [];
    for (const m of body.matchAll(WIKILINK)) {
        const ref = m[1]!.trim();
        if (ref && !refs.includes(ref)) refs.push(ref);
    }
    return refs;
}

/**
 * Turn free text into an FTS5 query: every alphanumeric token as a quoted prefix term, OR-ed.
 * Punctuation never reaches FTS5, so a query of `"(*` is "no tokens" rather than a syntax error.
 */
export function ftsQuery(text: string): string | null {
    const tokens = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (tokens.length === 0) return null;
    return tokens.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
}

function encodeCursor(offset: number): string {
    return Buffer.from(String(offset)).toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
    if (!cursor) return 0;
    const n = Number(Buffer.from(cursor, 'base64url').toString());
    return Number.isInteger(n) && n >= 0 ? n : 0;
}

export class KnowledgeStore {
    readonly #db: DatabaseSync;
    readonly #now: () => string;

    private constructor(db: DatabaseSync, now: () => string) {
        this.#db = db;
        this.#now = now;
        this.#migrate();
    }

    static open(userData: string, now: () => string = () => new Date().toISOString()): KnowledgeStore {
        const dir = runtimeDir(userData);
        mkdirSync(dir, { recursive: true });
        return new KnowledgeStore(new DatabaseSync(join(dir, 'knowledge.db')), now);
    }

    close(): void {
        this.#db.close();
    }

    #migrate(): void {
        this.#db.exec(`
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS nodes (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                slug TEXT NOT NULL,
                body TEXT NOT NULL,
                class TEXT NOT NULL,
                tags TEXT NOT NULL,
                scope_kind TEXT NOT NULL,
                scope_id TEXT,
                source TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS nodes_slug ON nodes(slug);
            CREATE INDEX IF NOT EXISTS nodes_created ON nodes(created_at);
            CREATE TABLE IF NOT EXISTS edges (
                from_id TEXT NOT NULL,
                to_ref TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('wiki', 'explicit')),
                UNIQUE (from_id, to_ref, kind)
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(id UNINDEXED, title, body, tags);
        `);
    }

    add(input: AddInput): { id: string; unresolved: Unresolved[] } {
        const id = `kn_${randomUUID()}`;
        const now = this.#now();
        const body = input.body ?? '';
        const tags = [...(input.tags ?? [])];
        this.#db
            .prepare(
                `INSERT INTO nodes (id, title, slug, body, class, tags, scope_kind, scope_id, source, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                id,
                input.title,
                slugify(input.title),
                body,
                input.class ?? 'knowledge',
                JSON.stringify(tags),
                input.scope.kind,
                input.scope.kind === 'system' ? null : input.scope.id,
                input.source,
                now,
                now,
            );
        this.#db.prepare('INSERT INTO nodes_fts (id, title, body, tags) VALUES (?, ?, ?, ?)').run(id, input.title, body, tags.join(' '));
        this.#writeEdges(id, wikilinksIn(body), 'wiki');
        this.#writeEdges(id, input.links ?? [], 'explicit');
        return { id, unresolved: this.#resolveEdges(id).unresolved };
    }

    get(id: string): KnowledgeNode | null {
        const row = this.#db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Row | undefined;
        if (!row) return null;
        const { links, unresolved } = this.#resolveEdges(id);
        return { ...this.#node(row), links, backlinks: this.#backlinks(row), unresolved };
    }

    update(id: string, patch: { title?: string; body?: string; tags?: readonly string[]; class?: MemoryClass }): boolean {
        const row = this.#db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Row | undefined;
        if (!row) return false;
        const title = patch.title ?? row.title;
        const body = patch.body ?? row.body;
        const tags = patch.tags ? [...patch.tags] : (JSON.parse(row.tags) as string[]);
        const cls = patch.class ?? row.class;
        this.#db
            .prepare('UPDATE nodes SET title = ?, slug = ?, body = ?, tags = ?, class = ?, updated_at = ? WHERE id = ?')
            .run(title, slugify(title), body, JSON.stringify(tags), cls, this.#now(), id);
        this.#db.prepare('UPDATE nodes_fts SET title = ?, body = ?, tags = ? WHERE id = ?').run(title, body, tags.join(' '), id);
        if (patch.body !== undefined) {
            // The body changed: its wikilinks are recomputed; explicit edges are not the body's.
            this.#db.prepare("DELETE FROM edges WHERE from_id = ? AND kind = 'wiki'").run(id);
            this.#writeEdges(id, wikilinksIn(body), 'wiki');
        }
        return true;
    }

    remove(id: string): boolean {
        const r = this.#db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
        if (r.changes === 0) return false;
        this.#db.prepare('DELETE FROM nodes_fts WHERE id = ?').run(id);
        // Edges FROM the node go with it. Edges TO it stay as the text their authors wrote —
        // they now resolve to `missing`, which is the truth, and link up again if it is recreated.
        this.#db.prepare('DELETE FROM edges WHERE from_id = ?').run(id);
        return true;
    }

    link(from: string, to: string): LinkResult {
        const exists = this.#db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(from);
        if (!exists) return { ok: false, reason: 'no such source' };
        const target = this.#resolve(to);
        if (target.kind !== 'one') return { ok: false, reason: target.kind };
        this.#db.prepare("INSERT OR IGNORE INTO edges (from_id, to_ref, kind) VALUES (?, ?, 'explicit')").run(from, to);
        return { ok: true, to: target.id };
    }

    search(input: SearchInput): { hits: Hit[]; nextCursor: string | null } {
        const match = ftsQuery(input.query);
        if (match === null) return { hits: [], nextCursor: null };
        const { where, params } = this.#filters(input.scopes, input.class);
        // Title matches outrank body matches outrank tag matches; bm25 is lower-is-better.
        const rows = this.#db
            .prepare(
                `SELECT n.*, bm25(nodes_fts, 0.0, 10.0, 1.0, 2.0) AS rank
                 FROM nodes_fts f JOIN nodes n ON n.id = f.id
                 WHERE nodes_fts MATCH ? ${where}
                 ORDER BY rank ASC, n.created_at DESC`,
            )
            .all(match, ...params) as unknown as Array<Row & { rank: number }>;
        const wanted = input.tags ?? [];
        const filtered = rows.filter((r) => {
            const tags = JSON.parse(r.tags) as string[];
            return wanted.every((t) => tags.includes(t));
        });
        const tokens = (input.query.match(/[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.toLowerCase());
        const page = this.#page(filtered, input.limit, input.cursor);
        return {
            hits: page.items.map((r) => ({
                id: r.id,
                title: r.title,
                snippet: snippetFor(r, tokens),
                score: -r.rank,
                tags: JSON.parse(r.tags) as string[],
                class: r.class,
            })),
            nextCursor: page.nextCursor,
        };
    }

    list(input: ListInput): { nodes: KnowledgeNode[]; nextCursor: string | null } {
        const { where, params } = this.#filters(input.scopes, input.class);
        const rows = (this.#db
            .prepare(`SELECT n.* FROM nodes n WHERE 1 = 1 ${where} ORDER BY n.created_at DESC, n.rowid DESC`)
            .all(...params) as unknown as Row[]).filter((r) => input.tag === undefined || (JSON.parse(r.tags) as string[]).includes(input.tag));
        const page = this.#page(rows, input.limit, input.cursor);
        return {
            nodes: page.items.map((r) => {
                const { links, unresolved } = this.#resolveEdges(r.id);
                return { ...this.#node(r), links, backlinks: this.#backlinks(r), unresolved };
            }),
            nextCursor: page.nextCursor,
        };
    }

    /** Offset paging behind an opaque cursor; `null` means that was the last page. */
    #page<R>(rows: readonly R[], limit: number | undefined, cursor: string | undefined): { items: R[]; nextCursor: string | null } {
        const size = Math.max(1, Math.min(limit ?? DEFAULT_LIMIT, 200));
        const offset = decodeCursor(cursor);
        return {
            items: rows.slice(offset, offset + size),
            nextCursor: offset + size < rows.length ? encodeCursor(offset + size) : null,
        };
    }

    #filters(scopes: ScopeFilter, cls: MemoryClass | undefined): { where: string; params: (string | null)[] } {
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
        if (cls) {
            clauses.push('n.class = ?');
            params.push(cls);
        }
        const where = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';
        return { where, params };
    }

    #node(row: Row): Omit<KnowledgeNode, 'links' | 'backlinks' | 'unresolved'> {
        const scope: Scope =
            row.scope_kind === 'system' ? { kind: 'system' } : { kind: row.scope_kind, id: row.scope_id ?? '' };
        return {
            id: row.id,
            title: row.title,
            slug: row.slug,
            body: row.body,
            class: row.class,
            tags: JSON.parse(row.tags) as string[],
            scope,
            source: row.source,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    /** Resolve a reference the way an author wrote it: an id, then a slug, then a title. */
    #resolve(ref: string): { kind: 'one'; id: string } | { kind: 'missing' } | { kind: 'ambiguous' } {
        const byId = this.#db.prepare('SELECT id FROM nodes WHERE id = ?').get(ref) as { id: string } | undefined;
        if (byId) return { kind: 'one', id: byId.id };
        const bySlug = this.#db.prepare('SELECT id FROM nodes WHERE slug = ?').all(slugify(ref)) as { id: string }[];
        const byTitle = this.#db.prepare('SELECT id FROM nodes WHERE lower(title) = lower(?)').all(ref) as { id: string }[];
        const ids = new Set([...bySlug, ...byTitle].map((r) => r.id));
        if (ids.size === 0) return { kind: 'missing' };
        if (ids.size > 1) return { kind: 'ambiguous' };
        return { kind: 'one', id: [...ids][0]! };
    }

    #resolveEdges(fromId: string): { links: string[]; unresolved: Unresolved[] } {
        const refs = this.#db.prepare('SELECT to_ref FROM edges WHERE from_id = ? ORDER BY rowid').all(fromId) as { to_ref: string }[];
        const links: string[] = [];
        const unresolved: Unresolved[] = [];
        for (const { to_ref } of refs) {
            const r = this.#resolve(to_ref);
            if (r.kind === 'one') {
                if (!links.includes(r.id)) links.push(r.id);
            } else if (!unresolved.some((u) => u.ref === to_ref)) {
                unresolved.push({ ref: to_ref, reason: r.kind });
            }
        }
        return { links, unresolved };
    }

    #backlinks(row: Row): string[] {
        // Candidates are edges whose text could name this node; each is then resolved for real,
        // so an edge that is ambiguous counts for nobody.
        const candidates = this.#db
            .prepare('SELECT DISTINCT from_id, to_ref FROM edges WHERE to_ref = ? OR lower(to_ref) = lower(?) OR to_ref = ?')
            .all(row.id, row.title, row.slug) as { from_id: string; to_ref: string }[];
        const out: string[] = [];
        for (const c of candidates) {
            const r = this.#resolve(c.to_ref);
            if (r.kind === 'one' && r.id === row.id && !out.includes(c.from_id)) out.push(c.from_id);
        }
        return out;
    }

    #writeEdges(fromId: string, refs: readonly string[], kind: 'wiki' | 'explicit'): void {
        const stmt = this.#db.prepare('INSERT OR IGNORE INTO edges (from_id, to_ref, kind) VALUES (?, ?, ?)');
        for (const ref of refs) stmt.run(fromId, ref, kind);
    }
}

/** An excerpt around the first query token, from the body when it has one, else the title. */
function snippetFor(row: Row, tokens: readonly string[]): string {
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
