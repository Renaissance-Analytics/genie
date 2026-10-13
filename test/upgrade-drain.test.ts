import { describe, expect, it } from 'vitest';
import { RESTORE_GAP_MS, restoreSchedule } from '../src/core/upgrade-drain.js';

/**
 * RESTORE AFTER AN UPGRADE (§7.6): starts spaced at least three seconds apart, in order. (The drain roster that waited
 * for every agent's handoff before installing is gone — the owner, 2026-10-12.)
 */

describe('restoreSchedule', () => {
    it('spaces starts at least three seconds apart, in the order given, the first at once', () => {
        expect(RESTORE_GAP_MS).toBe(3_000);
        expect(restoreSchedule(['agent_a', 'agent_b', 'agent_c'])).toEqual([{ agentId: 'agent_a', at: 0 }, { agentId: 'agent_b', at: 3_000 }, { agentId: 'agent_c', at: 6_000 }]);
        expect(restoreSchedule([])).toEqual([]);
    });
});
