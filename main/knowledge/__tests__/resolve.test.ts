import { describe, expect, it } from 'vitest';
import { buildLinkResolver, MANAGED_NS, type ResolvableNode } from '../resolve';

/**
 * The NAMESPACED link resolution ladder (knowledge graph spec §4.5).
 *
 * The shipped resolver mapped `lower(title) → id` in a plain loop, so the LAST
 * row scanned silently won. At one workstation's own notes that is invisible; the
 * moment two Knowledge Packs each ship a node titled "Volume 1" it is a
 * correctness bug — an index node's `[[Volume 1]]` links into the OTHER pack's
 * volume, with no error and no visible symptom except an agent reading the wrong
 * text.
 *
 * The rule replacing it: an edge resolves inside its own source pack first,
 * reaches another pack only through an explicit `pack:` ref, reaches the user's
 * own notes only through an explicit `local:` ref, and **ambiguity resolves to
 * NOTHING rather than to a guess**.
 *
 * Tested pure: `buildLinkResolver` takes plain rows, so the ladder is pinned
 * without a database and the store test can concentrate on the wiring.
 */

function node(over: Partial<ResolvableNode> & { id: string; title: string }): ResolvableNode {
    return {
        slug: over.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
        originNs: null,
        originKey: null,
        ...over,
    };
}

/** Stunspot's Guide + a second pack + the buyer's own notes — spec §4.5's example. */
function worked(): ResolvableNode[] {
    return [
        node({
            id: 'a-canon',
            title: 'Canon Map',
            originNs: 'ai.stunspot.guide',
            originKey: 'ai.stunspot.guide/canon-map',
        }),
        node({
            id: 'a-v1',
            title: 'Volume 1',
            originNs: 'ai.stunspot.guide',
            originKey: 'ai.stunspot.guide/volume-1',
        }),
        node({
            id: 'a-v3',
            title: 'Volume 3',
            originNs: 'ai.stunspot.guide',
            originKey: 'ai.stunspot.guide/volume-3',
        }),
        node({
            id: 'b-part2',
            title: 'Part 2',
            originNs: 'com.example.gamification',
            originKey: 'com.example.gamification/part-2',
        }),
        node({
            id: 'b-v1',
            title: 'Volume 1',
            originNs: 'com.example.gamification',
            originKey: 'com.example.gamification/volume-1',
        }),
        node({
            id: 'genie-imdone',
            title: 'imDone',
            originNs: MANAGED_NS,
            originKey: `${MANAGED_NS}/guide/imdone`,
        }),
        node({ id: 'mine-reverb', title: 'Reverb' }),
        node({ id: 'mine-v1', title: 'Volume 1' }),
    ];
}

describe('rule 1 — a node id resolves to itself', () => {
    it('takes an exact id over anything else', () => {
        const r = buildLinkResolver(worked());
        expect(r('ai.stunspot.guide', 'mine-reverb')).toEqual({ id: 'mine-reverb', candidates: 1 });
    });
});

describe('rule 2 — `pack:` is the deliberate outward link', () => {
    it('resolves `pack:<ns>/<key>` against origin_key only', () => {
        const r = buildLinkResolver(worked());
        expect(r('com.example.gamification', 'pack:ai.stunspot.guide/volume-1')).toEqual({
            id: 'a-v1',
            candidates: 1,
        });
    });

    it('reaches Genie’s own managed corpus', () => {
        const r = buildLinkResolver(worked());
        expect(r('ai.stunspot.guide', `pack:${MANAGED_NS}/guide/imdone`)).toEqual({
            id: 'genie-imdone',
            candidates: 1,
        });
    });

    it('does NOT fall back to a title match when the key misses', () => {
        // The whole value of the explicit form is that it means one thing. A
        // fallback would quietly turn a typo into a link to something else.
        const r = buildLinkResolver(worked());
        expect(r('com.example.gamification', 'pack:ai.stunspot.guide/volume-99')).toEqual({
            id: null,
            reason: 'missing',
            candidates: 0,
        });
    });
});

