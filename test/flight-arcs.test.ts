import { describe, expect, it } from 'vitest';
import { commsOf } from '../src/core/comms.js';
import { ARC_CAP, ARC_WINDOW_SECONDS, arcGeometry, arcsFor, bezierAt, labelRect, rectsOverlap, type Arc, type ArcInput, type Point, type Rect } from '../src/core/flight-arcs.js';
import { THEME_SURFACES, WORKSPACE_PALETTE, contrastRatio } from '../src/core/workspace-color.js';

/**
 * THE COMMS FLIGHT PATHS (Tynn #750, option D) — the geometry and the flags, decided without a DOM. An arch starts at the
 * pointer and lands at a partner row's name; the further apart the rows, the higher it rises; the dots run the way the
 * last message went; amber = the receiver has not answered, a pulse = unread; older threads are thinner and fainter.
 */
const order = ['kai', 'a', 'b', 'c', 'wren', 'd', 'e', 'f', 'g', 'moth'];
const targets = Object.fromEntries(order.map((id, i) => [id, { x: 300, y: 40 + i * 32 }]));
const names = Object.fromEntries(order.map((id) => [id, id]));
const pointer = { x: 700, y: 40 };
const input = (links: ArcInput['links']): ArcInput => ({ focus: 'kai', links, order, targets, names, pointer });
const link = (peer: string, over: Partial<ArcInput['links'][number]> = {}) => ({ peer, count: 2, ageSeconds: 120, lastFrom: 'self' as const, unread: false, waiting: false, ...over });

describe('arcGeometry', () => {
    it('starts at the pointer, ends at the target, and rises higher the further apart the rows are', () => {
        const near = arcGeometry(pointer, { x: 300, y: 72 }, 1);
        const far = arcGeometry(pointer, { x: 300, y: 328 }, 9);
        expect(near.d.startsWith('M700,40 C')).toBe(true);
        expect(near.d.endsWith(' 300,72')).toBe(true);
        expect(far.lift).toBeGreaterThan(near.lift);
        // Height is the rise ABOVE the straight line between the two ends (the far end is also lower on the screen, so absolute y says nothing).
        const rise = (g: ReturnType<typeof arcGeometry>) => (g.p0.y + g.p3.y) / 2 - bezierAt(g, 0.5).y;
        expect(rise(near)).toBeGreaterThan(0);
        expect(rise(far)).toBeGreaterThan(rise(near) + 20);
        expect(bezierAt(near, 0)).toEqual(pointer);
        expect(bezierAt(near, 1)).toEqual({ x: 300, y: 72 });
    });
});

