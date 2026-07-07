import { describe, it, expect } from 'vitest';
import { circleLayout } from '../knowledge-graph';

describe('circleLayout', () => {
    it('returns an empty map for no ids', () => {
        expect(circleLayout([], 600, 600).size).toBe(0);
    });

    it('centres a single node', () => {
        const pos = circleLayout(['only'], 600, 400);
        expect(pos.get('only')).toEqual({ x: 300, y: 200 });
    });

    it('places every id once, inside the box', () => {
        const ids = ['a', 'b', 'c', 'd', 'e'];
        const pos = circleLayout(ids, 600, 600, 40);
        expect(pos.size).toBe(ids.length);
        for (const id of ids) {
            const p = pos.get(id)!;
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThanOrEqual(600);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeLessThanOrEqual(600);
        }
    });

    it('puts the first node at 12 oclock (top-centre)', () => {
        const pos = circleLayout(['a', 'b', 'c', 'd'], 600, 600, 40);
        const a = pos.get('a')!;
        expect(a.x).toBeCloseTo(300, 5);
        expect(a.y).toBeCloseTo(40, 5); // cy - r = 300 - (300 - 40)
    });
});
