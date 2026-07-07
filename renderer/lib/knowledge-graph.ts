/**
 * Pure helpers for the Knowledge Graph window (renderer/pages/knowledge.tsx).
 * Kept dependency-free + side-effect-free so the graph layout is unit-testable
 * without a DOM. (Edge derivation from `[[wikilinks]]` lives main-side — the
 * store resolves them by title/slug at read time — so the renderer only lays
 * out the nodes + edges it's handed.)
 */

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
