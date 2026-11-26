import { describe, expect, it } from 'vitest';
import { planSteps } from '../src/core/agent-view.js';
import { planStepsOf } from '../src/core/live-readings.js';
import { toStreamEvent } from '../src/core/stream-event.js';

/**
 * prism-acp 0.48.0 PREFIXES MODEL-WRITTEN PLAN TITLES with "Step: " (`PLAN_TITLE_NEUTRAL`, G-362), so model text never
 * stands where a host label (`[failed] `, `(you) `) stands, and gives every entry `priority: "medium"`. Genie's plan views
 * (the chat header, the Dashboard popover, the plan tool) read the step, not the safety prefix: it is taken off where the
 * plan is parsed, and ONLY when it is exactly the leading "Step: ".
 */

const plan = (entries: unknown[]) => {
    const event = toStreamEvent({ sessionUpdate: 'plan', entries });
    if (event?.kind !== 'plan') throw new Error('not a plan');
    return event;
};

describe('a plan entry\'s "Step: " prefix', () => {
    it('is taken off: the views read the step', () => {
        const event = plan([
            { content: 'Step: Build the launcher', status: 'completed', priority: 'medium' },
            { content: 'Step: Run the gate', status: 'in_progress', priority: 'medium' },
        ]);
        expect(planStepsOf(event)).toEqual([
            { content: 'Build the launcher', status: 'completed' },
            { content: 'Run the gate', status: 'in_progress' },
        ]);
        expect(planSteps([{ id: 'r', at: 1, event } as never])?.map((s) => s.content)).toEqual(['Build the launcher', 'Run the gate']);
    });

    it('CONTROL: only the exact leading "Step: " goes; anything else is left as written', () => {
        const event = plan([
            { content: 'Step:no space', status: 'pending' },
            { content: 'step: lower case', status: 'pending' },
            { content: 'Steps: plural', status: 'pending' },
            { content: '[failed] Step: a host label first', status: 'pending' },
            { content: 'Fix the Step: inside', status: 'pending' },
            { content: 'Step: Step: twice', status: 'pending' },
            { content: 'Untitled step', status: 'pending' },
        ]);
        expect(planStepsOf(event).map((s) => s.content)).toEqual([
            'Step:no space', 'step: lower case', 'Steps: plural', '[failed] Step: a host label first', 'Fix the Step: inside', 'Step: twice', 'Untitled step',
        ]);
    });

    it('an entry that is only the prefix keeps it (nothing would be left to show)', () => {
        expect(planStepsOf(plan([{ content: 'Step: ', status: 'pending' }])).map((s) => s.content)).toEqual(['Step: ']);
    });

    it('CONTROL: an entry Genie cannot read is passed through untouched', () => {
        const odd = { content: 7, status: 'pending' };
        expect(plan([odd]).entries).toEqual([odd]);
    });
});