describe('rule 3 — `local:` points at the buyer’s own notes', () => {
    it('resolves against non-pack nodes', () => {
        const r = buildLinkResolver(worked());
        expect(r('ai.stunspot.guide', 'local:Reverb')).toEqual({ id: 'mine-reverb', candidates: 1 });
    });

    it('a miss is `missing`, not an error — a publisher cannot know what the buyer titled things', () => {
        const r = buildLinkResolver(worked());
        expect(r('ai.stunspot.guide', 'local:Nothing Here')).toEqual({
            id: null,
            reason: 'missing',
            candidates: 0,
        });
    });

    it('never reaches a pack node, even when only a pack has that title', () => {
        const r = buildLinkResolver(worked());
        // "Part 2" exists — inside pack B. `local:` is the USER's namespace, so
        // this is out-of-namespace rather than a hit.
        expect(r('ai.stunspot.guide', 'local:Part 2')).toEqual({
            id: null,
            reason: 'out-of-namespace',
            candidates: 1,
        });
    });
});

describe('rule 4 — a pack node resolves inside its own pack first', () => {
    it('the index node’s [[Volume 1]] finds ITS pack’s volume, not another pack’s', () => {
        const r = buildLinkResolver(worked());
        expect(r('ai.stunspot.guide', 'Volume 1')).toEqual({ id: 'a-v1', candidates: 1 });
        expect(r('com.example.gamification', 'Volume 1')).toEqual({ id: 'b-v1', candidates: 1 });
    });

    it('matches by origin_key slug as well as by title', () => {
        const r = buildLinkResolver(worked());
        expect(r('ai.stunspot.guide', 'volume-3')).toEqual({ id: 'a-v3', candidates: 1 });
    });

    it('an ambiguity INSIDE the pack resolves to nothing rather than falling outward', () => {
        const nodes = [
            node({ id: 'p1', title: 'Intro', originNs: 'p', originKey: 'p/intro-a' }),
            node({ id: 'p2', title: 'Intro', originNs: 'p', originKey: 'p/intro-b' }),
            node({ id: 'mine', title: 'Intro' }),
        ];
        const r = buildLinkResolver(nodes);
        expect(r('p', 'Intro')).toEqual({ id: null, reason: 'ambiguous', candidates: 2 });
    });
});

describe('rule 5 — a pack falls back to non-pack + Genie nodes, never to another pack', () => {
    it('picks up Genie’s own guidance for free', () => {
        const r = buildLinkResolver(worked());
        expect(r('ai.stunspot.guide', 'imDone')).toEqual({ id: 'genie-imdone', candidates: 1 });
    });

    it('a title only ANOTHER pack has is out-of-namespace, not a link', () => {
        const r = buildLinkResolver(worked());
        expect(r('ai.stunspot.guide', 'Part 2')).toEqual({
            id: null,
            reason: 'out-of-namespace',
            candidates: 1,
        });
    });

    it('positive control — the same ref from a LOCAL node does resolve', () => {
        // Proves the assertion above fails because of the namespace restriction
        // and not because "Part 2" is unreachable in general.
        const r = buildLinkResolver(worked());
        expect(r(null, 'Part 2')).toEqual({ id: 'b-part2', candidates: 1 });
    });
});

describe('rule 6 — a local node resolves globally, but ambiguity is still null', () => {
    it('reaches a pack node by title when it is unambiguous', () => {
        const r = buildLinkResolver(worked());
        expect(r(null, 'Canon Map')).toEqual({ id: 'a-canon', candidates: 1 });
    });

    it('three "Volume 1"s resolve to NOTHING and report all three candidates', () => {
        // The behaviour change from last-row-wins. It can turn a WRONG link into
        // no link; it can never turn a right link into a wrong one.
        const r = buildLinkResolver(worked());
        expect(r(null, 'Volume 1')).toEqual({ id: null, reason: 'ambiguous', candidates: 3 });
    });
});

describe('rule 7 — nothing matched', () => {
    it('reports `missing`, which is also how a forward reference reads', () => {
        const r = buildLinkResolver(worked());
        expect(r(null, 'Not Written Yet')).toEqual({
            id: null,
            reason: 'missing',
            candidates: 0,
        });
    });

    it('a forward reference links up once the target exists', () => {
        const before = buildLinkResolver([node({ id: 'src', title: 'Source' })]);
        expect(before(null, 'Later').id).toBeNull();

        const after = buildLinkResolver([
            node({ id: 'src', title: 'Source' }),
            node({ id: 'later', title: 'Later' }),
        ]);
        expect(after(null, 'Later')).toEqual({ id: 'later', candidates: 1 });
    });

    it('an empty ref is missing rather than a throw', () => {
        const r = buildLinkResolver(worked());
        expect(r(null, '   ')).toEqual({ id: null, reason: 'missing', candidates: 0 });
    });
});
