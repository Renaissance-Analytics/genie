import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../db';
import { parseGenieScope, scopeRefOf, type GenieScope } from '../genie-scope';
import { buildLinkResolver, type LinkResolver, type ResolvableNode } from './resolve';
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
    type KnowledgeNodePage,
    type KnowledgeOrigin,
    type KnowledgeScopeFilter,
    type KnowledgeSearchOptions,
    type KnowledgeSearchPage,
    type KnowledgeSearchResult,
    type KnowledgeSource,
    type KnowledgeUpdateInput,
    type LinkAuditEntry,
    type MemoryClass,
    type UnresolvedLink,
    isMemoryClass,
    DEFAULT_MEMORY_CLASS,
} from './types';

/**
 * The Knowledge Graph store — Genie's WORKSTATION-WIDE local knowledge/memory
 * store, backed by the shared `genie.db` (SQLite via better-sqlite3, in Genie's
 * userData dir — ONE store across every workspace). Persists markdown "memory"
 * nodes, keyword-searches them with SQLite FTS5, and turns each node's
 * `[[wikilink]]` references into graph edges.
 *
 * Schema is created by the db.ts migrations (v22, v38, v68): `knowledge_nodes`,
 * the `knowledge_nodes_fts` FTS5 virtual table (manually kept in sync here), and
 * `knowledge_edges`. The class takes a Database so a test can drive it against a
 * fresh `:memory:` db (runMigrations + new KnowledgeStore(db)); production uses
 * the shared handle via {@link getKnowledgeStore}.
 *
 * SCOPE. A node says whose reasoning it belongs in — `system | workspace | gapp`
 * — and reads narrow to the caller's own by default. It is NOISE REDUCTION, NOT A
 * SECURITY BOUNDARY: any caller may pass `all` and read every node on the
 * machine, and this store will not refuse it (see `../genie-scope.ts`). Scope
 * narrowing happens in the SQL `WHERE`, never after the fact — filtering
 * thousands of FTS candidates in JavaScript returns an empty page while matches
 * exist, which is a worse failure than the noise it was meant to remove.
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
 * Resolution is NAMESPACED (`resolve.ts`): a node's links resolve inside its own
 * managed namespace first, reach another one only through an explicit `pack:`
 * ref, and AMBIGUITY RESOLVES TO NOTHING rather than to whichever row was scanned
 * last. What did not resolve rides back as `unresolved[]` beside `links` — a
 * silent non-link would be the same fault as the silent mis-link this replaces.
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
            .prepare<[string], NodeRow>('SELECT rowid AS rid, * FROM knowledge_nodes WHERE id = ?')
            .get(id);
        if (!row) return null;
        const index = this.buildIndex();
        return this.toNode(row, this.linksFor(row.id, row.origin_ns, index.resolver));
    }

    /**
     * List nodes newest-first (by `updatedAt`). `tag` restricts to nodes carrying
     * that tag (case-insensitive); `class` restricts to ONE memory class (absent
     * lists every class); `scope` narrows to the caller's scopes (absent covers
     * every scope); `limit` caps the count (default 200).
     *
     * This is EPISODIC memory's read path. "What happened recently?" is ordered
     * by recency and has no query string to search for, so a class filter here is
     * what makes that question askable — `search` cannot answer it.
     */
    list(opts: KnowledgeListOptions = {}): KnowledgeNode[] {
        return this.listPage(opts).nodes;
    }

    /**
     * One page of {@link list}, plus where the next page starts.
     *
     * The cursor is a KEYSET on `(updated_at, rowid)` — the same pair the ordering
     * already tiebreaks on — rather than an offset, because offset paging over
     * tens of thousands of rows re-scans everything before the page on every
     * request.
     */
    listPage(opts: KnowledgeListOptions = {}): KnowledgeNodePage {
        const limit = opts.limit && opts.limit > 0 ? opts.limit : 200;
        const tag = opts.tag?.trim();
        const filterClass = isMemoryClass(opts.class) ? opts.class : undefined;

        const where: string[] = [];
        const params: Array<string | number> = [];
        if (filterClass) {
            where.push('class = ?');
            params.push(filterClass);
        }
        const scope = scopeClause(opts.scope, '');
        if (scope.sql) {
            where.push(scope.sql);
            params.push(...scope.params);
        }
        if (tag) {
            where.push(`EXISTS (
                SELECT 1 FROM json_each(knowledge_nodes.tags) je
                WHERE lower(je.value) = lower(?)
            )`);
            params.push(tag);
        }
        const after = decodeKeyset(opts.cursor);
        if (after) {
            where.push('(updated_at < ? OR (updated_at = ? AND rowid < ?))');
            params.push(after.updatedAt, after.updatedAt, after.rowid);
        }
        // One more than asked for, so "is there another page?" is answered by the
        // same query rather than by a second count.
        params.push(limit + 1);

        // `rowid DESC` is a stable tiebreaker (insertion order) so "newest-first"
        // stays deterministic even for nodes written in the same millisecond.
        const rows = this.db
            .prepare<Array<string | number>, NodeRow>(
                `SELECT rowid AS rid, * FROM knowledge_nodes
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
            )
            .all(...params);

        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
            nodes: this.nodesFrom(page),
            nextCursor: rows.length > limit && last ? encodeKeyset(last.updated_at, last.rid) : null,
        };
    }

    /**
     * Keyword search over the nodes. FTS5 (prefix-OR of the query's terms, ranked
     * by bm25) is the primary path; a LIKE scan is the fallback when the query has
     * no indexable terms or FTS returns nothing. `class` and `scope` narrow inside
     * SQL; `tags` (optional) further narrows hits to nodes carrying ALL of the
     * given tags. Returns hits best-first.
     */
    search(opts: KnowledgeSearchOptions): KnowledgeSearchResult[] {
        return this.searchPage(opts).results;
    }

    /**
     * One page of {@link search}, plus where the next page starts.
     *
     * ★ The cursor here is an OFFSET, not the keyset `listPage` uses, and that is
     * deliberate rather than an oversight. A keyset needs the sort key in the
     * `WHERE`, and this ordering's key is `bm25()` — computed per query, stored in
     * no column and indexable by nothing. The FTS `MATCH` already bounds the
     * candidate set, so an offset inside it re-scans a bounded list rather than
     * the table.
     *
     * The honest limitation: `tags` is still narrowed after the fetch (it needs
     * `json_each`), so a deep page of a heavily tag-filtered search can come up
     * short of `limit` while further hits exist. `class` and `scope` — the two
     * that would actually starve a caller — are in the SQL.
     */
    searchPage(opts: KnowledgeSearchOptions): KnowledgeSearchPage {
        const raw = String(opts.query ?? '').trim();
        const limit = opts.limit && opts.limit > 0 ? opts.limit : 20;
        const offset = decodeOffset(opts.cursor);
        const filterTags = normalizeTags(opts.tags).map((t) => t.toLowerCase());
        const narrow = narrowClause(opts.class, opts.scope);

        // Only TAGS are post-filtered now, so only tags need the over-fetch.
        const need = offset + limit + 1;
        const candidates = filterTags.length ? Math.max(need * 5, 50) : need;

        let hits = this.ftsSearch(raw, candidates, narrow);
        if (hits.length === 0) hits = this.likeSearch(raw, candidates, narrow);

        const narrowed = filterTags.length
            ? hits.filter((h) => {
                  const have = new Set(h.tags.map((t) => t.toLowerCase()));
                  return filterTags.every((t) => have.has(t));
              })
            : hits;

        return {
            results: narrowed.slice(offset, offset + limit),
            nextCursor: narrowed.length > offset + limit ? encodeOffset(offset + limit) : null,
        };
    }

    /** The whole graph — every node + every resolved edge (both ends existing). */
    graph(): KnowledgeGraph {
        const rows = this.db
            .prepare<[], NodeRow>(
                'SELECT rowid AS rid, * FROM knowledge_nodes ORDER BY updated_at DESC, rowid DESC',
            )
            .all();
        const index = this.buildIndex();
        // ONE edge fetch, shared. This is the whole store, so a per-page `IN (…)`
        // sweep would be strictly more work than a single scan — and doing both
        // (once for the nodes, once for the edges) would be twice.
        const edgeRows = this.db
            .prepare<[], { from_id: string; to_ref: string }>(
                'SELECT from_id, to_ref FROM knowledge_edges',
            )
            .all();
        const byFrom = new Map<string, string[]>();
        for (const e of edgeRows) {
            const list = byFrom.get(e.from_id);
            if (list) list.push(e.to_ref);
            else byFrom.set(e.from_id, [e.to_ref]);
        }
        const nodes = this.nodesFrom(rows, index, byFrom);
        // Edges use source/target (the force-graph convention): source = the node
        // that CONTAINS the link, target = the node it points at.
        const edges: KnowledgeEdge[] = [];
        const seen = new Set<string>();
        for (const e of edgeRows) {
            // An edge resolves from ITS OWN source node's namespace — the same
            // ladder `linksFor` walks, so the graph view and the node view can
            // never disagree about what links to what.
            const target = index.resolver(index.nsById.get(e.from_id) ?? null, e.to_ref).id;
            if (!target || target === e.from_id) continue;
            const key = `${e.from_id}->${target}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({ source: e.from_id, target });
        }
        return { nodes, edges };
    }

    /**
     * The links the tightened resolver stopped resolving, still unreviewed
     * (spec §6.5).
     *
     * Ambiguous refs used to resolve to whichever row was scanned last and now
     * resolve to nothing. That is safer in the only direction that matters, but a
     * graph that quietly gets sparser is exactly the silent change this design
     * objects to everywhere else — so the migration recorded each one, and this is
     * how the window says it out loud.
     *
     * Empty is the expected result on most machines. Titles are joined in for
     * display and are null when a node has since been deleted: the AUDIT row is
     * the record, and it outlives the nodes it describes.
     */
    linkAudit(): LinkAuditEntry[] {
        return this.db
            .prepare<[], LinkAuditRow>(
                `SELECT a.from_id, a.to_ref, a.was_id, a.candidates,
                        f.title AS from_title, w.title AS was_title
                   FROM knowledge_link_audit a
                   LEFT JOIN knowledge_nodes f ON f.id = a.from_id
                   LEFT JOIN knowledge_nodes w ON w.id = a.was_id
                  WHERE a.reviewed_at IS NULL
                  ORDER BY a.from_id, a.to_ref`,
            )
            .all()
            .map((r) => ({
                fromId: r.from_id,
                fromTitle: r.from_title ?? null,
                toRef: r.to_ref,
                wasId: r.was_id,
                wasTitle: r.was_title ?? null,
                candidates: r.candidates,
            }));
    }

    /** Mark every outstanding audit row reviewed. The rows are KEPT — the notice
     *  is dismissed, the finding is not, so "I dismissed it and now I want it
     *  back" has an answer. */
    dismissLinkAudit(): { ok: boolean; reviewed: number } {
        const info = this.db
            .prepare('UPDATE knowledge_link_audit SET reviewed_at = ? WHERE reviewed_at IS NULL')
            .run(Date.now());
        return { ok: true, reviewed: info.changes };
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
        // REFUSED, not coerced. Silently filing a node under the wrong memory is
        // worse than rejecting the write: it answers a question nobody asked and
        // there is nothing in the result to notice it by.
        if (input.class !== undefined && !isMemoryClass(input.class)) {
            throw new Error(
                `knowledge: unknown memory class ${JSON.stringify(input.class)} — expected profile, episodic, procedural or knowledge`,
            );
        }
        const memoryClass: MemoryClass = input.class ?? DEFAULT_MEMORY_CLASS;
        // Scope is NOT refused the same way, on purpose: a wrong class answers the
        // wrong question, while a wide scope only returns more than you wanted.
        const scope: GenieScope = input.scope ?? { kind: 'system' };
        this.db
            .prepare(
                `INSERT INTO knowledge_nodes
                     (id, title, slug, body, tags, source, class, scope_kind, scope_ref, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                id,
                title,
                slugify(title),
                body,
                JSON.stringify(tags),
                source,
                memoryClass,
                scope.kind,
                scopeRefOf(scope),
                now,
                now,
            );
        this.ftsInsert(id, title, body, tags);
        this.setEdges(id, 'wiki', parseWikilinks(body));
        this.setEdges(id, 'explicit', input.links ?? []);
        this.emit({ action: 'add', id });
        return this.get(id)!;
    }

    /** Patch a node — only provided fields change; edges recompute as needed. */
    update(id: string, patch: KnowledgeUpdateInput): KnowledgeNode | null {
        const existing = this.db
            .prepare<[string], NodeRow>('SELECT rowid AS rid, * FROM knowledge_nodes WHERE id = ?')
            .get(id);
        if (!existing) return null;

        if (patch.class !== undefined && !isMemoryClass(patch.class)) {
            throw new Error(
                `knowledge: unknown memory class ${JSON.stringify(patch.class)} — expected profile, episodic, procedural or knowledge`,
            );
        }

        const title = patch.title !== undefined ? patch.title.trim() : existing.title;
        const body = patch.body !== undefined ? patch.body : existing.body;
        const tags =
            patch.tags !== undefined ? normalizeTags(patch.tags) : (JSON.parse(existing.tags) as string[]);
        const now = Date.now();

        // `class` and `scope` are written ONLY when the patch names them. Writing
        // the parsed-back value every time would push the READ fallback into the
        // row: a `workspace` row whose ref went missing reads as `system` (the
        // safe direction for a read), and rewriting that would silently MOVE the
        // node — a repair nobody asked for, applied by an unrelated title edit.
        const sets = ['title = ?', 'slug = ?', 'body = ?', 'tags = ?', 'updated_at = ?'];
        const params: Array<string | number | null> = [
            title,
            slugify(title),
            body,
            JSON.stringify(tags),
            now,
        ];
        if (patch.class !== undefined) {
            sets.push('class = ?');
            params.push(patch.class);
        }
        if (patch.scope !== undefined) {
            sets.push('scope_kind = ?', 'scope_ref = ?');
            params.push(patch.scope.kind, scopeRefOf(patch.scope));
        }
        params.push(id);
        this.db
            .prepare(`UPDATE knowledge_nodes SET ${sets.join(', ')} WHERE id = ?`)
            .run(...params);
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

    /**
     * One pass over the node set, producing the namespaced resolver plus the
     * `id → namespace` map an edge needs to know which rung of the ladder it
     * starts on.
     */
    private buildIndex(): { resolver: LinkResolver; nsById: Map<string, string | null> } {
        const rows = this.db
            .prepare<
                [],
                {
                    id: string;
                    title: string;
                    slug: string;
                    origin_ns: string | null;
                    origin_key: string | null;
                }
            >('SELECT id, title, slug, origin_ns, origin_key FROM knowledge_nodes')
            .all();
        const nsById = new Map<string, string | null>();
        const resolvable: ResolvableNode[] = rows.map((r) => {
            nsById.set(r.id, r.origin_ns);
            return {
                id: r.id,
                title: r.title,
                slug: r.slug,
                originNs: r.origin_ns,
                originKey: r.origin_key,
            };
        });
        return { resolver: buildLinkResolver(resolvable), nsById };
    }

    /** The resolved outbound links for one node, plus what did not resolve. */
    private linksFor(
        fromId: string,
        fromNs: string | null,
        resolver: LinkResolver,
    ): { links: string[]; unresolved: UnresolvedLink[] } {
        const refs = this.db
            .prepare<[string], { to_ref: string }>(
                'SELECT to_ref FROM knowledge_edges WHERE from_id = ?',
            )
            .all(fromId);
        return resolveRefs(
            refs.map((r) => r.to_ref),
            fromId,
            fromNs,
            resolver,
        );
    }

    /**
     * Map a batch of rows → nodes, sharing one index + one edge fetch.
     *
     * `edges` lets a caller that has already read every edge (only `graph`) hand
     * them in instead of paying for a second, narrower read of the same table.
     */
    private nodesFrom(
        rows: NodeRow[],
        shared?: { resolver: LinkResolver; nsById: Map<string, string | null> },
        edges?: Map<string, string[]>,
    ): KnowledgeNode[] {
        if (rows.length === 0) return [];
        const index = shared ?? this.buildIndex();
        // Only THIS page's edges, not every edge in the store. A 200-node page of
        // a graph holding a quarter of a million edges used to walk all of them.
        const byFrom = edges ?? new Map<string, string[]>();
        if (!edges) {
            for (const chunk of chunked(rows.map((r) => r.id), 400)) {
                const holes = chunk.map(() => '?').join(',');
                const edgeRows = this.db
                    .prepare<string[], { from_id: string; to_ref: string }>(
                        `SELECT from_id, to_ref FROM knowledge_edges WHERE from_id IN (${holes})`,
                    )
                    .all(...chunk);
                for (const e of edgeRows) {
                    const list = byFrom.get(e.from_id);
                    if (list) list.push(e.to_ref);
                    else byFrom.set(e.from_id, [e.to_ref]);
                }
            }
        }
        return rows.map((row) =>
            this.toNode(
                row,
                resolveRefs(byFrom.get(row.id) ?? [], row.id, row.origin_ns, index.resolver),
            ),
        );
    }

    private toNode(
        row: NodeRow,
        resolved: { links: string[]; unresolved: UnresolvedLink[] },
    ): KnowledgeNode {
        return {
            id: row.id,
            title: row.title,
            body: row.body,
            tags: safeTags(row.tags),
            links: resolved.links,
            unresolved: resolved.unresolved,
            source: row.source === 'agent' ? 'agent' : 'user',
            // An unrecognised value on the row — a newer Genie's class, a hand
            // edit — reads as the default rather than being trusted through.
            class: isMemoryClass(row.class) ? row.class : DEFAULT_MEMORY_CLASS,
            scope: parseGenieScope(row.scope_kind, row.scope_ref),
            origin: safeOrigin(row.origin),
            ns: row.origin_ns ?? null,
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
    private ftsSearch(raw: string, limit: number, narrow: SqlFragment): KnowledgeSearchResult[] {
        const expr = buildFtsQuery(raw);
        if (!expr) return [];
        try {
            const rows = this.db
                .prepare<Array<string | number>, FtsRow>(
                    `SELECT n.id AS id, n.title AS title, n.tags AS tags, n.body AS body,
                            n.class AS class, n.scope_kind AS scope_kind, n.scope_ref AS scope_ref,
                            n.origin_ns AS origin_ns,
                            snippet(knowledge_nodes_fts, 2, '', '', '…', 12) AS snip,
                            bm25(knowledge_nodes_fts) AS rank
                     FROM knowledge_nodes_fts
                     JOIN knowledge_nodes n ON n.id = knowledge_nodes_fts.id
                     WHERE knowledge_nodes_fts MATCH ?${narrow.sql ? ` AND ${narrow.sql}` : ''}
                     ORDER BY rank
                     LIMIT ?`,
                )
                .all(expr, ...narrow.params, limit);
            return rows.map((r) => ({
                id: r.id,
                title: r.title,
                snippet: r.snip?.trim() ? r.snip : excerpt(r.body),
                // bm25 is smaller-is-better (typically negative); flip so higher = better.
                score: round(-r.rank),
                tags: safeTags(r.tags),
                class: isMemoryClass(r.class) ? r.class : DEFAULT_MEMORY_CLASS,
                scope: parseGenieScope(r.scope_kind, r.scope_ref),
                ns: r.origin_ns ?? null,
            }));
        } catch {
            // A malformed MATCH expression should never sink the search — the LIKE
            // fallback still returns useful results.
            return [];
        }
    }

    /** Substring fallback when FTS has no indexable terms or finds nothing. */
    private likeSearch(raw: string, limit: number, narrow: SqlFragment): KnowledgeSearchResult[] {
        if (!raw) return [];
        const like = `%${raw.replace(/[%_]/g, (c) => '\\' + c)}%`;
        const rows = this.db
            .prepare<Array<string | number>, NodeRow>(
                // Aliased `n` so it takes the SAME narrowing fragment the FTS path
                // does — one definition of "which nodes this caller asked for",
                // rather than two that agree until one is edited.
                `SELECT n.rowid AS rid, n.* FROM knowledge_nodes n
                 WHERE (n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\' OR n.tags LIKE ? ESCAPE '\\')
                   ${narrow.sql ? `AND ${narrow.sql}` : ''}
                 ORDER BY n.updated_at DESC LIMIT ?`,
            )
            .all(like, like, like, ...narrow.params, limit);
        return rows.map((r) => ({
            id: r.id,
            title: r.title,
            snippet: excerpt(r.body, raw),
            score: 0,
            tags: safeTags(r.tags),
            class: isMemoryClass(r.class) ? r.class : DEFAULT_MEMORY_CLASS,
            scope: parseGenieScope(r.scope_kind, r.scope_ref),
            ns: r.origin_ns ?? null,
        }));
    }
}

// --- row shapes + small helpers -------------------------------------------

interface NodeRow {
    /** `rowid`, aliased — the keyset cursor's stable tiebreaker. */
    rid: number;
    id: string;
    title: string;
    slug: string;
    body: string;
    tags: string;
    source: string;
    class: string;
    scope_kind: string;
    scope_ref: string | null;
    origin: string;
    origin_ns: string | null;
    created_at: number;
    updated_at: number;
}

interface LinkAuditRow {
    from_id: string;
    from_title: string | null;
    to_ref: string;
    was_id: string;
    was_title: string | null;
    candidates: number;
}

interface FtsRow {
    class: string;
    scope_kind: string;
    scope_ref: string | null;
    origin_ns: string | null;
    id: string;
    title: string;
    tags: string;
    body: string;
    snip: string;
    rank: number;
}

/** A `WHERE` fragment and the parameters it consumes, in order. */
interface SqlFragment {
    sql: string;
    params: Array<string | number>;
}

/**
 * The scope predicate, IN SQL.
 *
 * `prefix` is the table alias plus a dot when the query joins (`'n.'`), empty
 * otherwise. Absent filter narrows nothing — every caller written before scope
 * existed keeps seeing what it saw.
 */
function scopeClause(filter: KnowledgeScopeFilter | undefined, prefix: string): SqlFragment {
    if (!filter || filter.kind === 'all') return { sql: '', params: [] };
    const kindCol = `${prefix}scope_kind`;
    const refCol = `${prefix}scope_ref`;
    const ws = filter.workspaceId?.trim() || null;
    const app = filter.appId?.trim() || null;

    if (filter.kind === 'system') return { sql: `${kindCol} = 'system'`, params: [] };
    if (filter.kind === 'workspace') {
        return ws
            ? { sql: `(${kindCol} = 'workspace' AND ${refCol} = ?)`, params: [ws] }
            : { sql: `${kindCol} = 'workspace'`, params: [] };
    }
    if (filter.kind === 'gapp') {
        return app
            ? { sql: `(${kindCol} = 'gapp' AND ${refCol} = ?)`, params: [app] }
            : { sql: `${kindCol} = 'gapp'`, params: [] };
    }

    // No kind: the caller default — the workstation's own knowledge, plus this
    // caller's workspace, plus its app.
    const arms = [`${kindCol} = 'system'`];
    const params: string[] = [];
    if (ws) {
        arms.push(`(${kindCol} = 'workspace' AND ${refCol} = ?)`);
        params.push(ws);
    }
    if (app) {
        arms.push(`(${kindCol} = 'gapp' AND ${refCol} = ?)`);
        params.push(app);
    }
    return { sql: `(${arms.join(' OR ')})`, params };
}

/**
 * Class + scope as one `WHERE` fragment over the joined `knowledge_nodes n`.
 *
 * Both are in SQL rather than applied to the FTS candidates afterwards. The
 * post-filter over-fetched `max(limit*5, 50)` rows and narrowed in JavaScript,
 * which STARVES: on a machine holding thousands of nodes the caller does not want,
 * the over-fetch is entirely those, and the page comes back empty while matches
 * exist. Tags stay post-filtered — they need `json_each`, and a tag is a narrowing
 * the caller opted into rather than one applied to every read.
 */
function narrowClause(
    memoryClass: MemoryClass | undefined,
    scope: KnowledgeScopeFilter | undefined,
): SqlFragment {
    const parts: string[] = [];
    const params: Array<string | number> = [];
    if (isMemoryClass(memoryClass)) {
        parts.push('n.class = ?');
        params.push(memoryClass);
    }
    const s = scopeClause(scope, 'n.');
    if (s.sql) {
        parts.push(s.sql);
        params.push(...s.params);
    }
    return { sql: parts.join(' AND '), params };
}

/** Resolve a node's raw refs, dropping self-links and duplicates. */
function resolveRefs(
    refs: string[],
    fromId: string,
    fromNs: string | null,
    resolver: LinkResolver,
): { links: string[]; unresolved: UnresolvedLink[] } {
    const links: string[] = [];
    const unresolved: UnresolvedLink[] = [];
    const seen = new Set<string>();
    // A node's `wiki` and `explicit` edges may name the same target, so an
    // unresolved ref gets the same de-duplication a resolved one does. Reporting
    // "2 links are ambiguous" about one authored `[[ref]]` would be a miscount in
    // the notice that exists to be trusted.
    const seenRefs = new Set<string>();
    for (const raw of refs) {
        const ref = String(raw ?? '').trim();
        if (!ref) continue;
        const r = resolver(fromNs, ref);
        if (!r.id) {
            const key = ref.toLowerCase();
            if (seenRefs.has(key)) continue;
            seenRefs.add(key);
            unresolved.push({
                ref,
                reason: r.reason ?? 'missing',
                candidates: r.candidates,
            });
            continue;
        }
        if (r.id === fromId || seen.has(r.id)) continue;
        seen.add(r.id);
        links.push(r.id);
    }
    return { links, unresolved };
}

/** Split a list into chunks — SQLite caps how many `?` one statement may bind. */
function chunked<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

/** `(updated_at, rowid)` keyset cursor — opaque to callers, cheap to parse. */
function encodeKeyset(updatedAt: number, rowid: number): string {
    return `k${updatedAt}.${rowid}`;
}

function decodeKeyset(cursor: string | undefined): { updatedAt: number; rowid: number } | null {
    const m = /^k(\d+)\.(\d+)$/.exec(String(cursor ?? ''));
    if (!m) return null;
    return { updatedAt: Number(m[1]), rowid: Number(m[2]) };
}

/** Ranked-search cursor. An offset, for the reason `searchPage` states. */
function encodeOffset(offset: number): string {
    return `o${offset}`;
}

function decodeOffset(cursor: string | undefined): number {
    const m = /^o(\d+)$/.exec(String(cursor ?? ''));
    return m ? Number(m[1]) : 0;
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

/** An unrecognised origin reads as `local` — the value that means "Genie does
 *  not manage this text", which is the safe thing to believe about a row we
 *  cannot interpret. */
function safeOrigin(v: string | null | undefined): KnowledgeOrigin {
    return v === 'genie' || v === 'pack' ? v : 'local';
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
