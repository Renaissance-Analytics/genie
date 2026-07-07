/**
 * Pure helpers for the Knowledge Graph window (renderer/pages/knowledge.tsx).
 * Kept dependency-free + side-effect-free so the window's `[[wikilink]]`
 * parsing and its graph layout are unit-testable without a DOM or a store.
 */

/** The minimal node shape both store nodes and graph nodes satisfy. */
export interface TitledNode {
    id: string;
    title: string;
}

/**
 * Extract `[[wikilink]]` TARGETS from a markdown body, in document order,
 * de-duplicated case-insensitively and trimmed. Empty `[[]]` refs are ignored.
 * The inner text is the link target — another memory's TITLE.
 */
export function parseWikilinks(body: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const re = /\[\[([^\]]+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
        const target = m[1].trim();
        if (!target) continue;
        const key = target.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(target);
    }
    return out;
}

/**
 * Resolve wikilink targets (memory titles) to node IDS against the known nodes,
 * matching case-insensitively by title. Unresolved targets are dropped — a
 * dangling `[[wikilink]]` forms no edge until its target memory exists. A node
 * never links to itself (`selfId`). Returns de-duplicated ids in first-seen
 * order.
 */
export function resolveLinkIds(
    targets: string[],
    nodes: TitledNode[],
    selfId?: string,
): string[] {
    const byTitle = new Map<string, string>();
    // Later duplicates keep the FIRST title→id mapping (stable).
    for (const n of nodes) {
        const key = n.title.trim().toLowerCase();
        if (!byTitle.has(key)) byTitle.set(key, n.id);
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const t of targets) {
        const id = byTitle.get(t.trim().toLowerCase());
        if (!id || id === selfId || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

export interface Point {
    x: number;
    y: number;
}

/**
 * Deterministic circular layout: place `ids` evenly around a circle inscribed
 * in a `width`×`height` box (inset by `pad`), starting at 12 o'clock and going
 * clockwise. Dependency-free — a clean, robust relationship view without a
 * physics/force simulation. A single node sits at the centre; an empty list
 * yields an empty map.
 */
export function circleLayout(
    ids: string[],
    width: number,
    height: number,
    pad = 44,
): Map<string, Point> {
    const pos = new Map<string, Point>();
    const cx = width / 2;
    const cy = height / 2;
    if (ids.length === 0) return pos;
    if (ids.length === 1) {
        pos.set(ids[0], { x: cx, y: cy });
        return pos;
    }
    const r = Math.max(0, Math.min(width, height) / 2 - pad);
    for (let i = 0; i < ids.length; i++) {
        const theta = -Math.PI / 2 + (i / ids.length) * Math.PI * 2;
        pos.set(ids[i], {
            x: cx + r * Math.cos(theta),
            y: cy + r * Math.sin(theta),
        });
    }
    return pos;
}
