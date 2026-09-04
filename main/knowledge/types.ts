/**
 * Shared Knowledge Graph data types — the wire shapes crossing the main↔renderer
 * IPC boundary AND the MCP tool boundary, plus the small pure helpers the store
 * uses. Pure (no electron / no better-sqlite3) so the store, the MCP protocol,
 * and the tests can import them freely and the surface stays unit-testable.
 *
 * The Knowledge Graph is Genie's WORKSTATION-WIDE, local knowledge/memory store:
 * ONE store shared across every workspace on this Genie instance. Nodes are
 * markdown "memories"; `[[wikilink]]` references between them form the graph's
 * edges. Two consumers read/write it — local AGENTS via the `knowledge` MCP tool
 * (source `agent`) and a renderer WINDOW via `knowledge.*` IPC (source `user`).
 */

import type { GenieScope, GenieScopeKind } from '../genie-scope';

// Re-exported so every knowledge consumer — the store, the MCP protocol, the
// renderer — takes the scope ladder from ONE definition rather than declaring a
// second one that agrees today.
export type { GenieScope, GenieScopeKind };

/** Who authored a node — an agent (via the MCP tool) or the user (via the window). */
export type KnowledgeSource = 'agent' | 'user';

/**
 * WHERE a node's text came from, which is a different question from who typed it
 * (`source`) and from whose reasoning it belongs in (`scope`).
 *
 *   local — the user or a local agent wrote it. Genie never rewrites it.
 *   genie — projected from Genie's own guides/skills, authored in this repo.
 *   pack  — installed from a Knowledge Pack, authored by a publisher.
 *
 * It decides one thing today: which nodes a `[[wikilink]]` inside this one is
 * allowed to reach (see `resolve.ts`). Everything else it is for — convergence,
 * pending updates, uninstall — comes later.
 */
export type KnowledgeOrigin = 'local' | 'genie' | 'pack';

/**
 * WHY a `[[wikilink]]` did not resolve to a node.
 *
 * Lives here rather than in `resolve.ts` because it crosses the IPC and MCP
 * boundaries with the node it describes, and `resolve.ts` imports this module.
 */
export type UnresolvedReason = 'ambiguous' | 'missing' | 'out-of-namespace';

/**
 * A link that went nowhere, and what to say about it.
 *
 * Ambiguity now resolves to NOTHING instead of to whichever row was scanned last.
 * That trade is only an improvement if the drop is VISIBLE: a silent mis-link is
 * the failure the rule exists to prevent, and a silent non-link would be the same
 * fault wearing the fix's clothes. So every read carries these beside `links`.
 */
export interface UnresolvedLink {
    /** The authored ref, verbatim — what the user actually typed between `[[]]`. */
    ref: string;
    reason: UnresolvedReason;
    /** How many nodes could have matched. ≥2 means "pick one and say which". */
    candidates: number;
}

/**
 * WHICH memory this node is (Tynn #250).
 *
 * One store answered one question — "find a node matching this text" — which
 * collapses four genuinely different retrieval problems into one:
 *
 *   profile     — what does the user prefer / what is true of them?
 *   episodic    — what happened, and when?
 *   procedural  — what was learned from doing this before?
 *   knowledge   — where is this in the documents?
 *
 * "What does Wish prefer?" and "find the section about X in 8,000 documents" are
 * not the same query with a different string, and an agent that cannot say which
 * it is asking gets the other one's answers. The graph stays ONE graph —
 * `[[wikilinks]]` cross classes freely — only retrieval learns which problem it
 * is solving.
 */
export type MemoryClass = 'profile' | 'episodic' | 'procedural' | 'knowledge';

export const MEMORY_CLASSES: readonly MemoryClass[] = [
    'profile',
    'episodic',
    'procedural',
    'knowledge',
];

/** The class a node gets when nothing says otherwise — and what every node
 *  written before this existed is. A note filed as `knowledge` is findable; one
 *  mis-filed as `profile` would start answering "what does the user prefer?". */
export const DEFAULT_MEMORY_CLASS: MemoryClass = 'knowledge';

export function isMemoryClass(v: unknown): v is MemoryClass {
    return typeof v === 'string' && (MEMORY_CLASSES as readonly string[]).includes(v);
}

