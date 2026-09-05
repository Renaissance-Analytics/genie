/**
 * Turning a Flow summary into the sentences the manager prints.
 *
 * The manager's job is to answer "why did (or didn't) this happen", so its
 * strings ARE the feature. A row that renders `files:added` and a raw epoch is
 * a row that made the user open the database instead.
 *
 * Pure helpers rather than JSX, so the wording is pinned by a test that does not
 * need a DOM — and so the same sentence cannot drift between the list and the
 * run-history drawer.
 */

import { describe, expect, it } from 'vitest';
import {
    describeClause,
    describeOutcome,
    describeTrigger,
    relativeTime,
    runIsInteresting,
} from '../flow-view';
import type { FlowSummaryTrigger } from '../genie';

describe('outcomes, said in words with a colour', () => {
    it('distinguishes the two that actually executed a body from the rest', () => {
        expect(describeOutcome('ran').label).toBe('Ran');
        expect(describeOutcome('failed').label).toBe('Failed');
        // These three never entered a body — the wording must not imply they did.
        expect(describeOutcome('blocked').label).toBe('Held back');
        expect(describeOutcome('refused').label).toBe('Refused');
        expect(describeOutcome('handoff').label).toBe('Needs you');
        expect(describeOutcome('error').label).toBe('Misconfigured');
    });

    it('greens only the success, so a glance down the column is honest', () => {
        expect(describeOutcome('ran').color).toBe('emerald');
        const others = (['failed', 'blocked', 'refused', 'handoff', 'error'] as const).map(
            (o) => describeOutcome(o).color,
        );
        expect(others).not.toContain('emerald');
    });

    it('names an outcome it has never seen rather than rendering nothing', () => {
        // A new outcome added to the runtime must not make a row go blank.
        expect(describeOutcome('teleported' as never).label).toBe('teleported');
    });
});

describe('triggers, said in words', () => {
    it('describes a manual trigger', () => {
        expect(describeTrigger({ kind: 'manual' })).toBe('When you run it');
    });

    it('uses the event label, not the id', () => {
        const t: FlowSummaryTrigger = {
            kind: 'event',
            event: 'files:added',
            eventLabel: 'A file was added',
            known: true,
            clauses: [],
        };
        expect(describeTrigger(t)).toBe('A file was added');
    });

    it('counts the conditions when a filter narrows it', () => {
        const t: FlowSummaryTrigger = {
            kind: 'event',
            event: 'files:added',
            eventLabel: 'A file was added',
            known: true,
            clauses: [
                { group: 'all', prop: 'sizeBytes', propLabel: 'Size', op: 'gt', value: 5 },
                { group: 'none', prop: 'relPath', propLabel: 'Path', op: 'startsWith', value: '.git' },
            ],
        };
        expect(describeTrigger(t)).toBe('A file was added, with 2 conditions');
    });

    it('says an unknown event cannot fire instead of printing a bare id', () => {
        const t: FlowSummaryTrigger = {
            kind: 'event',
            event: 'ghost:vanished',
            eventLabel: 'ghost:vanished',
            known: false,
            clauses: [],
        };
        expect(describeTrigger(t)).toBe('ghost:vanished — nothing emits this any more');
    });
});

describe('one condition, said in words', () => {
    it('reads an `all` clause as a plain requirement', () => {
        expect(
            describeClause({
                group: 'all',
                prop: 'sizeBytes',
                propLabel: 'Size in bytes',
                op: 'gt',
                value: 5_242_880,
            }),
        ).toBe('Size in bytes is over 5,242,880');
    });

    it('negates a `none` clause rather than reading like an `all` one', () => {
        // The reference case is "over 5 MB, but NOT already in the folder we move
        // to". Dropping the negation inverts what the Flow does.
        expect(
            describeClause({
                group: 'none',
                prop: 'relPath',
                propLabel: 'Path',
                op: 'startsWith',
                value: '.genie/',
            }),
        ).toBe('Path does not start with “.genie/”');
    });

    it('marks an `any` clause as one of several alternatives', () => {
        expect(
            describeClause({
                group: 'any',
                prop: 'ext',
                propLabel: 'Extension',
                op: 'eq',
                value: 'png',
            }),
        ).toBe('or Extension is “png”');
    });

    it('renders a list value as a list', () => {
        expect(
            describeClause({
                group: 'all',
                prop: 'ext',
                propLabel: 'Extension',
                op: 'in',
                value: ['png', 'jpg'],
            }),
        ).toBe('Extension is one of “png”, “jpg”');
    });

    it('falls back to the operator itself for one it has no phrasing for', () => {
        expect(
            describeClause({
                group: 'all',
                prop: 'x',
                propLabel: 'X',
                op: 'approximately',
                value: 1,
            }),
        ).toBe('X approximately 1');
    });
});

describe('when it happened', () => {
    const now = Date.parse('2026-09-04T12:00:00Z');

    it('says just now for the last minute', () => {
        expect(relativeTime(now - 5_000, now)).toBe('just now');
    });

    it('counts minutes, then hours, then days', () => {
        expect(relativeTime(now - 5 * 60_000, now)).toBe('5 minutes ago');
        expect(relativeTime(now - 60 * 60_000, now)).toBe('1 hour ago');
        expect(relativeTime(now - 26 * 60 * 60_000, now)).toBe('yesterday');
        expect(relativeTime(now - 5 * 24 * 60 * 60_000, now)).toBe('5 days ago');
    });

    it('singularises, so nothing reads "1 minutes ago"', () => {
        expect(relativeTime(now - 60_000, now)).toBe('1 minute ago');
        expect(relativeTime(now - 2 * 60 * 60_000, now)).toBe('2 hours ago');
    });

    it('falls back to a date once relative time stops meaning anything', () => {
        expect(relativeTime(Date.parse('2026-01-04T12:00:00Z'), now)).toMatch(/2026/);
    });

    it('does not report a future timestamp as a long time ago', () => {
        // Clock skew between the runtime's `Date.now()` and the renderer's is
        // small but real, and "in -3 seconds" is worse than a rounded present.
        expect(relativeTime(now + 3_000, now)).toBe('just now');
    });
});

describe('which runs are worth surfacing', () => {
    it('treats anything that is not a clean run as interesting', () => {
        expect(runIsInteresting('ran')).toBe(false);
        // Positive control for the line above: the predicate is not simply false.
        expect(runIsInteresting('failed')).toBe(true);
        expect(runIsInteresting('refused')).toBe(true);
        expect(runIsInteresting('blocked')).toBe(true);
        expect(runIsInteresting('error')).toBe(true);
        expect(runIsInteresting('handoff')).toBe(true);
    });
});
