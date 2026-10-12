import { describe, expect, it } from 'vitest';
import { activityLedger, lastOutputLabel } from '../src/core/observed.js';

/**
 * THE OBSERVED AGENT'S ACTIVITY TAB. Genie sees BYTES and when they came — nothing else (§4.1, §4.2). The tab draws
 * what was measured: the twelve bars, "last output Ns ago", and a ledger of bursts (`output burst · 12.1 kB`, the
 * board's `pty` row), newest first. Nothing here is a claim about intent, and nothing is a time Genie did not record.
 */
describe('activityLedger', () => {
    it('one row per burst, newest first, with the size in the board’s words', () => {
        const rows = activityLedger([{ at: 1_000, bytes: 512 }, { at: 3_000, bytes: 12_400 }, { at: 2_000, bytes: 40 }]);
        expect(rows.map((r) => [r.at, r.label])).toEqual([
            [3_000, 'output burst · 12.1 kB'],
            [2_000, 'output burst · 40 B'],
            [1_000, 'output burst · 512 B'],
        ]);
    });

    it('no bursts → an empty ledger (a measured nothing), never a placeholder row', () => {
        expect(activityLedger([])).toEqual([]);
    });
});

describe('lastOutputLabel', () => {
    it('says how long ago the TUI last printed, or that it has not yet — never a dash', () => {
        expect(lastOutputLabel(10_000, 50_000)).toBe('last output 40s ago');
        expect(lastOutputLabel(10_000, 130_000)).toBe('last output 2m ago');
        expect(lastOutputLabel(null, 50_000)).toBe('no output yet');
    });
});