/**
 * A single knowledge node ("memory"). `links` are the ids of the nodes this one
 * references — resolved from the node's `[[wikilink]]`s + any explicit links —
 * and each resolved link is a graph EDGE (this node → the linked node).
 */
export interface KnowledgeNode {
    /** Stable uuid. */
    id: string;
    title: string;
    /** Markdown body; `[[wikilink]]`s in here become edges. */
    body: string;
    tags: string[];
    /** Ids of the nodes this one links to (resolved edges out of this node). */
    links: string[];
    /** Refs in this node that resolved to nothing, and why (spec §4.5). */
    unresolved: UnresolvedLink[];
    source: KnowledgeSource;
    /** Which memory this is (Tynn #250). */
    class: MemoryClass;
    /** Whose reasoning this belongs in. NOT a permission — see `genie-scope.ts`. */
    scope: GenieScope;
    /** Where the text came from. */
    origin: KnowledgeOrigin;
    /** The managed namespace this node belongs to (`genie`, or a pack id), or
     *  null for a node the user or a local agent wrote. */
    ns: string | null;
    /** Epoch ms. */
    createdAt: number;
    updatedAt: number;
}

/** One search hit — a node matched by the keyword (FTS) retrieval. */
export interface KnowledgeSearchResult {
    id: string;
    title: string;
    /** A short excerpt of the body around the match. */
    snippet: string;
    /** Relevance score — higher is a better match. */
    score: number;
    tags: string[];
    /** Which memory this hit is — so a caller can tell a preference from a
     *  document without a second lookup. */
    class: MemoryClass;
    /** Whose reasoning it belongs in, so a hit found under `scope: 'all'` is
     *  attributable without a second lookup. */
    scope: GenieScope;
    /** The managed namespace, or null. Two packs may legitimately both ship a
     *  "Volume 1"; without this a hit cannot be told from its twin. */
    ns: string | null;
}

/**
 * A resolved graph edge: a directed link from the node that CONTAINS the link
 * (`source`) to the node it points at (`target`). The `source`/`target` naming
 * matches the convention force-graph renderers expect, so the Knowledge Graph
 * window's GraphView can consume `graph()` directly.
 */
export interface KnowledgeEdge {
    source: string;
    target: string;
}

/** The whole graph — every node + every resolved edge (both ends existing). */
export interface KnowledgeGraph {
    nodes: KnowledgeNode[];
    edges: KnowledgeEdge[];
}

/** Input to create a node. `source` is stamped by the caller (agent vs user). */
export interface KnowledgeAddInput {
    title: string;
    body?: string;
    tags?: string[];
    /** Explicit link targets — a node id, title, or slug (resolved like a wikilink). */
    links?: string[];
    source: KnowledgeSource;
    /** Defaults to {@link DEFAULT_MEMORY_CLASS}. */
    class?: MemoryClass;
    /** Defaults to `system`. The MCP surface defaults an agent's writes to its own
     *  workspace instead — a default does more encouraging than any amount of
     *  prose, and an agent's notes usually belong where it is working. */
    scope?: GenieScope;
}

/** Patch to update a node — only the provided fields change. */
export interface KnowledgeUpdateInput {
    title?: string;
    body?: string;
    tags?: string[];
    links?: string[];
    /** Refile the node under a different memory class. Absent leaves it alone;
     *  an unknown value is REFUSED, exactly as on `add`. */
    class?: MemoryClass;
    /** Move the node to a different scope. Absent leaves it alone. */
    scope?: GenieScope;
}

/**
 * WHICH SCOPES a read covers.
 *
 * Three states, and the difference between the first two matters:
 *
 *   - the option ABSENT entirely  — no scope filtering at all. Every caller that
 *     existed before scope did keeps seeing exactly what it saw, and it is what
 *     the human window wants: the whole workstation store is the thing it is a
 *     window onto.
 *   - present with no `kind`      — the CALLER DEFAULT: `system`, plus its own
 *     workspace, plus its own app. This is what an agent gets when it does not
 *     ask, and it is the whole point — an agent's context stops being polluted by
 *     knowledge it has no business acting on.
 *   - present with a `kind`       — that one rung, or `all` for everything.
 *
 * ★ `all` IS ALWAYS ALLOWED, from any caller. Scope is noise reduction, not a
 * security boundary (see `genie-scope.ts`).
 */
