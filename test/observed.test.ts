import { describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { ACTIVITY_BARS, BAR_HEIGHT_PX, activityBars, observedRowFor, observedState, type TakeOverProbe } from '../src/core/observed.js';

/**
 * OBSERVED — what Genie can honestly say about a TUI it opened via Take Over and does not
 * manage: bytes came out, and when. §4.1: *"For an Observed agent this cell holds activity bars
 * instead — a measurement, not a claim."* Status is `Active` / `Quiet`, never Working / Idle.
 *
 * Everything here is pure. The host that measures is `take-over-host.ts`; this is the
 * arithmetic and the row.
 */

const NOW = 1_760_000_060_000;

describe('activity bars — bytes per bucket, newest last, scaled to the row', () => {
    it('draws twelve bars, COUNTED, from bursts in the last minute', () => {
        const bursts = [{ at: NOW - 2_000, bytes: 800 }, { at: NOW - 7_000, bytes: 400 }];
        const bars = activityBars(bursts, NOW);

        expect(bars).toHaveLength(ACTIVITY_BARS);
        expect(ACTIVITY_BARS).toBe(12);
    });

    it('puts the newest burst in the LAST bar, so the eye reads left-to-right as time', () => {
        const bars = activityBars([{ at: NOW - 1_000, bytes: 100 }], NOW);
        expect(bars[ACTIVITY_BARS - 1]).toBeGreaterThan(0);
        expect(bars.slice(0, ACTIVITY_BARS - 1).every((b) => b === 0)).toBe(true);
    });

    it('scales the busiest bucket to the full row height and the rest in proportion', () => {
        // Bucket width is 5 s. 100 bytes at t-1s, 50 bytes at t-6s: the newest bar is full
        // height, the one before it half.
        const bars = activityBars([{ at: NOW - 1_000, bytes: 100 }, { at: NOW - 6_000, bytes: 50 }], NOW);
        expect(bars[ACTIVITY_BARS - 1]).toBe(BAR_HEIGHT_PX);
        expect(bars[ACTIVITY_BARS - 2]).toBe(BAR_HEIGHT_PX / 2);
    });

    it('is all zeros with no bursts — a MEASURED nothing, drawn, not absent', () => {
        // A quiet TUI is still an observed one; twelve zero-height bars say "watched, nothing
        // came out", where no bars at all would say "not watching".
        const bars = activityBars([], NOW);
        expect(bars).toEqual(Array.from({ length: ACTIVITY_BARS }, () => 0));
    });

    it('ignores bursts older than the window', () => {
        const bars = activityBars([{ at: NOW - 120_000, bytes: 9_999 }], NOW);
        expect(bars.every((b) => b === 0)).toBe(true);
    });
});

describe('Active or Quiet — from recency, which is all Genie can see', () => {
    it('is active with output in the last 30 seconds', () => {
        expect(observedState(NOW - 29_000, NOW)).toBe('active');
    });

    it('is quiet after 30 seconds of silence, and quiet with no output ever', () => {
        expect(observedState(NOW - 31_000, NOW)).toBe('quiet');
        expect(observedState(null, NOW)).toBe('quiet');
    });
});

describe('the Observed row', () => {
    const record = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'kora' });
    const probe: TakeOverProbe = {
        terminalId: 'term_1',
        startedAt: NOW - 90_000,
        lastOutputAt: NOW - 5_000,
        bursts: [{ at: NOW - 5_000, bytes: 300 }],
    };

    it('is observed, and ACTIVE reads as the working state so the board colours it green', () => {
        const row = observedRowFor(record, probe, NOW);
        expect(row).toMatchObject({ id: record.id, name: 'kora', fidelity: 'observed', state: 'working' });
        // The duration is since the Take Over started — a fact about a thing that is running.
        expect(row.duration).toBe('1m');
    });

    it('is QUIET as the idle state', () => {
        const row = observedRowFor(record, { ...probe, lastOutputAt: NOW - 60_000 }, NOW);
        expect(row.state).toBe('idle');
        expect(row.duration).toBeNull();
    });

    it('carries the activity bars, and NOTHING a TUI cannot report — COUNTED null', () => {
        /**
         * §4.1: observed agents have no comms cell, no context cell, no cost cell; the target
         * cell holds bars instead. Every field a declared agent reports is `null` here, not
         * zero and not a dash — Genie does not see them, and §5 says a number it cannot see
         * renders as nothing.
         */
        const row = observedRowFor(record, probe, NOW);
        expect(row.activity).toHaveLength(ACTIVITY_BARS);

        const mustBeNull = ['ask', 'reason', 'step', 'target', 'delivery', 'collaborators', 'commsAgeSeconds', 'contextUsed', 'contextSize'] as const;
        const notNull = mustBeNull.filter((k) => row[k] !== null);
        expect(notNull).toEqual([]);
        expect(row.fixes).toEqual([]);
    });

    it('keeps the record’s id byte-identical — the one identity rule', () => {
        expect(observedRowFor(record, probe, NOW).id).toBe(record.id);
    });
});
