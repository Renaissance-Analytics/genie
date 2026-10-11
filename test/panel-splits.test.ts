import { describe, expect, it } from 'vitest';
import { dragSplit, gridTemplate, serializeSplits, splitsFrom } from '../src/core/panel-layout.js';
import { SETTINGS, searchSettings } from '../src/core/settings.js';

/**
 * SPLIT SIZES REMEMBERED PER WORKSPACE AND PER ARRANGEMENT (§4.6, §6.5). A drag between two panes moves
 * their boundary; the fractions are kept in a workspace setting (`panel_splits`, JSON per layout mode) so
 * the same arrangement comes back the same way. A stored split that does not fit — wrong count, a pane
 * squeezed under a tenth, a sum that is not one — is ignored, not repaired: equal panes, as if nothing
 * were stored. The setting is INTERNAL: it is not drawn in any settings list and search does not find it.
 */

describe('splitsFrom', () => {
    const stored = JSON.stringify({ columns: [0.6, 0.4], rows: [0.3, 0.7], grid: { columns: [0.5, 0.5], rows: [0.25, 0.75] } });

    it('reads the mode’s fractions when they fit the count shown', () => {
        expect(splitsFrom({ panel_splits: stored }, 'columns', 2)).toEqual({ columns: [0.6, 0.4], rows: null });
        expect(splitsFrom({ panel_splits: stored }, 'rows', 2)).toEqual({ columns: null, rows: [0.3, 0.7] });
        expect(splitsFrom({ panel_splits: stored }, 'grid', 4)).toEqual({ columns: [0.5, 0.5], rows: [0.25, 0.75] });
    });

    it('nothing stored, a bad blob, a wrong count, a squeezed pane or a sum that is not one: null — equal panes, nothing repaired', () => {
        expect(splitsFrom({}, 'columns', 2)).toEqual({ columns: null, rows: null });
        expect(splitsFrom({ panel_splits: 'not json' }, 'columns', 2)).toEqual({ columns: null, rows: null });
        expect(splitsFrom({ panel_splits: stored }, 'columns', 1)).toEqual({ columns: null, rows: null });
        expect(splitsFrom({ panel_splits: JSON.stringify({ columns: [0.95, 0.05] }) }, 'columns', 2)).toEqual({ columns: null, rows: null });
        expect(splitsFrom({ panel_splits: JSON.stringify({ columns: [0.6, 0.6] }) }, 'columns', 2)).toEqual({ columns: null, rows: null });
        expect(splitsFrom({ panel_splits: stored }, 'single', 1)).toEqual({ columns: null, rows: null });
        // grid with two panes is one row of two: the columns half applies, the rows half does not.
        expect(splitsFrom({ panel_splits: stored }, 'grid', 2)).toEqual({ columns: [0.5, 0.5], rows: null });
    });
});

describe('gridTemplate with splits', () => {
    it('weights the tracks by the fractions; without fractions the tracks are equal, exactly as before', () => {
        expect(gridTemplate('columns', 2, { columns: [0.6, 0.4], rows: null })).toEqual({ columns: 'minmax(0, 60fr) minmax(0, 40fr)', rows: 'minmax(0, 1fr)' });
        expect(gridTemplate('rows', 2, { columns: null, rows: [0.3, 0.7] })).toEqual({ columns: 'minmax(0, 1fr)', rows: 'minmax(0, 30fr) minmax(0, 70fr)' });
        expect(gridTemplate('grid', 4, { columns: [0.5, 0.5], rows: [0.25, 0.75] })).toEqual({ columns: 'minmax(0, 50fr) minmax(0, 50fr)', rows: 'minmax(0, 25fr) minmax(0, 75fr)' });
        expect(gridTemplate('columns', 2)).toEqual({ columns: 'repeat(2, minmax(0, 1fr))', rows: 'minmax(0, 1fr)' });
        expect(gridTemplate('columns', 2, { columns: null, rows: null })).toEqual({ columns: 'repeat(2, minmax(0, 1fr))', rows: 'minmax(0, 1fr)' });
    });
});

describe('dragSplit', () => {
    it('moves the boundary between two neighbours by a fraction of the whole, keeps the sum, and never squeezes a pane under a tenth', () => {
        expect(dragSplit([0.5, 0.5], 0, 0.1)).toEqual([0.6, 0.4]);
        expect(dragSplit([0.5, 0.5], 0, -0.2)).toEqual([0.3, 0.7]);
        expect(dragSplit([0.5, 0.5], 0, 0.9)).toEqual([0.9, 0.1]);
        expect(dragSplit([0.5, 0.5], 0, -0.9)).toEqual([0.1, 0.9]);
        expect(dragSplit([0.25, 0.25, 0.5], 1, 0.1).map((f) => Math.round(f * 100))).toEqual([25, 35, 40]);
        // A boundary that does not exist moves nothing.
        expect(dragSplit([0.5, 0.5], 1, 0.1)).toEqual([0.5, 0.5]);
        expect(dragSplit([1], 0, 0.1)).toEqual([1]);
    });
});

describe('serializeSplits', () => {
    it('writes the mode’s fractions into the stored blob, keeping the other modes; a bad blob is replaced', () => {
        const next = serializeSplits(JSON.stringify({ rows: [0.3, 0.7] }), 'columns', { columns: [0.6, 0.4], rows: null });
        expect(JSON.parse(next)).toEqual({ rows: [0.3, 0.7], columns: [0.6, 0.4] });
        const grid = serializeSplits(next, 'grid', { columns: [0.5, 0.5], rows: [0.25, 0.75] });
        expect(JSON.parse(grid)).toEqual({ rows: [0.3, 0.7], columns: [0.6, 0.4], grid: { columns: [0.5, 0.5], rows: [0.25, 0.75] } });
        expect(JSON.parse(serializeSplits('garbage', 'rows', { columns: null, rows: [0.5, 0.5] }))).toEqual({ rows: [0.5, 0.5] });
    });
});

describe('the panel_splits setting', () => {
    it('exists for the workspace, is internal, and search never surfaces it', () => {
        const def = SETTINGS.find((s) => s.key === 'panel_splits');
        expect(def).toMatchObject({ scope: 'workspace', type: 'string', hidden: true });
        expect(searchSettings('split').map((s) => s.key)).not.toContain('panel_splits');
        expect(searchSettings('').map((s) => s.key)).not.toContain('panel_splits');
        // The positive control: a visible setting IS found by search.
        expect(searchSettings('layout').map((s) => s.key)).toContain('panel_layout');
    });
});
