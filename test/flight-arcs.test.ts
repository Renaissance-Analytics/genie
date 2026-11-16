import { describe, expect, it } from 'vitest';
import { commsOf } from '../src/core/comms.js';
import { ARC_CAP, ARC_WINDOW_SECONDS, arcGeometry, arcsFor, bezierAt, labelRect, rectsOverlap, type ArcInput, type Rect } from '../src/core/flight-arcs.js';

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
        expect(bezierAt(far, 0.5).y).toBeLessThan(bezierAt(near, 0.5).y - 20);
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
