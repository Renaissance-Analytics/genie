import { describe, it, expect } from 'vitest';
import {
    parseWikilinks,
    resolveLinkIds,
    circleLayout,
} from '../knowledge-graph';

describe('parseWikilinks', () => {
    it('extracts targets in document order', () => {
        expect(parseWikilinks('see [[Alpha]] and [[Beta]]')).toEqual([
            'Alpha',
            'Beta',
        ]);
    });

    it('trims + de-duplicates case-insensitively', () => {
        expect(parseWikilinks('[[ Alpha ]] again [[alpha]] and [[ALPHA]]')).toEqual([
            'Alpha',
        ]);
    });

    it('ignores empty refs', () => {
        expect(parseWikilinks('a [[]] b [[   ]] c [[Real]]')).toEqual(['Real']);
    });

    it('returns [] when there are no wikilinks', () => {
        expect(parseWikilinks('plain body, no links')).toEqual([]);
    });
});

describe('resolveLinkIds', () => {
    const nodes = [
        { id: 'n1', title: 'Alpha' },
        { id: 'n2', title: 'Beta' },
        { id: 'n3', title: 'Gamma' },
    ];

    it('resolves titles to ids case-insensitively', () => {
        expect(resolveLinkIds(['alpha', 'GAMMA'], nodes)).toEqual(['n1', 'n3']);
    });

    it('drops unresolved (dangling) targets', () => {
        expect(resolveLinkIds(['Alpha', 'Nope'], nodes)).toEqual(['n1']);
    });

    it('never links a node to itself', () => {
        expect(resolveLinkIds(['Alpha', 'Beta'], nodes, 'n1')).toEqual(['n2']);
    });

    it('de-duplicates resolved ids', () => {
        expect(resolveLinkIds(['Alpha', 'alpha'], nodes)).toEqual(['n1']);
    });
});

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
