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
    describeOutcome,
    describeTrigger,
    describeTriggers,
    relativeTime,
} from '../flow-view';

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
    /**
     * Triggers are read off the GRAPH now, so these describe trigger NODES.
     * The clause-prose suite that used to sit below this is gone with the filter
     * language it described: a condition is a `branch` node on the canvas, and
     * "why did this not fire" is answered by node statuses on the graph rather
     * than by a sentence reconstructing a predicate.
     */
    it('names a manual trigger for what it is', () => {
        expect(describeTrigger({ nodeId: 't', kind: 'manual' })).toBe('When you run it');
    });

    it('gives a schedule its cron, because that is the answer people want', () => {
        expect(describeTrigger({ nodeId: 't', kind: 'schedule', cron: '0 3 * * *' })).toBe(
            'On a schedule (0 3 * * *)',
        );
    });

    it('says a schedule has no cron rather than implying it will fire', () => {
        // The worst failure available for a schedule is looking armed and never
        // firing, so an unset cron is SAID.
        expect(describeTrigger({ nodeId: 't', kind: 'schedule' })).toBe(
            'On a schedule — none set',
        );
    });

    it('names the event an event trigger listens for', () => {
        expect(describeTrigger({ nodeId: 't', kind: 'event', event: 'files:added' })).toBe(
            'When files:added',
        );
    });

    it('says an event trigger has nothing chosen — it is not a wildcard', () => {
        expect(describeTrigger({ nodeId: 't', kind: 'event' })).toBe(
            'When something happens — nothing chosen',
        );
    });

    it('passes on the reason a webhook cannot be armed', () => {
        expect(
            describeTrigger({ nodeId: 't', kind: 'webhook', unsupported: 'nowhere to land' }),
        ).toBe('nowhere to land');
    });

    it('says so when a flow has no trigger at all', () => {
        expect(describeTriggers([])).toBe('No trigger');
    });

    it('joins several, because a graph may hold more than one', () => {
        expect(
            describeTriggers([
                { nodeId: 'a', kind: 'manual' },
                { nodeId: 'b', kind: 'schedule', cron: '0 3 * * *' },
            ]),
        ).toBe('When you run it · On a schedule (0 3 * * *)');
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

describe('the two states the runtime cannot report about itself', () => {
    it('shows a run still in flight as running, not as an absent outcome', () => {
        expect(describeOutcome('running').label).toBe('Running');
    });

    it('does NOT call an interrupted run a failure', () => {
        // Genie stopped on top of it; the Flow did not fail. A user reading
        // "Failed" would go hunting for a bug in an automation that never had
        // one.
        expect(describeOutcome('interrupted').label).toBe('Interrupted');
        expect(describeOutcome('interrupted').label).not.toBe(
            describeOutcome('failed').label,
        );
        expect(describeOutcome('interrupted').color).not.toBe(
            describeOutcome('failed').color,
        );
    });

    it('greens neither of them', () => {
        // The green column has to keep meaning "this Flow did its job".
        expect(describeOutcome('running').color).not.toBe('emerald');
        expect(describeOutcome('interrupted').color).not.toBe('emerald');
        // Positive control: something IS green, so the two assertions above are
        // about these states rather than about nothing ever being green.
        expect(describeOutcome('ran').color).toBe('emerald');
    });
});

describe('a trigger whose producer went away', () => {
    /**
     * The one thing a list would never tell you. A flow whose event no longer
     * has a producer looks completely normal — enabled, titled, pointing at an
     * event — and simply never fires.
     */
    it('says so where the trigger is named', () => {
        expect(
            describeTrigger({ nodeId: 't', kind: 'event', event: 'ghost:vanished', known: false }),
        ).toBe('ghost:vanished — nothing emits this any more');
    });

    it('says nothing unusual when the producer is still there', () => {
        expect(
            describeTrigger({ nodeId: 't', kind: 'event', event: 'files:added', known: true }),
        ).toBe('When files:added');
    });

    it('treats an unannotated trigger as fine, not as dead', () => {
        // `known` is absent on a schedule or a manual trigger, and absent is not
        // false: reading it as dead would warn about every flow in the list.
        expect(describeTrigger({ nodeId: 't', kind: 'event', event: 'files:added' })).toBe(
            'When files:added',
        );
    });
});
