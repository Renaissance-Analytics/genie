import { describe, expect, it } from 'vitest';
import {
    buildPanelList,
    orderForMode,
    resolveMode,
    type ResolvedMode,
} from '../terminal-grid-layout';
import type { TerminalSpec } from '../genie';

/**
 * Unit tests for the unified panel-list builder that fixes the
 * terminal-reset-on-workspace-switch regression.
 *
 * The bug: active panels and off-workspace (background) panels were rendered as
 * TWO separate array expressions in the same parent. React only matches keys
 * within one array slot, so a panel crossing from active→background on a
 * workspace switch got a different effective key and was unmounted/remounted —
 * resetting xterm + the pty. The fix builds ONE stably-ordered list of every
 * selected spec (active + background) which the grid renders through a SINGLE
 * keyed `.map()`. These tests pin the contract that makes that mount-stable:
 * every selected spec appears exactly once, active panels get grid placement,
 * off-workspace ones get display:none, and the order/keys stay stable when the
 * active workspace changes.
 */

const spec = (id: string, workspace_id: string | null = 'w1'): TerminalSpec => ({
    id,
    workspace_id,
    label: id,
    cwd: '/tmp',
    shell: null,
    args: [],
    env: {},
    type: 'terminal',
    meta: {} as TerminalSpec['meta'],
    sort_order: 0,
    created_at: '2024-01-01',
    last_opened_at: null,
    snapshot_at: null,
    snapshot_bytes: null,
    live_cwd: null,
    enabled: true,
});

const isHidden = (style: { display?: string }) => style.display === 'none';

describe('buildPanelList', () => {
    it('emits a single list with every selected spec exactly once (active + background)', () => {
        const active = [spec('a1'), spec('a2')];
        const background = [spec('b1', 'w2'), spec('b2', 'w2')];
        const mode: ResolvedMode = 'g2x1';

        const list = buildPanelList({
            ordered: active,
            background,
            mode,
            maximizedId: null,
        });

        const ids = list.map((p) => p.spec.id).sort();
        expect(ids).toEqual(['a1', 'a2', 'b1', 'b2']);
        // No duplicates.
        expect(new Set(ids).size).toBe(4);
    });

    it('gives active panels grid placement and off-workspace panels display:none', () => {
        const list = buildPanelList({
            ordered: [spec('a1'), spec('a2')],
            background: [spec('b1', 'w2')],
            mode: 'g2x1',
            maximizedId: null,
        });

        const byId = new Map(list.map((p) => [p.spec.id, p]));
        // Active panels are placed (NOT hidden) and visible.
        expect(isHidden(byId.get('a1')!.style)).toBe(false);
        expect(isHidden(byId.get('a2')!.style)).toBe(false);
        expect(byId.get('a1')!.visible).toBe(true);
        expect(byId.get('a1')!.style.gridColumn).toBe('1');
        expect(byId.get('a2')!.style.gridColumn).toBe('2');
        // Background panel is hidden + not visible.
        expect(isHidden(byId.get('b1')!.style)).toBe(true);
        expect(byId.get('b1')!.visible).toBe(false);
    });

    it('hides every active panel except the maximized one', () => {
        const list = buildPanelList({
            ordered: [spec('a1'), spec('a2'), spec('a3')],
            background: [spec('b1', 'w2')],
            mode: '2x2',
            maximizedId: 'a2',
        });
        const byId = new Map(list.map((p) => [p.spec.id, p]));
        // The maximized panel spans the grid.
        expect(byId.get('a2')!.style.gridArea).toBe('1 / 1 / -1 / -1');
        expect(byId.get('a2')!.isMaximized).toBe(true);
        // Other active panels are hidden (not visible).
        expect(isHidden(byId.get('a1')!.style)).toBe(true);
        expect(byId.get('a1')!.visible).toBe(false);
        expect(isHidden(byId.get('a3')!.style)).toBe(true);
        // Background still hidden.
        expect(isHidden(byId.get('b1')!.style)).toBe(true);
    });

    it('keeps list/key order STABLE when the active workspace changes (no remount)', () => {
        // Workspace A: a1,a2.  Workspace B: b1,b2.  All four selected.
        const a1 = spec('a1', 'wA');
        const a2 = spec('a2', 'wA');
        const b1 = spec('b1', 'wB');
        const b2 = spec('b2', 'wB');

        // Viewing A: A panels active, B panels background.
        const viewingA = buildPanelList({
            ordered: orderForMode('g2x1', [a1, a2], null),
            background: [b1, b2],
            mode: 'g2x1',
            maximizedId: null,
        });
        // Switch to B: B panels active, A panels background.
        const viewingB = buildPanelList({
            ordered: orderForMode('g2x1', [b1, b2], null),
            background: [a1, a2],
            mode: 'g2x1',
            maximizedId: null,
        });

        // Every one of the four specs is present in BOTH renders (so React keeps
        // all four instances mounted — only their styles change).
        const idsA = new Set(viewingA.map((p) => p.spec.id));
        const idsB = new Set(viewingB.map((p) => p.spec.id));
        expect(idsA).toEqual(new Set(['a1', 'a2', 'b1', 'b2']));
        expect(idsB).toEqual(new Set(['a1', 'a2', 'b1', 'b2']));

        // Background entries are emitted in a STABLE (id-sorted) order regardless
        // of input order, so the tail of the merged list never reshuffles.
        const viewingBShuffled = buildPanelList({
            ordered: orderForMode('g2x1', [b1, b2], null),
            background: [a2, a1], // reversed input
            mode: 'g2x1',
            maximizedId: null,
        });
        expect(viewingBShuffled.map((p) => p.spec.id)).toEqual(
            viewingB.map((p) => p.spec.id),
        );

        // A→B flips each spec's role: A panels go hidden, B panels become placed.
        const aById = new Map(viewingA.map((p) => [p.spec.id, p]));
        const bById = new Map(viewingB.map((p) => [p.spec.id, p]));
        expect(isHidden(aById.get('a1')!.style)).toBe(false);
        expect(isHidden(aById.get('b1')!.style)).toBe(true);
        expect(isHidden(bById.get('a1')!.style)).toBe(true);
        expect(isHidden(bById.get('b1')!.style)).toBe(false);
    });

    it('handles switching to an EMPTY workspace — background panels stay in the list, all hidden', () => {
        const a1 = spec('a1', 'wA');
        const a2 = spec('a2', 'wA');
        // Active workspace is empty (ordered = []); A panels are now background.
        const list = buildPanelList({
            ordered: [],
            background: [a1, a2],
            mode: resolveMode('auto', 0),
            maximizedId: null,
        });
        expect(list.map((p) => p.spec.id).sort()).toEqual(['a1', 'a2']);
        // Every panel hidden, but still present (mounted) — no remount.
        expect(list.every((p) => isHidden(p.style))).toBe(true);
        expect(list.every((p) => !p.visible)).toBe(true);
    });

    it('marks the focus-stack main panel and orders it first', () => {
        const specs = [spec('a1'), spec('a2'), spec('a3')];
        const ordered = orderForMode('focus-stack', specs, 'a2');
        expect(ordered[0].id).toBe('a2'); // focused becomes main

        const list = buildPanelList({
            ordered,
            background: [],
            mode: 'focus-stack',
            maximizedId: null,
        });
        const main = list[0];
        expect(main.spec.id).toBe('a2');
        expect(main.isMainInStack).toBe(true);
        // Main spans column 1; stack panels live in column 2.
        expect(main.style.gridColumn).toBe('1');
        expect(list[1].style.gridColumn).toBe('2');
        expect(list[1].isMainInStack).toBe(false);
    });
});
