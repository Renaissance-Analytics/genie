import { describe, expect, it } from 'vitest';
import { planSteps } from '../src/core/agent-view.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';

/**
 * THE PLAN PANEL'S STEPS (the board: seven steps with ✓ / ◐ / ○, the current one bold). From the agent's LATEST
 * plan update — the same entries the host counts into `step/of` — each step with its own status as the provider
 * said it. An entry Genie cannot read is dropped from the list, never invented; a plan with no readable entry is no
 * list at all.
 */
const t = (id: string, event: StreamEvent): TimedEvent => ({ id, event, at: 1_000 });
const plan = (id: string, entries: unknown[]): TimedEvent => t(id, { kind: 'plan', entries });

describe('planSteps', () => {
    it('the latest plan wins; each step keeps its status; the current one is marked', () => {
        const rows = [
            plan('p1', [{ content: 'old', status: 'completed' }]),
            t('m', { kind: 'message', speaker: 'agent', peerName: null, text: 'hi' }),
            plan('p2', [
                { content: 'Read the brief', status: 'completed', priority: 'high' },
                { content: 'Write the migration', status: 'in_progress' },
                { content: 'Run the suite', status: 'pending' },
            ]),
        ];
        expect(planSteps(rows)).toEqual([
            { content: 'Read the brief', status: 'completed', current: false },
            { content: 'Write the migration', status: 'in_progress', current: true },
            { content: 'Run the suite', status: 'pending', current: false },
        ]);
    });

    it('an unreadable entry is dropped, a status Genie does not know is kept as the provider wrote it', () => {
        const rows = [plan('p', [{ content: 'a', status: 'completed' }, { nope: true }, { content: 'b', status: 'blocked' }])];
        expect(planSteps(rows)).toEqual([
            { content: 'a', status: 'completed', current: false },
            { content: 'b', status: 'blocked', current: false },
        ]);
    });

    it('no plan, or no readable entry → null (the panel stays as it was: step/of only, or absent)', () => {
        expect(planSteps([])).toBeNull();
        expect(planSteps([t('m', { kind: 'message', speaker: 'you', peerName: null, text: 'go' })])).toBeNull();
        expect(planSteps([plan('p', [{ nope: true }])])).toBeNull();
    });
});