export interface KnowledgeScopeFilter {
    /** One rung, or `all`. Absent means the caller default described above. */
    kind?: GenieScopeKind | 'all';
    /** The caller's workspace — what `workspace` matches against. A caller with
     *  none asking for `workspace` gets every workspace's nodes rather than an
     *  empty page; "knowledge scoped to some workspace" is still a useful answer,
     *  and refusing would be treating scope as a boundary. */
    workspaceId?: string | null;
    /** The caller's GApp — what `gapp` matches against. */
    appId?: string | null;
}

/** Options for a keyword search. */
export interface KnowledgeSearchOptions {
    query: string;
    limit?: number;
    /** Restrict hits to nodes carrying ALL of these tags. */
    tags?: string[];
    /** Restrict to ONE memory class. Absent searches every class, so existing
     *  callers keep finding exactly what they found before. */
    class?: MemoryClass;
    /** Which scopes to cover. Absent covers every scope. */
    scope?: KnowledgeScopeFilter;
    /** An opaque cursor from a previous page's `nextCursor`. */
    cursor?: string;
}

/** Options for a plain node list. */
export interface KnowledgeListOptions {
    /** Restrict to nodes carrying this tag. */
    tag?: string;
    limit?: number;
    /**
     * Restrict to ONE memory class. Absent lists every class, so existing
     * callers keep seeing exactly what they saw before.
     *
     * Recency-ordered listing is how EPISODIC memory is actually read — "what
     * happened recently?" has no query string to search for — so this is the
     * class filter that makes that question answerable at all.
     */
    class?: MemoryClass;
    /** Which scopes to cover. Absent covers every scope. */
    scope?: KnowledgeScopeFilter;
    /** An opaque cursor from a previous page's `nextCursor`. */
    cursor?: string;
}

/**
 * One link the tightened resolver stopped resolving (spec §6.5).
 *
 * Titles are for display and are null when the node has since been deleted — the
 * audit ROW is the record, and it outlives the nodes it describes.
 */
export interface LinkAuditEntry {
    fromId: string;
    fromTitle: string | null;
    /** The authored ref, verbatim. */
    toRef: string;
    /** What last-row-wins used to pick — which may or may not be what was meant,
     *  and that is the point: nobody could tell before. */
    wasId: string;
    wasTitle: string | null;
    candidates: number;
}

/** One page of nodes, plus where the next page starts (null at the end). */
export interface KnowledgeNodePage {
    nodes: KnowledgeNode[];
    nextCursor: string | null;
}

/** One page of search hits, plus where the next page starts (null at the end). */
export interface KnowledgeSearchPage {
    results: KnowledgeSearchResult[];
    nextCursor: string | null;
}

/** The store's outbound "something changed" event (wired to a renderer broadcast
 *  at boot so an open Knowledge Graph window live-refreshes; a test passes a spy). */
export interface KnowledgeChangeEvent {
    action: 'add' | 'update' | 'delete' | 'link';
    /** The affected node id, when the action targets one. */
    id?: string;
}

/**
 * Slugify a title into a stable, comparable key: lowercase, non-alphanumerics
 * collapsed to single dashes, edges trimmed. Used to resolve `[[wikilink]]`s and
 * explicit link refs to a node by a forgiving, case/space-insensitive match.
 */
export function slugify(raw: string | undefined | null): string {
    return String(raw ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Extract the distinct `[[wikilink]]` targets from a markdown body. Supports a
 * `[[Target|alias]]` display form (the part before `|` is the target). Returns
 * the raw inner targets (trimmed, de-duplicated, order preserved) — resolution to
 * node ids happens against the live node set in the store.
 */
export function parseWikilinks(body: string | undefined | null): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const re = /\[\[([^\]]+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(String(body ?? ''))) !== null) {
        const target = m[1].split('|')[0].trim();
        if (!target) continue;
        const key = target.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(target);
    }
    return out;
}

/** Normalise a tag list: trim, drop empties, de-duplicate (case-insensitive). */
export function normalizeTags(tags: unknown): string[] {
    if (!Array.isArray(tags)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const t of tags) {
        const tag = String(t ?? '').trim();
        if (!tag) continue;
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
    }
    return out;
}
