import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../db';
import {
    normalizeTags,
    parseWikilinks,
    slugify,
    type KnowledgeAddInput,
    type KnowledgeChangeEvent,
    type KnowledgeEdge,
    type KnowledgeGraph,
    type KnowledgeListOptions,
    type KnowledgeNode,
    type KnowledgeSearchOptions,
    type KnowledgeSearchResult,
    type KnowledgeSource,
    type KnowledgeUpdateInput,
} from './types';

/**
 * The Knowledge Graph store — Genie's WORKSTATION-WIDE local knowledge/memory
 * store, backed by the shared `genie.db` (SQLite via better-sqlite3, in Genie's
 * userData dir — ONE store across every workspace). Persists markdown "memory"
 * nodes, keyword-searches them with SQLite FTS5, and turns each node's
 * `[[wikilink]]` references into graph edges.
 *
 * Schema is created by the db.ts migration (v22): `knowledge_nodes`, the
 * `knowledge_nodes_fts` FTS5 virtual table (manually kept in sync here), and
 * `knowledge_edges`. The class takes a Database so a test can drive it against a
 * fresh `:memory:` db (runMigrations + new KnowledgeStore(db)); production uses
 * the shared handle via {@link getKnowledgeStore}.
 *
 * EDGES. A node's outbound links come from two sources, tracked by `kind` so an
 * update to one never clobbers the other:
 *   - `wiki`     — the `[[wikilink]]` targets parsed from the body.
 *   - `explicit` — targets passed as `links` at write time (or via `link`).
 * A target is a raw reference (a node id, title, or slug); it's RESOLVED to a
 * node id at read time against the current node set, so a forward reference
 * (`[[Foo]]` written before Foo exists) links up automatically once Foo is
 * created, and a deleted node's inbound links simply go unresolved.
 *
 * KEYWORD-FIRST (v1). Retrieval is SQLite FTS5 (prefix-OR over title/body/tags,
 * ranked by bm25) with a forgiving LIKE fallback — always available, no external
 * API key, no model download. A semantic/embeddings layer can be added later on
 * top of {@link search} with a graceful fallback to this floor.
 */
export class KnowledgeStore {
    private emit: (ev: KnowledgeChangeEvent) => void = () => {};

    constructor(private db: Database.Database) {}

    /** Wire the outbound change sink (boot wires the renderer broadcast; a test spies). */
    setEmitter(fn: (ev: KnowledgeChangeEvent) => void): void {
        this.emit = fn;
    }

    // --- reads -------------------------------------------------------------

    /** One node by id (with its resolved outbound links), or null. */
    get(id: string): KnowledgeNode | null {
        const row = this.db
            .prepare<[string], NodeRow>('SELECT * FROM knowledge_nodes WHERE id = ?')
            .get(id);
        if (!row) return null;
        return this.toNode(row, this.linksFor(id, this.buildResolver()));
    }

