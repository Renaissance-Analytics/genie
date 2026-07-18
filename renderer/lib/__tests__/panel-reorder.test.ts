import { describe, expect, it, vi } from 'vitest';
import { applyPanelOrder, movePanel } from '../panel-reorder';
import type { TerminalSpec } from '../genie';

/**
 * Unit tests for the grid's PANEL drag-reorder.
 *
 * Two things have to hold for the feature to survive a reload:
 *   1. the ordering maths is correct and never drops/duplicates a panel, and
 *   2. the reorder is PERSISTED — the renderer hands the same ordered id list
 *      to `terminalSpec.reorder()`, which writes each index to
 *      `terminal_specs.sort_order` (what `list()` sorts by).
 *
 * The flat `specs` array the renderer holds interleaves EVERY workspace's
 * specs, so `applyPanelOrder` must rearrange only the ids it was given and
 * leave every other workspace's spec exactly where it was.
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

const ids = (specs: TerminalSpec[]) => specs.map((s) => s.id);

describe('movePanel', () => {
    it('moves a panel forward into the drop target slot', () => {
        expect(movePanel(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    });

    it('moves a panel backward into the drop target slot', () => {
        expect(movePanel(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    });

    it('swaps neighbours', () => {
        expect(movePanel(['a', 'b'], 'b', 'a')).toEqual(['b', 'a']);
    });

    it('returns the SAME array when nothing moves, so callers can skip the update', () => {
        const list = ['a', 'b', 'c'];
        expect(movePanel(list, 'a', 'a')).toBe(list);
        expect(movePanel(list, 'zz', 'b')).toBe(list);
        expect(movePanel(list, 'a', 'zz')).toBe(list);
    });

    it('never drops or duplicates a panel', () => {
        const out = movePanel(['a', 'b', 'c', 'd', 'e'], 'e', 'a');
        expect([...out].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
        expect(out).toHaveLength(5);
    });
});

describe('applyPanelOrder', () => {
    it('reorders the named specs in the flat list', () => {
        const specs = [spec('a'), spec('b'), spec('c')];
        expect(ids(applyPanelOrder(specs, ['c', 'a', 'b']))).toEqual(['c', 'a', 'b']);
    });

    it('leaves OTHER workspaces’ specs in their exact slots', () => {
        // w1 panels are interleaved with w2 panels in the flat array. Reordering
        // w1 must not disturb where the w2 entries sit.
        const specs = [
            spec('a1', 'w1'),
            spec('x1', 'w2'),
            spec('a2', 'w1'),
            spec('x2', 'w2'),
            spec('a3', 'w1'),
        ];
        const out = applyPanelOrder(specs, ['a3', 'a1', 'a2']);
        expect(ids(out)).toEqual(['a3', 'x1', 'a1', 'x2', 'a2']);
        // The w2 specs are the very same objects, untouched.
        expect(out[1]).toBe(specs[1]);
        expect(out[3]).toBe(specs[3]);
    });

    it('ignores unknown ids and keeps the list intact', () => {
        const specs = [spec('a'), spec('b')];
        expect(ids(applyPanelOrder(specs, ['b', 'ghost', 'a']))).toEqual(['b', 'a']);
        expect(applyPanelOrder(specs, ['ghost'])).toBe(specs);
        expect(applyPanelOrder(specs, [])).toBe(specs);
    });

    it('preserves the full set — no spec dropped or duplicated', () => {
        const specs = [spec('a'), spec('b'), spec('c'), spec('d')];
        const out = applyPanelOrder(specs, ['d', 'c', 'b', 'a']);
        expect(out).toHaveLength(4);
        expect([...ids(out)].sort()).toEqual(['a', 'b', 'c', 'd']);
    });
});

describe('reorder persistence', () => {
    /**
     * The renderer's commit step (master.tsx `reorderSpecs`): apply the new
     * order locally so the tiles settle instantly, and send the SAME id list to
     * `terminalSpec.reorder` so it survives a reload. Modelled here against a
     * stub api so the contract is pinned without mounting the page.
     */
    it('applies locally AND sends the same ordered ids to terminalSpec.reorder', () => {
        const reorder = vi.fn().mockResolvedValue({ ok: true });
        let specs = [spec('a'), spec('b'), spec('c')];

        const reorderSpecs = (orderedIds: string[]) => {
            specs = applyPanelOrder(specs, orderedIds);
            void reorder(orderedIds);
        };

        reorderSpecs(movePanel(ids(specs), 'c', 'a'));

        expect(ids(specs)).toEqual(['c', 'a', 'b']);
        expect(reorder).toHaveBeenCalledTimes(1);
        expect(reorder).toHaveBeenCalledWith(['c', 'a', 'b']);
    });

    it('the persisted list is what a sort_order-ordered re-list would return', () => {
        // main writes index -> sort_order; list() sorts by it. Re-listing must
        // reproduce exactly the order the user dropped the panels into.
        const specs = [spec('a'), spec('b'), spec('c')];
        const orderedIds = movePanel(ids(specs), 'a', 'c');

        const persisted = orderedIds.map((id, i) => ({ id, sort_order: i }));
        const relisted = [...persisted].sort((x, y) => x.sort_order - y.sort_order);

        expect(relisted.map((r) => r.id)).toEqual(orderedIds);
        expect(ids(applyPanelOrder(specs, orderedIds))).toEqual(orderedIds);
    });
});
