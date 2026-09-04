import { slugify, type UnresolvedReason } from './types';

/**
 * NAMESPACED link resolution (knowledge graph spec §4.5) — PURE.
 *
 * An edge's `to_ref` is raw authored text (a node id, a title, a slug) resolved
 * against the live node set at read time. The resolver this replaces mapped
 * `lower(title) → id` in a plain loop, so when two nodes shared a title the LAST
 * row scanned silently won. At one workstation's own notes that is invisible. The
 * moment two Knowledge Packs each ship a node titled "Volume 1" — and the real
 * pack shape is exactly *an index node plus Volumes 1..N* — an index node's
 * `[[Volume 1]]` links into the OTHER pack's volume, with no error and no visible
 * symptom except an agent reading the wrong text.
 *
 * The rule: an edge resolves **inside its own pack first**, reaches another pack
 * **only** through an explicit `pack:` ref, reaches the user's own notes **only**
 * through an explicit `local:` ref, and **ambiguity resolves to NOTHING rather
 * than to a guess**.
 *
 * That last part is a behaviour change for existing installs, and it is safe in
 * one direction only — which is the direction that matters: it can turn a *wrong*
 * link into *no* link, never a right link into a wrong one. The db migration
 * audits every edge once before it goes live and records the ones it changes, so
 * the graph does not quietly get sparser (§6.5).
 *
 * A non-resolution is REPORTED, never swallowed: a silent mis-link is the failure
 * this exists to prevent, and a silent *non*-link would be the same fault wearing
 * the fix's clothes.
 *
 * Pure (no database, no electron) so the ladder can be pinned on plain rows, and
 * so `db.ts` can run it inside the one-time audit without importing the store.
 */

/** The namespace Genie's OWN projected guides/skills live under (spec §5.1).
 *  Reachable from a pack by a bare title (rule 5) and by `pack:genie/…`. */
export const MANAGED_NS = 'genie';

/** `[[pack:<ns>/<key>]]` — the deliberate OUTWARD link, to any managed namespace. */
const PACK_PREFIX = /^pack:/i;
/** `[[local:<title-or-slug>]]` — the deliberate link to the USER's own nodes. */
const LOCAL_PREFIX = /^local:/i;

/** The columns resolution actually reads. */
export interface ResolvableNode {
    id: string;
    title: string;
    slug: string;
    /** The pack (or `genie`) this node belongs to; null for a node the user or a
     *  local agent wrote. */
    originNs: string | null;
    /** `'<ns>/<key>'`; null for a non-managed node. */
    originKey: string | null;
}

/**
 * WHY a ref did not resolve. The type is declared in `types.ts` (it crosses the
 * IPC and MCP boundaries); what the three values MEAN here is:
 *
 *   - `ambiguous`         — several candidates in the allowed set; resolving to
 *                           one of them would be the guess this rule removes.
 *   - `out-of-namespace`  — candidates exist, but only where this ref is not
 *                           allowed to reach (another pack, or a pack when the
 *                           ref said `local:`).
 *   - `missing`           — nothing anywhere. Also how a FORWARD reference reads,
 *                           which is normal: it links up once the target exists.
 */
export type { UnresolvedReason };

export interface LinkResolution {
    /** The resolved node id, or null. */
    id: string | null;
    /** Absent when it resolved. */
    reason?: UnresolvedReason;
    /** How many candidates were seen — 0 for a clean miss, ≥2 for `ambiguous`,
     *  ≥1 for `out-of-namespace`. What the window shows beside the ref. */
    candidates: number;
}

/** Resolve one ref, from a node whose pack namespace is `fromNs` (null = local). */
export type LinkResolver = (fromNs: string | null, ref: string) => LinkResolution;

const MISSING: LinkResolution = { id: null, reason: 'missing', candidates: 0 };

/** A title/slug index over one subset of the nodes. */
interface Pool {
    byTitle: Map<string, string[]>;
    bySlug: Map<string, string[]>;
}

function emptyPool(): Pool {
    return { byTitle: new Map(), bySlug: new Map() };
}

function push(map: Map<string, string[]>, key: string, id: string): void {
    if (!key) return;
    const list = map.get(key);
    if (list) list.push(id);
    else map.set(key, [id]);
}

function index(pool: Pool, n: ResolvableNode): void {
    push(pool.byTitle, n.title.toLowerCase(), n.id);
    push(pool.bySlug, n.slug || slugify(n.title), n.id);
}

/** Candidate ids for `ref` in one pool — title tier first, then slug tier. */
function candidatesIn(pool: Pool, ref: string): string[] {
    const byTitle = pool.byTitle.get(ref.toLowerCase());
    if (byTitle?.length) return byTitle;
    return pool.bySlug.get(slugify(ref)) ?? [];
}

/**
 * Unique-or-null within one pool. `outside` (when given) is the wider set used
 * ONLY to tell "nothing exists" from "it exists somewhere you may not reach" —
 * the distinction that makes an unresolved link diagnosable.
 */
function unique(pool: Pool, ref: string, outside?: Pool): LinkResolution {
    const hits = candidatesIn(pool, ref);
    if (hits.length === 1) return { id: hits[0], candidates: 1 };
    if (hits.length > 1) return { id: null, reason: 'ambiguous', candidates: hits.length };
    if (outside) {
        const elsewhere = candidatesIn(outside, ref);
        if (elsewhere.length) {
            return { id: null, reason: 'out-of-namespace', candidates: elsewhere.length };
        }
    }
    return MISSING;
}