    /**
     * List nodes newest-first (by `updatedAt`). `tag` restricts to nodes carrying
     * that tag (case-insensitive); `limit` caps the count (default 200).
     */
    list(opts: KnowledgeListOptions = {}): KnowledgeNode[] {
        const limit = opts.limit && opts.limit > 0 ? opts.limit : 200;
        const tag = opts.tag?.trim();
        // `rowid DESC` is a stable tiebreaker (insertion order) so "newest-first"
        // stays deterministic even for nodes written in the same millisecond.
        const rows = tag
            ? this.db
                  .prepare<[string, number], NodeRow>(
                      `SELECT * FROM knowledge_nodes
                       WHERE EXISTS (
                           SELECT 1 FROM json_each(knowledge_nodes.tags) je
                           WHERE lower(je.value) = lower(?)
                       )
                       ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
                  )
                  .all(tag, limit)
            : this.db
                  .prepare<[number], NodeRow>(
                      'SELECT * FROM knowledge_nodes ORDER BY updated_at DESC, rowid DESC LIMIT ?',
                  )
                  .all(limit);
        return this.nodesFrom(rows);
    }

    /**
     * Keyword search over the nodes. FTS5 (prefix-OR of the query's terms, ranked
     * by bm25) is the primary path; a LIKE scan is the fallback when the query has
     * no indexable terms or FTS returns nothing. `tags` (optional) further narrows
     * hits to nodes carrying ALL of the given tags. Returns hits best-first.
     */
    search(opts: KnowledgeSearchOptions): KnowledgeSearchResult[] {
        const raw = String(opts.query ?? '').trim();
        const limit = opts.limit && opts.limit > 0 ? opts.limit : 20;
        const filterTags = normalizeTags(opts.tags).map((t) => t.toLowerCase());
        // When a tag filter is present we over-fetch candidates, then narrow —
        // so the tag cut doesn't starve the result below `limit`.
        const candidates = filterTags.length ? Math.max(limit * 5, 50) : limit;

        let hits = this.ftsSearch(raw, candidates);
        if (hits.length === 0) hits = this.likeSearch(raw, candidates);

        const narrowed = filterTags.length
            ? hits.filter((h) => {
                  const have = new Set(h.tags.map((t) => t.toLowerCase()));
                  return filterTags.every((t) => have.has(t));
              })
            : hits;
        return narrowed.slice(0, limit);
    }

    /** The whole graph — every node + every resolved edge (both ends existing). */
    graph(): KnowledgeGraph {
        const rows = this.db
            .prepare<[], NodeRow>(
                'SELECT * FROM knowledge_nodes ORDER BY updated_at DESC, rowid DESC',
            )
            .all();
        const nodes = this.nodesFrom(rows);
        const resolver = this.buildResolver();
        const edgeRows = this.db
            .prepare<[], { from_id: string; to_ref: string }>(
                'SELECT from_id, to_ref FROM knowledge_edges',
            )
            .all();
        // Edges are directed: from = the node that CONTAINS the link, to = the
        // node it points at (mirrors the from_id/to_ref columns).
        const edges: KnowledgeEdge[] = [];
        const seen = new Set<string>();
        for (const e of edgeRows) {
            const to = resolver(e.to_ref);
            if (!to || to === e.from_id) continue;
            const key = `${e.from_id}->${to}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({ from: e.from_id, to });
        }
        return { nodes, edges };
    }

    // --- writes ------------------------------------------------------------