describe('arcsFor', () => {
    it('one arch per partner on the board, from the pointer to the partner name, with a non-empty path', () => {
        const arcs = arcsFor(input([link('a'), link('moth')]));
        expect(arcs).toHaveLength(2);
        for (const arc of arcs) {
            expect(arc.d.length).toBeGreaterThan(10);
            expect(arc.start).toEqual(pointer);
            expect(arc.end).toEqual(targets[arc.peer as keyof typeof targets]);
            expect(arc.width).toBeGreaterThan(0);
            expect(arc.opacity).toBeGreaterThan(0);
        }
    });

    it('longest arches are drawn last, so they sit on top', () => {
        const arcs = arcsFor(input([link('moth'), link('a'), link('wren')]));
        expect(arcs.map((a) => a.peer)).toEqual(['a', 'wren', 'moth']);
    });

    it('direction follows the last sender: out when this agent sent last, in when the partner did', () => {
        const arcs = arcsFor(input([link('a', { lastFrom: 'self' }), link('b', { lastFrom: 'peer' })]));
        expect(arcs.find((a) => a.peer === 'a')!.direction).toBe('out');
        expect(arcs.find((a) => a.peer === 'b')!.direction).toBe('in');
    });

    it('waiting is amber; unread pulses at the RECEIVING end (the partner when out, the pointer when in)', () => {
        const arcs = arcsFor(input([link('a', { waiting: true }), link('b', { lastFrom: 'self', unread: true }), link('c', { lastFrom: 'peer', unread: true }), link('wren')]));
        const by = (p: string) => arcs.find((a) => a.peer === p)!;
        expect(by('a').tone).toBe('waiting');
        expect(by('a').pulseAt).toBeNull();
        expect(by('b').pulseAt).toEqual(targets.b);
        expect(by('c').pulseAt).toEqual(pointer);
        expect(by('wren').tone).toBe('flow');
        expect(by('wren').pulseAt).toBeNull();
    });

    it('older threads are thinner and fainter', () => {
        const fresh = arcsFor(input([link('a', { ageSeconds: 10 })]))[0]!;
        const old = arcsFor(input([link('a', { ageSeconds: 80_000 })]))[0]!;
        expect(old.width).toBeLessThan(fresh.width);
        expect(old.opacity).toBeLessThan(fresh.opacity);
        expect(old.opacity).toBeGreaterThan(0.2);
    });

    it('only the last 24 h, and at most the 12 most recent partners', () => {
        expect(arcsFor(input([link('a', { ageSeconds: ARC_WINDOW_SECONDS + 1 }), link('b', { ageSeconds: ARC_WINDOW_SECONDS })])).map((a) => a.peer)).toEqual(['b']);
        const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
        const wide: ArcInput = {
            focus: 'kai',
            links: ids.map((p, i) => link(p, { ageSeconds: 10 + i })),
            order: ['kai', ...ids],
            targets: Object.fromEntries(['kai', ...ids].map((id, i) => [id, { x: 300, y: 40 + i * 32 }])),
            names: {},
            pointer,
        };
        const arcs = arcsFor(wide);
        expect(arcs).toHaveLength(ARC_CAP);
        expect(arcs.map((a) => a.peer)).not.toContain('p19');
        expect(arcs.map((a) => a.peer)).toContain('p0');
    });

    it('a partner with no row on the board (filtered, hibernated) draws nothing; the focus itself never does', () => {
        expect(arcsFor(input([link('ghost'), link('kai')]))).toEqual([]);
    });

    it('labels read sender › receiver with the age, and sit between the pointer and the partner', () => {
        const out = arcsFor(input([link('a', { lastFrom: 'self', ageSeconds: 120 })]))[0]!;
        const inn = arcsFor(input([link('a', { lastFrom: 'peer', ageSeconds: 7200 })]))[0]!;
        expect(out.label!.text).toBe('kai › a 2m');
        expect(inn.label!.text).toBe('a › kai 2h');
        expect(out.label!.x + out.label!.w).toBeGreaterThan(300);
        expect(out.label!.x).toBeLessThan(700);
    });

    it('no two labels overlap, however many arches share the pointer', () => {
        const arcs = arcsFor(input(['a', 'b', 'c', 'wren', 'd', 'e', 'f', 'g', 'moth'].map((p, i) => link(p, { ageSeconds: 30 + i }))));
        const boxes = arcs.filter((a) => a.label).map((a) => labelRect(a.label!));
        expect(boxes.length).toBeGreaterThan(1);
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(rectsOverlap(boxes[i]!, boxes[j]!)).toBe(false);
    });

    it('a label never covers the row text, and moves to free space instead (positive control: with no text it takes its first spot)', () => {
        const free = arcsFor(input([link('a')]))[0]!.label!;
        // Text laid right over that first spot, and the strip beside it.
        const text: Rect[] = [{ x: free.x - 4, y: free.y - 14, w: free.w + 8, h: 22 }];
        const moved = arcsFor({ ...input([link('a')]), obstacles: text })[0]!.label!;
        expect(moved).not.toBeNull();
        expect(rectsOverlap(labelRect(moved), text[0]!)).toBe(false);
        expect(`${moved.x},${moved.y}`).not.toBe(`${free.x},${free.y}`);
    });

    it('a label never covers the pointer', () => {
        for (const label of arcsFor(input([link('a'), link('b'), link('c')])).map((a) => a.label!)) {
            expect(rectsOverlap(labelRect(label), { x: pointer.x - 14, y: pointer.y - 14, w: 28, h: 28 })).toBe(false);
        }
    });

    it('with no room the label is dropped, and the arch is still drawn', () => {
        const everywhere: Rect[] = [{ x: 0, y: -400, w: 2000, h: 1200 }];
        const arcs = arcsFor({ ...input([link('a'), link('b')]), obstacles: everywhere });
        expect(arcs).toHaveLength(2);
        for (const arc of arcs) {
            expect(arc.label).toBeNull();
            expect(arc.d.length).toBeGreaterThan(10);
        }
    });

    it('zero-sized text boxes (a layout that has not happened) are ignored, not treated as walls', () => {
        expect(arcsFor({ ...input([link('a')]), obstacles: [{ x: 300, y: 40, w: 0, h: 0 }] })[0]!.label).not.toBeNull();
    });
});

