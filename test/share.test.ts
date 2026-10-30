import { describe, expect, it, vi } from 'vitest';
import { share } from '../src/core/share.js';
import { StableProps } from '../src/renderer/stable-view.js';

/**
 * STRUCTURAL SHARING AND STABLE HANDLERS (genie#1340) — what lets a memoised view skip a push that did not change it.
 * test/push-render-budget.test.tsx counts the renders this saves; this file holds the two pieces' own rules.
 */
describe('share(prev, next)', () => {
    const snap = () => ({
        agents: [{ id: 'a1', name: 'atlas', state: 'working', fixes: ['x'] }, { id: 'a2', name: 'wren', state: 'idle', fixes: [] }],
        workspaces: [{ id: 'w1', path: '/w', agentsKnown: true }],
        signals: { mail: 0 },
    });

    it('an equal clone comes back as the previous object, whole', () => {
        const a = snap();
        expect(share(a, structuredClone(a))).toBe(a);
    });

    it('what changed is new; every part that did not is the previous object', () => {
        const a = snap();
        const b = structuredClone(a);
        b.agents[1]!.state = 'working';
        const out = share(a, b);
        expect(out).not.toBe(a);
        expect(out.agents).not.toBe(a.agents);
        expect(out.agents[1]).not.toBe(a.agents[1]);
        expect(out.agents[1]!.state).toBe('working');
        // Unchanged: the other agent, its nested list, the workspaces, the signals.
        expect(out.agents[0]).toBe(a.agents[0]);
        expect(out.agents[0]!.fixes).toBe(a.agents[0]!.fixes);
        expect(out.workspaces).toBe(a.workspaces);
        expect(out.workspaces[0]).toBe(a.workspaces[0]);
        expect(out.signals).toBe(a.signals);
        // And the result says exactly what `next` says.
        expect(out).toEqual(b);
    });

    it('a list of things with ids shares each by id, so a reorder keeps every element', () => {
        const a = snap();
        const b = structuredClone(a);
        b.agents.reverse();
        const out = share(a, b);
        expect(out.agents.map((x) => x.id)).toEqual(['a2', 'a1']);
        expect(out.agents[0]).toBe(a.agents[1]);
        expect(out.agents[1]).toBe(a.agents[0]);
    });

    it('a key added or removed is a change; a class instance or a function is equal only to itself', () => {
        const a = { x: 1 } as Record<string, unknown>;
        expect(share(a, { x: 1, y: undefined })).not.toBe(a);
        expect(share({ x: 1, y: 2 }, { x: 1 })).toEqual({ x: 1 });
        const m1 = new Map([[1, 1]]);
        expect(share({ m: m1 }, { m: new Map([[1, 1]]) }).m).not.toBe(m1);
        const f = (): void => {};
        expect(share({ f }, { f: () => {} }).f).not.toBe(f);
    });

    it('a React element is not walked (its owner is a cyclic fiber): equal only to itself', () => {
        const el1 = { $$typeof: Symbol.for('react.transitional.element'), props: { a: 1 } };
        const el2 = { $$typeof: Symbol.for('react.transitional.element'), props: { a: 1 } };
        expect(share({ child: el1 }, { child: el2 }).child).toBe(el2);
    });
});

describe('StableProps — what a memoised view is handed', () => {
    type P = { rows: readonly number[]; workspace: { id: string } | null; onGo?: (n: number) => number; ops?: { budget: number; onRestart: () => string } };

    it('a new handler and an equal-but-new object hand down the SAME props: the view would not draw', () => {
        const s = new StableProps<P>();
        const rows = [1, 2];
        const first = s.pass({ rows, workspace: { id: 'w1' }, onGo: (n) => n, ops: { budget: 1, onRestart: () => 'a' } });
        const again = s.pass({ rows, workspace: { id: 'w1' }, onGo: (n) => n + 1, ops: { budget: 1, onRestart: () => 'b' } });
        expect(again).toBe(first);
    });

    it('a changed value is handed down (positive control)', () => {
        const s = new StableProps<P>();
        const first = s.pass({ rows: [1], workspace: { id: 'w1' } });
        expect(s.pass({ rows: [1, 2], workspace: { id: 'w1' } })).not.toBe(first);
        expect(s.pass({ rows: [1, 2], workspace: { id: 'w2' } }).workspace).toEqual({ id: 'w2' });
    });

    it('a handler calls the LATEST committed one — top level and inside a plain object — never a stale closure', () => {
        const s = new StableProps<P>();
        const go1 = vi.fn((n: number) => n);
        const p1: P = { rows: [], workspace: null, onGo: go1, ops: { budget: 1, onRestart: () => 'first' } };
        const handed = s.pass(p1);
        // Before any commit, the first render's handlers are reached (a mount effect may call one).
        expect(handed.onGo!(3)).toBe(3);
        const go2 = vi.fn((n: number) => n * 10);
        const p2: P = { rows: [], workspace: null, onGo: go2, ops: { budget: 1, onRestart: () => 'second' } };
        s.pass(p2);
        s.commit(p2);
        expect(handed.onGo!(3)).toBe(30);
        expect(handed.ops!.onRestart()).toBe('second');
        expect(go1).toHaveBeenCalledTimes(1);
    });

    it('a handler that comes or goes is a change (the view draws the button, or stops drawing it)', () => {
        const s = new StableProps<P>();
        const without = s.pass({ rows: [], workspace: null });
        const withIt = s.pass({ rows: [], workspace: null, onGo: (n) => n });
        expect(withIt).not.toBe(without);
        expect(typeof withIt.onGo).toBe('function');
    });
});