/**
 * Build a resolver over a node set. One pass builds every index, so resolving an
 * edge afterwards is a map lookup rather than a scan.
 */
export function buildLinkResolver(nodes: ResolvableNode[]): LinkResolver {
    const byId = new Set<string>();
    const byOriginKey = new Map<string, string>();
    /** Everything — rule 6's pool, and the "does it exist at all?" reference. */
    const all = emptyPool();
    /** `origin_ns IS NULL` — the user's own nodes; rule 3's pool. */
    const local = emptyPool();
    /** Non-pack nodes plus Genie's own managed corpus; rule 5's pool. */
    const localOrManaged = emptyPool();
    /** One pool per pack; rule 4's. */
    const perNs = new Map<string, Pool>();

    for (const n of nodes) {
        byId.add(n.id);
        if (n.originKey) byOriginKey.set(n.originKey, n.id);
        index(all, n);
        if (n.originNs === null) {
            index(local, n);
            index(localOrManaged, n);
        } else if (n.originNs === MANAGED_NS) {
            index(localOrManaged, n);
        }
        if (n.originNs) {
            let pool = perNs.get(n.originNs);
            if (!pool) perNs.set(n.originNs, (pool = emptyPool()));
            index(pool, n);
        }
    }

    return (fromNs: string | null, rawRef: string): LinkResolution => {
        const ref = String(rawRef ?? '').trim();
        if (!ref) return MISSING;

        // 1. An exact node id. Unambiguous by construction.
        if (byId.has(ref)) return { id: ref, candidates: 1 };

        // 2. `pack:<ns>/<key>` — the deliberate outward link, resolved against
        //    origin_key ONLY. No title fallback: the whole value of the explicit
        //    form is that it means one thing, and a fallback would quietly turn a
        //    typo into a link to something else.
        if (PACK_PREFIX.test(ref)) {
            const key = ref.replace(PACK_PREFIX, '').trim();
            const hit = key ? byOriginKey.get(key) : undefined;
            return hit ? { id: hit, candidates: 1 } : MISSING;
        }

        // 3. `local:<title>` — the buyer's OWN nodes, and nothing else. It is
        //    `local:` rather than `global:` because "global" would suggest
        //    searching every pack, which is the exact thing rules 4 and 5 exist
        //    to prevent. A miss here is NORMAL: a publisher cannot know what the
        //    buyer titled anything (§4.5.1).
        if (LOCAL_PREFIX.test(ref)) {
            const target = ref.replace(LOCAL_PREFIX, '').trim();
            if (!target) return MISSING;
            return unique(local, target, all);
        }

        if (fromNs) {
            // 4. Inside its own pack first — by the pack's own key, then by title
            //    or slug among that pack's nodes.
            const own = byOriginKey.get(`${fromNs}/${slugify(ref)}`);
            if (own) return { id: own, candidates: 1 };
            const inPack = unique(perNs.get(fromNs) ?? emptyPool(), ref);
            if (inPack.id) return inPack;
            // An ambiguity INSIDE the pack is a real ambiguity. Falling outward
            // from it would resolve a link the pack itself could not.
            if (inPack.reason === 'ambiguous') return inPack;

            // 5. Then non-pack nodes and Genie's own corpus — so a pack picks up
            //    Genie's guidance for free. ANOTHER PACK IS NEVER A CANDIDATE: a
            //    bare title must not create an implicit cross-pack link, and rule
            //    2 is the only way to make one.
            return unique(localOrManaged, ref, all);
        }

        // 6. A local node resolves across everything — the user can see both ends
        //    and wrote the link themselves — but ambiguity is still null.
        return unique(all, ref);
    };
}

/**
 * The resolver as it behaved BEFORE namespacing: lowercase title → id with the
 * last row silently winning, then slug, same precedence as `store.ts` shipped.
 *
 * It exists for exactly one caller — the one-time link audit (§6.5), which has to
 * know what each edge USED to resolve to in order to report what the new rule
 * changes. Nothing else may use it, and nothing else should: it is the bug.
 */
export function buildLegacyResolver(
    nodes: Array<{ id: string; title: string; slug: string }>,
): (ref: string) => { id: string | null; candidates: number } {
    const byId = new Set<string>();
    const byTitle = new Map<string, string>();
    const titleCount = new Map<string, number>();
    const bySlug = new Map<string, string>();
    for (const n of nodes) {
        byId.add(n.id);
        const t = n.title.toLowerCase();
        byTitle.set(t, n.id); // last row wins — the behaviour being retired
        titleCount.set(t, (titleCount.get(t) ?? 0) + 1);
        if (n.slug) bySlug.set(n.slug, n.id);
    }
    return (rawRef: string) => {
        const ref = String(rawRef ?? '').trim();
        if (!ref) return { id: null, candidates: 0 };
        if (byId.has(ref)) return { id: ref, candidates: 1 };
        const key = ref.toLowerCase();
        const t = byTitle.get(key);
        if (t) return { id: t, candidates: titleCount.get(key) ?? 1 };
        const s = bySlug.get(slugify(ref));
        return s ? { id: s, candidates: 1 } : { id: null, candidates: 0 };
    };
}
