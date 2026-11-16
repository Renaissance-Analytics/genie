import type { CommsLink } from './comms.js';
import { ageLabel } from './reveal.js';

/**
 * THE COMMS FLIGHT PATHS (Tynn #750, option D), decided without a DOM. Hovering an agent's Comms cell draws each of its
 * conversations of the last 24 h as an arch from the pointer to the partner's row. Nothing is drawn at rest. This file is
 * the geometry and the flags; the component only measures the rows once per hover and renders what comes back.
 */
export interface Point {
    readonly x: number;
    readonly y: number;
}

/** Only conversations this recent are drawn. */
export const ARC_WINDOW_SECONDS = 86_400;
/** The most partners drawn: the newest twelve. */
export const ARC_CAP = 12;

/** A cubic bezier: `d` is its SVG path, `p0..p3` its points. */
export interface ArcGeometry {
    readonly d: string;
    readonly lift: number;
    readonly p0: Point;
    readonly c1: Point;
    readonly c2: Point;
    readonly p3: Point;
}

/** An arch rises 34px plus 11px for every row between the two ends. */
export function arcGeometry(start: Point, end: Point, rows: number): ArcGeometry {
    const lift = 34 + rows * 11;
    const dx = end.x - start.x;
    const c1 = { x: start.x + dx * 0.22, y: start.y - lift };
    const c2 = { x: start.x + dx * 0.78, y: end.y - lift };
    return { d: `M${start.x},${start.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`, lift, p0: start, c1, c2, p3: end };
}

export function bezierAt(g: Pick<ArcGeometry, 'p0' | 'c1' | 'c2' | 'p3'>, t: number): Point {
    if (t <= 0) return g.p0;
    if (t >= 1) return g.p3;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return { x: a * g.p0.x + b * g.c1.x + c * g.c2.x + d * g.p3.x, y: a * g.p0.y + b * g.c1.y + c * g.c2.y + d * g.p3.y };
}

export interface Arc {
    readonly peer: string;
    readonly d: string;
    readonly start: Point;
    readonly end: Point;
    /** Rows between the two ends. */
    readonly dist: number;
    readonly lift: number;
    /** `out`: this agent sent last, dots run to the partner. `in`: the partner did, dots run to the pointer. */
    readonly direction: 'out' | 'in';
    /** Amber (`waiting`: the receiver has not answered) or the ordinary violet. */
    readonly tone: 'flow' | 'waiting';
    readonly unread: boolean;
    /** Where the unread pulse sits: the receiving end. `null` = nothing unread. */
    readonly pulseAt: Point | null;
    readonly ageSeconds: number;
    readonly width: number;
    readonly opacity: number;
    readonly label: { readonly text: string; readonly x: number; readonly y: number; readonly t: number };
    /** The static arrow for reduced motion: near the receiving end, pointing along the flight. */
    readonly arrow: { readonly x: number; readonly y: number; readonly angle: number };
}

export interface ArcInput {
    readonly focus: string;
    readonly links: readonly CommsLink[];
    /** Row ids in board order: the distance between two rows. */
    readonly order: readonly string[];
    /** Each row's landing point (at its name), in the overlay's coordinates. */
    readonly targets: Readonly<Record<string, Point>>;
    readonly names: Readonly<Record<string, string>>;
    readonly pointer: Point;
}

/** Labels sit at staggered points along the paths so neighbours do not stack. */
const LABEL_STEPS = [0.3, 0.44, 0.58, 0.72, 0.37];

export function arcsFor(input: ArcInput): Arc[] {
    const at = input.order.indexOf(input.focus);
    const chosen = input.links
        .filter((l) => l.peer !== input.focus && l.ageSeconds <= ARC_WINDOW_SECONDS && input.targets[l.peer] !== undefined && input.order.includes(l.peer))
        .sort((a, b) => a.ageSeconds - b.ageSeconds)
        .slice(0, ARC_CAP);
    // Shortest first, so the longest are drawn last and sit on top.
    const ordered = chosen
        .map((l) => ({ l, dist: Math.abs(input.order.indexOf(l.peer) - at) }))
        .sort((a, b) => a.dist - b.dist);
    return ordered.map(({ l, dist }, n) => {
        const end = input.targets[l.peer]!;
        const g = arcGeometry(input.pointer, end, dist);
        const out = (l.lastFrom ?? 'self') === 'self';
        const unread = l.unread === true;
        const frac = Math.min(1, l.ageSeconds / ARC_WINDOW_SECONDS);
        const t = LABEL_STEPS[n % LABEL_STEPS.length]!;
        const mid = bezierAt(g, t);
        const me = input.names[input.focus] ?? input.focus;
        const them = input.names[l.peer] ?? l.peer;
        // The arrow sits near the RECEIVING end: the partner's when out, the pointer's when in.
        const [ta, tb] = out ? [0.86, 0.92] : [0.14, 0.08];
        const pa = bezierAt(g, ta);
        const pb = bezierAt(g, tb);
        return {
            peer: l.peer,
            d: g.d,
            start: input.pointer,
            end,
            dist,
            lift: g.lift,
            direction: out ? 'out' : 'in',
            tone: l.waiting === true && !unread ? 'waiting' : 'flow',
            unread,
            pulseAt: unread ? (out ? end : input.pointer) : null,
            ageSeconds: l.ageSeconds,
            width: Math.max(1.2, 2.8 - frac * 1.6),
            opacity: Math.max(0.35, 0.95 - frac * 0.6),
            label: { text: `${out ? me : them} › ${out ? them : me} ${ageLabel(l.ageSeconds)}`, x: mid.x, y: mid.y - 8, t },
            arrow: { x: pb.x, y: pb.y, angle: (Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI },
        };
    });
}