describe('the comms links carry what the arches need', () => {
    const t0 = 1_760_000_000_000;
    const at = (s: number) => new Date(t0 + s * 1000).toISOString();
    it('lastFrom, unread (the last message not yet read), waiting (read but unanswered for a minute)', () => {
        const mail = [
            { from: 'agent_a', to: 'agent_b', sentAt: at(0), readAt: at(1) },
            { from: 'agent_c', to: 'agent_a', sentAt: at(30), readAt: null },
            { from: 'agent_a', to: 'agent_d', sentAt: at(40), readAt: at(41) },
            { from: 'agent_d', to: 'agent_a', sentAt: at(50), readAt: at(51) },
        ];
        const links = commsOf(mail, 'agent_a', t0, t0 + 200_000).links;
        const by = (p: string) => links.find((l) => l.peer === p)!;
        expect(by('agent_b')).toMatchObject({ lastFrom: 'self', unread: false, waiting: true });
        expect(by('agent_c')).toMatchObject({ lastFrom: 'peer', unread: true, waiting: false });
        expect(by('agent_d')).toMatchObject({ lastFrom: 'peer', unread: false, waiting: true });
        expect(commsOf(mail, 'agent_a', t0, t0 + 55_000).links.find((l) => l.peer === 'agent_d')).toMatchObject({ waiting: false });
    });
});

/**
 * THE SHADOW (owner, 2026-11-17: "the shadows are busted and look dumb. they don't come together like they should at the
 * contact points"). A flight path's shadow is its projection on the ground: it starts and ends EXACTLY where the arc touches
 * down, is furthest from the arc at the apex, and is thin and faint, never heavier than the arc. Before this it was the arc
 * itself, blurred, thicker, and moved 16px down: it missed both contact points and read as a second stroke.
 */
type Curve = { p0: Point; c1: Point; c2: Point; p3: Point };
type Shadow = Curve & { d: string; width: number; opacity: number };
const shadowOf = (arc: Arc): Shadow => (arc as unknown as { shadow: Shadow }).shadow;
const arcCurve = (arc: Arc): Curve => arcGeometry(arc.start, arc.end, arc.dist);
const gap = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const SAMPLES = Array.from({ length: 41 }, (_, i) => i / 40);

describe('the shadow of a flight path', () => {
    const arcs = arcsFor(input([link('a'), link('wren'), link('moth')]));

    it("starts and ends exactly at the arc's two contact points (the pointer and the partner row), within 0.5px", () => {
        expect(arcs).toHaveLength(3);
        for (const arc of arcs) {
            const s = shadowOf(arc);
            expect(s).toBeDefined();
            expect(gap(bezierAt(s, 0), arc.start)).toBeLessThan(0.5);
            expect(gap(bezierAt(s, 1), arc.end)).toBeLessThan(0.5);
            // The drawn path itself: it moves to the pointer and its last point is the partner's end.
            expect(s.d.startsWith(`M${arc.start.x},${arc.start.y} C`)).toBe(true);
            const last = s.d.trim().split(/[ ,]+/).slice(-2).map(Number);
            expect(gap({ x: last[0]!, y: last[1]! }, arc.end)).toBeLessThan(0.5);
        }
    });

    it('is 0 apart at both ends and furthest apart at the apex, opening steadily on the way up and closing on the way down', () => {
        for (const arc of arcs) {
            const g = arcCurve(arc);
            const s = shadowOf(arc);
            const sep = SAMPLES.map((t) => gap(bezierAt(g, t), bezierAt(s, t)));
            expect(sep[0]!).toBeLessThan(0.5);
            expect(sep[sep.length - 1]!).toBeLessThan(0.5);
            // The apex: where the arc stands highest above the straight line between its ends.
            const chordY = (x: number) => arc.start.y + ((x - arc.start.x) / (arc.end.x - arc.start.x)) * (arc.end.y - arc.start.y);
            const height = SAMPLES.map((t) => { const p = bezierAt(g, t); return chordY(p.x) - p.y; });
            const apex = height.indexOf(Math.max(...height));
            const widest = sep.indexOf(Math.max(...sep));
            expect(Math.abs(widest - apex)).toBeLessThanOrEqual(2);
            expect(Math.max(...sep)).toBeGreaterThan(8);
            for (let i = 1; i <= widest; i++) expect(sep[i]!).toBeGreaterThanOrEqual(sep[i - 1]! - 1e-6);
            for (let i = widest + 1; i < sep.length; i++) expect(sep[i]!).toBeLessThanOrEqual(sep[i - 1]! + 1e-6);
        }
    });

    it('lies on the ground side: below the arc everywhere between the ends', () => {
        for (const arc of arcs) {
            const g = arcCurve(arc);
            const s = shadowOf(arc);
            for (const t of SAMPLES.slice(1, -1)) expect(bezierAt(s, t).y).toBeGreaterThan(bezierAt(g, t).y);
        }
    });

    it("is never heavier than the arc: its width and opacity are at most the arc's, and it fades the higher the arc flies", () => {
        for (const arc of arcs) {
            const s = shadowOf(arc);
            expect(s.width).toBeGreaterThan(0);
            expect(s.width).toBeLessThanOrEqual(arc.width);
            expect(s.opacity).toBeGreaterThan(0);
            expect(s.opacity).toBeLessThanOrEqual(arc.opacity);
            expect(s.opacity).toBeLessThanOrEqual(0.3);
        }
        const low = shadowOf(arcs.find((a) => a.peer === 'a')!);
        const high = shadowOf(arcs.find((a) => a.peer === 'moth')!);
        expect(high.opacity).toBeLessThan(low.opacity);
        // An old, thin, faint arc still casts a lighter shadow than itself.
        const old = arcsFor(input([link('moth', { ageSeconds: 86_000 })]))[0]!;
        expect(shadowOf(old).width).toBeLessThanOrEqual(old.width);
        expect(shadowOf(old).opacity).toBeLessThanOrEqual(old.opacity);
    });
});