    /** Create a node. Wiki edges come from the body; explicit edges from `links`. */
    add(input: KnowledgeAddInput): KnowledgeNode {
        const id = crypto.randomUUID();
        const now = Date.now();
        const title = String(input.title ?? '').trim();
        const body = input.body ?? '';
        const tags = normalizeTags(input.tags);
        const source: KnowledgeSource = input.source === 'agent' ? 'agent' : 'user';
        this.db
            .prepare(
                `INSERT INTO knowledge_nodes (id, title, slug, body, tags, source, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(id, title, slugify(title), body, JSON.stringify(tags), source, now, now);
        this.ftsInsert(id, title, body, tags);
        this.setEdges(id, 'wiki', parseWikilinks(body));
        this.setEdges(id, 'explicit', input.links ?? []);
        this.emit({ action: 'add', id });
        return this.get(id)!;
    }

    /** Patch a node — only provided fields change; edges recompute as needed. */
    update(id: string, patch: KnowledgeUpdateInput): KnowledgeNode | null {
        const existing = this.db
            .prepare<[string], NodeRow>('SELECT * FROM knowledge_nodes WHERE id = ?')
            .get(id);
        if (!existing) return null;

        const title = patch.title !== undefined ? patch.title.trim() : existing.title;
        const body = patch.body !== undefined ? patch.body : existing.body;
        const tags =
            patch.tags !== undefined ? normalizeTags(patch.tags) : (JSON.parse(existing.tags) as string[]);
        const now = Date.now();
        this.db
            .prepare(
                `UPDATE knowledge_nodes
                 SET title = ?, slug = ?, body = ?, tags = ?, updated_at = ?
                 WHERE id = ?`,
            )
            .run(title, slugify(title), body, JSON.stringify(tags), now, id);
        // Re-sync the FTS row (delete + reinsert — external-content-free).
        this.db.prepare('DELETE FROM knowledge_nodes_fts WHERE id = ?').run(id);
        this.ftsInsert(id, title, body, tags);
        // Recompute only the edge kind whose source actually changed.
        if (patch.body !== undefined) this.setEdges(id, 'wiki', parseWikilinks(body));
        if (patch.links !== undefined) this.setEdges(id, 'explicit', patch.links);
        this.emit({ action: 'update', id });
        return this.get(id);
    }

    /** Delete a node (its outbound edges cascade; inbound refs go unresolved). */
    delete(id: string): { ok: boolean } {
        const info = this.db.prepare('DELETE FROM knowledge_nodes WHERE id = ?').run(id);
        this.db.prepare('DELETE FROM knowledge_nodes_fts WHERE id = ?').run(id);
        const ok = info.changes > 0;
        if (ok) this.emit({ action: 'delete', id });
        return { ok };
    }

    /** Add an explicit edge from `from` (a node id) to `to` (id, title, or slug). */
    link(from: string, to: string): { ok: boolean; error?: string } {
        const exists = this.db.prepare('SELECT 1 FROM knowledge_nodes WHERE id = ?').get(from);
        if (!exists) return { ok: false, error: `No node "${from}".` };
        const ref = String(to ?? '').trim();
        if (!ref) return { ok: false, error: 'link needs a `to` target.' };
        this.db
            .prepare(
                `INSERT OR IGNORE INTO knowledge_edges (from_id, to_ref, kind) VALUES (?, ?, 'explicit')`,
            )
            .run(from, ref);
        this.emit({ action: 'link', id: from });
        return { ok: true };
    }

    // --- internals ---------------------------------------------------------

    /** Replace all edges of one `kind` for a node with a fresh target set. */
    private setEdges(fromId: string, kind: 'wiki' | 'explicit', refs: string[]): void {
        this.db
            .prepare('DELETE FROM knowledge_edges WHERE from_id = ? AND kind = ?')
            .run(fromId, kind);
        const ins = this.db.prepare(
            'INSERT OR IGNORE INTO knowledge_edges (from_id, to_ref, kind) VALUES (?, ?, ?)',
        );
        const seen = new Set<string>();
        for (const raw of refs) {
            const ref = String(raw ?? '').trim();
            if (!ref) continue;
            const key = ref.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            ins.run(fromId, ref, kind);
        }
    }

    /** A resolver over the current node set: a raw ref → node id (id, then
     *  case-insensitive title, then slug), or null when nothing matches. */
    private buildResolver(): (ref: string) => string | null {
        const rows = this.db
            .prepare<[], { id: string; title: string; slug: string }>(
                'SELECT id, title, slug FROM knowledge_nodes',
            )
            .all();
        const byId = new Set<string>();
        const byTitle = new Map<string, string>();
        const bySlug = new Map<string, string>();
        for (const r of rows) {
            byId.add(r.id);
            byTitle.set(r.title.toLowerCase(), r.id);
            if (r.slug) bySlug.set(r.slug, r.id);
        }
        return (ref: string): string | null => {
            const r = String(ref ?? '').trim();
            if (!r) return null;
            if (byId.has(r)) return r;
            const t = byTitle.get(r.toLowerCase());
            if (t) return t;
            return bySlug.get(slugify(r)) ?? null;
        };
    }

    /** The resolved, de-duplicated, self-excluded outbound link ids for a node. */
    private linksFor(fromId: string, resolver: (ref: string) => string | null): string[] {
        const refs = this.db
            .prepare<[string], { to_ref: string }>(
                'SELECT to_ref FROM knowledge_edges WHERE from_id = ?',
            )
            .all(fromId);
        const out: string[] = [];
        const seen = new Set<string>();
        for (const { to_ref } of refs) {
            const target = resolver(to_ref);
            if (!target || target === fromId || seen.has(target)) continue;
            seen.add(target);
            out.push(target);
        }
        return out;
    }

    /** Map a batch of rows → nodes, sharing one resolver + one edge sweep. */
    private nodesFrom(rows: NodeRow[]): KnowledgeNode[] {
        if (rows.length === 0) return [];
        const resolver = this.buildResolver();
        const edgeRows = this.db
            .prepare<[], { from_id: string; to_ref: string }>(
                'SELECT from_id, to_ref FROM knowledge_edges',
            )
            .all();
        const byFrom = new Map<string, string[]>();
        for (const e of edgeRows) {
            const target = resolver(e.to_ref);
            if (!target) continue;
            const list = byFrom.get(e.from_id) ?? [];
            list.push(target);
            byFrom.set(e.from_id, list);
        }
        return rows.map((row) => {
            const targets = byFrom.get(row.id) ?? [];
            const links: string[] = [];
            const seen = new Set<string>();
            for (const t of targets) {
                if (t === row.id || seen.has(t)) continue;
                seen.add(t);
                links.push(t);
            }
            return this.toNode(row, links);
        });
    }

    private toNode(row: NodeRow, links: string[]): KnowledgeNode {
        return {
            id: row.id,
            title: row.title,
            body: row.body,
            tags: safeTags(row.tags),
            links,
            source: row.source === 'agent' ? 'agent' : 'user',
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    // --- FTS ---------------------------------------------------------------

    private ftsInsert(id: string, title: string, body: string, tags: string[]): void {
        this.db
            .prepare(
                'INSERT INTO knowledge_nodes_fts (id, title, body, tags) VALUES (?, ?, ?, ?)',
            )
            .run(id, title, body, tags.join(' '));
    }

    /** FTS5 keyword search: prefix-OR of the query's terms, ranked by bm25. */
    private ftsSearch(raw: string, limit: number): KnowledgeSearchResult[] {
        const expr = buildFtsQuery(raw);
        if (!expr) return [];
        try {
            const rows = this.db
                .prepare<[string, number], FtsRow>(
                    `SELECT n.id AS id, n.title AS title, n.tags AS tags, n.body AS body,
                            snippet(knowledge_nodes_fts, 2, '', '', '…', 12) AS snip,
                            bm25(knowledge_nodes_fts) AS rank
                     FROM knowledge_nodes_fts
                     JOIN knowledge_nodes n ON n.id = knowledge_nodes_fts.id
                     WHERE knowledge_nodes_fts MATCH ?
                     ORDER BY rank
                     LIMIT ?`,
                )
                .all(expr, limit);
            return rows.map((r) => ({
                id: r.id,
                title: r.title,
                snippet: r.snip?.trim() ? r.snip : excerpt(r.body),
                // bm25 is smaller-is-better (typically negative); flip so higher = better.
                score: round(-r.rank),
                tags: safeTags(r.tags),
            }));
        } catch {
            // A malformed MATCH expression should never sink the search — the LIKE
            // fallback still returns useful results.
            return [];
        }
    }

    /** Substring fallback when FTS has no indexable terms or finds nothing. */
    private likeSearch(raw: string, limit: number): KnowledgeSearchResult[] {
        if (!raw) return [];
        const like = `%${raw.replace(/[%_]/g, (c) => '\\' + c)}%`;
        const rows = this.db
            .prepare<[string, string, string, number], NodeRow>(
                `SELECT * FROM knowledge_nodes
                 WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\'
                 ORDER BY updated_at DESC LIMIT ?`,
            )
            .all(like, like, like, limit);
        return rows.map((r) => ({
            id: r.id,
            title: r.title,
            snippet: excerpt(r.body, raw),
            score: 0,
            tags: safeTags(r.tags),
        }));
    }
}

// --- row shapes + small helpers -------------------------------------------

interface NodeRow {
    id: string;
    title: string;
    slug: string;
    body: string;
    tags: string;
    source: string;
    created_at: number;
    updated_at: number;
}

interface FtsRow {
    id: string;
    title: string;
    tags: string;
    body: string;
    snip: string;
    rank: number;
}

/** Parse a stored tags JSON column, tolerating corruption. */
function safeTags(json: string): string[] {
    try {
        const v = JSON.parse(json);
        return Array.isArray(v) ? v.map((t) => String(t)) : [];
    } catch {
        return [];
    }
}

/**
 * Build a safe FTS5 MATCH expression from a raw query: extract alphanumeric
 * terms, prefix-match each (`term*`), OR them together (bm25 still floats
 * multi-term matches highest). Returns null when there's nothing to match.
 */
function buildFtsQuery(raw: string): string | null {
    const terms = (raw.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, 16);
    if (terms.length === 0) return null;
    return terms.map((t) => `${t}*`).join(' OR ');
}

/** A short body excerpt — centred on `around` (case-insensitive) if given. */
function excerpt(body: string, around?: string, max = 160): string {
    const text = String(body ?? '').replace(/\s+/g, ' ').trim();
    if (text.length <= max) return text;
    if (around) {
        const i = text.toLowerCase().indexOf(around.toLowerCase());
        if (i >= 0) {
            const start = Math.max(0, i - Math.floor(max / 3));
            const slice = text.slice(start, start + max);
            return (start > 0 ? '…' : '') + slice.trim() + (start + max < text.length ? '…' : '');
        }
    }
    return text.slice(0, max - 1) + '…';
}

/** Round a score to a stable 4 decimals. */
function round(n: number): number {
    return Math.round(n * 1e4) / 1e4;
}

/**
 * The process-wide store singleton, lazily bound to the shared `genie.db` on
 * first use (both the desktop shell and the headless host-core call
 * `initDatabase` before any knowledge op, so the migration has run). Everyone —
 * the MCP `knowledge` tool, the `knowledge.*` IPC handlers — shares this one
 * instance; boot wires its change emitter to the renderer broadcast.
 */
let store: KnowledgeStore | null = null;
export function getKnowledgeStore(): KnowledgeStore {
    if (!store) store = new KnowledgeStore(getDb());
    return store;
}
