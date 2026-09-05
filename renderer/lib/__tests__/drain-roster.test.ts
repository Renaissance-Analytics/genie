import { describe, expect, it } from 'vitest';
import {
    drainRosterSummary,
    drainRowIcon,
    drainRowStatusLabel,
    canSatisfyDrainRow,
} from '../drain-roster';
import type { DrainRow, DrainSnapshot } from '../../../main/agents/drain';

/**
 * THE "WAITING ON" ROSTER, as a person reads it (genie#389).
 *
 * *"One row per agent, an EMPTY icon while waiting, filled GREEN the moment
 * that agent's `thumbsUp` lands"* — and a stuck agent's row SAYS SO, because
 * telling a slow agent from a wedged one is the whole reason the user can act
 * at all.
 *
 * The decisions live here rather than in JSX so they can be asserted: the
 * renderer has no DOM harness in this lane, and "the icon is empty" is exactly
 * the kind of claim that quietly stops being true.
 */

const row = (over: Partial<DrainRow> = {}): DrainRow => ({
    agentId: 'ws1:moic',
    inboxAgentId: 'inbox-moic',
    terminalId: 'term-moic',
    name: 'moic',
    workspaceId: 'ws1',
    state: 'waiting',
    satisfiedBy: null,
    note: null,
    ...over,
});

const snapshot = (rows: DrainRow[]): DrainSnapshot => ({
    active: true,
    startedAt: 0,
    rows,
    complete: rows.length > 0 && rows.every((r) => r.state !== 'waiting' && r.state !== 'stuck'),
});

describe('drainRowIcon', () => {
    it('is EMPTY while an agent has not answered', () => {
        expect(drainRowIcon(row({ state: 'waiting' }))).toBe('empty');
    });

    it('is FILLED once the agent’s own thumbsUp lands', () => {
        expect(drainRowIcon(row({ state: 'ready', satisfiedBy: 'agent' }))).toBe('filled');
    });

    it('is FILLED when a person pressed the thumb — it is still satisfied', () => {
        expect(drainRowIcon(row({ state: 'satisfied', satisfiedBy: 'user' }))).toBe('filled');
    });

    it('is ALERT for a stuck agent — visibly different from a slow one', () => {
        // The acceptance line: *"A stuck agent is visibly distinguished from a
        // slow one."* Same icon for both is the failure.
        expect(drainRowIcon(row({ state: 'stuck' }))).toBe('alert');
        expect(drainRowIcon(row({ state: 'stuck' }))).not.toBe(
            drainRowIcon(row({ state: 'waiting' })),
        );
    });

    it('is CLOSED for an agent whose terminal died — not a thumb nobody gave', () => {
        expect(drainRowIcon(row({ state: 'gone' }))).toBe('closed');
    });
});

describe('drainRowStatusLabel', () => {
    it('names who filled the row in, so a press is never read as an answer', () => {
        expect(drainRowStatusLabel(row({ state: 'ready', satisfiedBy: 'agent' }))).toMatch(
            /handed off/i,
        );
        expect(drainRowStatusLabel(row({ state: 'satisfied', satisfiedBy: 'user' }))).toMatch(
            /you/i,
        );
    });

    it('prefers the row’s own note over the generic label', () => {
        // The note is the specific reason — "not delivered" reads differently
        // from "has not answered", and the difference tells the user what to do.
        expect(
            drainRowStatusLabel(row({ state: 'stuck', note: 'Genie could not reach this agent' })),
        ).toBe('Genie could not reach this agent');
    });

    it('still says something for a stuck row with no note', () => {
        expect(drainRowStatusLabel(row({ state: 'stuck' })).length).toBeGreaterThan(0);
    });
});

describe('canSatisfyDrainRow', () => {
    it('offers the manual press on a row that is still holding things up', () => {
        expect(canSatisfyDrainRow(row({ state: 'waiting' }))).toBe(true);
        expect(canSatisfyDrainRow(row({ state: 'stuck' }))).toBe(true);
    });

    it('does NOT offer it on a row that is already green', () => {
        for (const state of ['ready', 'satisfied', 'gone'] as const) {
            expect(canSatisfyDrainRow(row({ state }))).toBe(false);
        }
    });
});

describe('drainRosterSummary', () => {
    it('counts what is still being waited on', () => {
        const s = drainRosterSummary(
            snapshot([
                row({ agentId: 'a', state: 'ready' }),
                row({ agentId: 'b', state: 'waiting' }),
                row({ agentId: 'c', state: 'stuck' }),
            ]),
        );
        expect(s.green).toBe(1);
        expect(s.pending).toBe(2);
        expect(s.stuck).toBe(1);
    });

    it('says the upgrade is held, and names how many are left', () => {
        const s = drainRosterSummary(snapshot([row({ state: 'waiting' })]));
        expect(s.headline).toMatch(/1 agent/i);
        expect(s.done).toBe(false);
    });

    it('says the upgrade is going ahead once every row is green', () => {
        const s = drainRosterSummary(
            snapshot([row({ agentId: 'a', state: 'ready' }), row({ agentId: 'b', state: 'gone' })]),
        );
        expect(s.done).toBe(true);
        expect(s.pending).toBe(0);
        // POSITIVE CONTROL: the headline actually changes, rather than the flag
        // alone moving while the user reads the same sentence.
        expect(s.headline).not.toBe(drainRosterSummary(snapshot([row()])).headline);
    });
});
