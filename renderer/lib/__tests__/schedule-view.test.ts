import { describe, expect, it } from 'vitest';

import {
    formatLastRun,
    formatNextRun,
    isScheduledSpec,
    lastRunTone,
    SCHEDULE_PRESETS,
} from '../schedule-view';

/**
 * DISPLAY-ONLY helpers for the Processes panel's scheduled tasks.
 *
 * There is deliberately no cron parsing here: the HOST owns the evaluator and
 * hands the renderer a formatted `description` alongside the armed instant
 * (ScheduleInfo), so a second copy can never drift from the one that decides
 * when a task actually fires. These are pure, so they're testable without a DOM.
 */

const NOW = new Date(2026, 6, 24, 10, 0, 0, 0).getTime(); // Fri 2026-07-24 10:00

describe('formatNextRun', () => {
    it('says when a task is not armed', () => {
        expect(formatNextRun(null, NOW)).toBe('Not scheduled');
    });

    it('counts down in minutes under an hour', () => {
        expect(formatNextRun(NOW + 60_000, NOW)).toBe('in 1 min');
        expect(formatNextRun(NOW + 45 * 60_000, NOW)).toBe('in 45 min');
    });

    it('counts down in hours under a day', () => {
        expect(formatNextRun(NOW + 60 * 60_000, NOW)).toBe('in 1 hr');
        expect(formatNextRun(NOW + 5 * 60 * 60_000, NOW)).toBe('in 5 hr');
    });

    it('counts down in days beyond that', () => {
        expect(formatNextRun(NOW + 48 * 60 * 60_000, NOW)).toBe('in 2 days');
        expect(formatNextRun(NOW + 24 * 60 * 60_000, NOW)).toBe('in 1 day');
    });

    it('reads "due now" at or just past the instant (a fire in flight)', () => {
        expect(formatNextRun(NOW, NOW)).toBe('due now');
        expect(formatNextRun(NOW - 5_000, NOW)).toBe('due now');
    });
});

describe('formatLastRun', () => {
    it('says when a task has never run', () => {
        expect(formatLastRun(undefined, undefined, NOW)).toBe('Never run');
    });

    it('pairs the outcome with how long ago it was', () => {
        expect(formatLastRun(NOW - 90_000, 'ok', NOW)).toBe('Ran 1 min ago');
        expect(formatLastRun(NOW - 3 * 60 * 60_000, 'failed', NOW)).toBe('Failed 3 hr ago');
        expect(formatLastRun(NOW - 2 * 24 * 60 * 60_000, 'skipped', NOW)).toBe(
            'Skipped 2 days ago',
        );
    });

    it('reads "just now" inside the first minute', () => {
        expect(formatLastRun(NOW - 5_000, 'ok', NOW)).toBe('Ran just now');
    });

    it('falls back to a neutral "Ran" when the status was not recorded', () => {
        // A run in flight clears last_run_status until its exit lands.
        expect(formatLastRun(NOW - 60_000, undefined, NOW)).toBe('Ran 1 min ago');
    });
});

describe('lastRunTone — the dot colour class', () => {
    it('maps each outcome, and stays neutral when unknown', () => {
        expect(lastRunTone('ok')).toBe('ok');
        expect(lastRunTone('failed')).toBe('failed');
        expect(lastRunTone('skipped')).toBe('skipped');
        expect(lastRunTone(undefined)).toBe('none');
    });
});

describe('isScheduledSpec', () => {
    it('is true only for a process spec carrying a non-empty schedule', () => {
        expect(isScheduledSpec({ type: 'process', meta: { schedule: '0 3 * * *' } })).toBe(true);
        expect(isScheduledSpec({ type: 'process', meta: { schedule: '   ' } })).toBe(false);
        expect(isScheduledSpec({ type: 'process', meta: { command: 'x' } })).toBe(false);
        expect(isScheduledSpec({ type: 'terminal', meta: { schedule: '0 3 * * *' } })).toBe(false);
        expect(isScheduledSpec(undefined)).toBe(false);
    });
});

describe('SCHEDULE_PRESETS — the dropdown next to the expression field', () => {
    it('leads with a "no schedule" choice so a task can be turned back into a plain process', () => {
        expect(SCHEDULE_PRESETS[0].value).toBe('');
    });

    it('offers a custom escape hatch and otherwise only real expressions', () => {
        const custom = SCHEDULE_PRESETS.filter((p) => p.value === 'custom');
        expect(custom).toHaveLength(1);
        for (const p of SCHEDULE_PRESETS) {
            if (p.value === '' || p.value === 'custom') continue;
            expect(p.value.trim().split(/\s+/), p.label).toHaveLength(5);
        }
    });

    it('labels every option', () => {
        for (const p of SCHEDULE_PRESETS) expect(p.label.length).toBeGreaterThan(0);
    });
});