/**
 * THE SENDER'S COLOUR (owner, 2026-11-17: "the coms lines should be colored based on the sending workspace"). An arc, its
 * dots and its label take the workspace colour of whoever sent the last message, the dot in the Workspace column. A colour
 * too faint for a theme is moved in lightness only (never hue) until it clears the floor: 3:1 for the stroke and dots
 * (WCAG 1.4.11), 4.5:1 for the label text, against every surface of that theme.
 */
type Paint = { stroke: string; text: string };
const colorOf = (arc: Arc) => (arc as unknown as { color: string | null }).color;
const paintOf = (arc: Arc) => (arc as unknown as { paint: Record<'light' | 'dark', Paint> | null }).paint;
const ROSE = '#e11d48';
const EMERALD = '#059669';
const colored = (links: ArcInput['links'], colors: Record<string, string>): ArcInput => ({ ...input(links), colors }) as ArcInput;
function hueOf(hex: string): number {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return 0;
    const d = max - min;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
}

describe('an arc is coloured by the sending workspace', () => {
    it("out (this agent sent last): the focus agent's workspace colour; in (the partner did): the partner's", () => {
        const arcs = arcsFor(colored([link('a', { lastFrom: 'self' }), link('b', { lastFrom: 'peer' })], { kai: ROSE, a: EMERALD, b: EMERALD }));
        expect(colorOf(arcs.find((a) => a.peer === 'a')!)).toBe(ROSE);
        expect(colorOf(arcs.find((a) => a.peer === 'b')!)).toBe(EMERALD);
        // Rose-600 already clears the stroke floor on both themes: drawn exactly as the Workspace column's dot.
        expect(paintOf(arcs.find((a) => a.peer === 'a')!)!.dark.stroke).toBe(ROSE);
        expect(paintOf(arcs.find((a) => a.peer === 'a')!)!.light.stroke).toBe(ROSE);
    });

    it('two workspaces give two colours', () => {
        const arcs = arcsFor(colored([link('a', { lastFrom: 'peer' }), link('b', { lastFrom: 'peer' })], { kai: ROSE, a: EMERALD, b: ROSE }));
        expect(new Set(arcs.map((a) => paintOf(a)!.dark.stroke)).size).toBe(2);
        expect(new Set(arcs.map((a) => paintOf(a)!.light.stroke)).size).toBe(2);
    });

    it('a sender with no workspace colour keeps the default paint (no colour, no paint)', () => {
        const arc = arcsFor(colored([link('a', { lastFrom: 'peer' })], { kai: ROSE }))[0]!;
        expect(colorOf(arc)).toBeNull();
        expect(paintOf(arc)).toBeNull();
    });

    it('the contrast floor holds on both themes for every palette colour and for faint custom ones, with the hue kept', () => {
        const faint = ['#1e293b', '#312e81', '#fef08a', '#e0f2fe', '#14532d', '#000000', '#ffffff'];
        for (const hex of [...WORKSPACE_PALETTE, ...faint]) {
            const paint = paintOf(arcsFor(colored([link('a', { lastFrom: 'self' })], { kai: hex }))[0]!)!;
            for (const theme of ['light', 'dark'] as const) {
                for (const bg of THEME_SURFACES[theme]) {
                    expect(contrastRatio(paint[theme].stroke, bg), `${hex} stroke on ${theme} ${bg}`).toBeGreaterThanOrEqual(3);
                    expect(contrastRatio(paint[theme].text, bg), `${hex} label on ${theme} ${bg}`).toBeGreaterThanOrEqual(4.5);
                }
                // Lightness moves, hue does not (a grey has no hue to keep).
                if (hueOf(hex) !== 0) {
                    for (const c of [paint[theme].stroke, paint[theme].text]) {
                        const off = Math.abs(hueOf(c) - hueOf(hex));
                        expect(Math.min(off, 360 - off), `${hex} -> ${c} hue on ${theme}`).toBeLessThan(4);
                    }
                }
            }
        }
    });
});
