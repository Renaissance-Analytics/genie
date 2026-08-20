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

/** Who authored a node — an agent (via the MCP tool) or the user (via the window). */
export type KnowledgeSource = 'agent' | 'user';

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
    source: KnowledgeSource;
    /** Which memory this is (Tynn #250). */
    class: MemoryClass;
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
}

/** Patch to update a node — only the provided fields change. */
export interface KnowledgeUpdateInput {
    title?: string;
    body?: string;
    tags?: string[];
    links?: string[];
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
}

/** Options for a plain node list. */
export interface KnowledgeListOptions {
    /** Restrict to nodes carrying this tag. */
    tag?: string;
    limit?: number;
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
