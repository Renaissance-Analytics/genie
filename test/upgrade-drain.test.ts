import { describe, expect, it } from 'vitest';
import { DRAIN_LIMIT_MS, DRAIN_QUIET_MS, RESTORE_GAP_MS, drainAnswered, drainComplete, drainReport, drainTick, restoreSchedule, startDrain } from '../src/core/upgrade-drain.js';

/**
 * DRAIN BEFORE UPGRADING (§7.5) — pure. Every live agent is asked to stop, write a handoff and
 * acknowledge; a roster shows who has answered; a QUIET agent turns amber rather than being mistaken
 * for a slow one; nothing waits indefinitely (the limit); the report names who never answered.
 * RESTORE AFTER AN UPGRADE (§7.6): starts spaced at least three seconds apart, in order.
 */

const agents = [{ id: 'agent_a', name: 'atlas' }, { id: 'agent_b', name: 'bolt' }];

describe('the drain roster', () => {
    it('starts with every live agent asked; an answer marks it; quiet is time, not silence judged early', () => {
        const r0 = startDrain(agents, 1_000);
        expect(r0).toEqual({ startedAt: 1_000, entries: [{ agentId: 'agent_a', name: 'atlas', state: 'asked', askedAt: 1_000, answeredAt: null }, { agentId: 'agent_b', name: 'bolt', state: 'asked', askedAt: 1_000, answeredAt: null }] });
        expect(drainComplete(r0, 1_000)).toBe(false);

        const r1 = drainAnswered(r0, 'agent_a', 1_500);
        expect(r1.entries[0]).toMatchObject({ state: 'answered', answeredAt: 1_500 });
        // Not quiet yet: one tick before the threshold.
        expect(drainTick(r1, 1_000 + DRAIN_QUIET_MS - 1).entries[1]!.state).toBe('asked');
        const r2 = drainTick(r1, 1_000 + DRAIN_QUIET_MS);
        expect(r2.entries[1]).toMatchObject({ state: 'quiet' });
        // An answered agent never turns quiet; a quiet one can still answer.
        expect(r2.entries[0]!.state).toBe('answered');
        expect(drainAnswered(r2, 'agent_b', 1_000 + DRAIN_QUIET_MS + 5).entries[1]).toMatchObject({ state: 'answered' });
        expect(drainAnswered(r2, 'agent_zzz', 2_000)).toEqual(r2);
    });

    it('is complete when everyone answered, or when the limit passes — never before; the report names who never answered', () => {
        const r = drainAnswered(startDrain(agents, 1_000), 'agent_a', 1_200);
        expect(drainComplete(r, 1_000 + DRAIN_LIMIT_MS - 1)).toBe(false);
        expect(drainComplete(r, 1_000 + DRAIN_LIMIT_MS)).toBe(true);
        expect(drainComplete(drainAnswered(r, 'agent_b', 1_300), 1_400)).toBe(true);
        expect(drainReport(drainTick(r, 1_000 + DRAIN_LIMIT_MS))).toBe('1 of 2 agents wrote a handoff; bolt never answered and was stopped without one');
        expect(drainReport(drainAnswered(r, 'agent_b', 1_300))).toBe('2 of 2 agents wrote a handoff');
        expect(drainReport(startDrain([], 1_000))).toBe('no agents were running');
    });

    it('limits are real numbers a person would recognise', () => {
        expect(DRAIN_QUIET_MS).toBe(20_000);
        expect(DRAIN_LIMIT_MS).toBe(120_000);
    });
});

describe('restoreSchedule', () => {
    it('spaces starts at least three seconds apart, in the order given, the first at once', () => {
        expect(RESTORE_GAP_MS).toBe(3_000);
        expect(restoreSchedule(['agent_a', 'agent_b', 'agent_c'])).toEqual([{ agentId: 'agent_a', at: 0 }, { agentId: 'agent_b', at: 3_000 }, { agentId: 'agent_c', at: 6_000 }]);
        expect(restoreSchedule([])).toEqual([]);
    });
});
