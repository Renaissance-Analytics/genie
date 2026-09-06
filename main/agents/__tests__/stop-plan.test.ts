import { describe, expect, it } from 'vitest';
import { planAgentStop } from '../stop-plan';

/**
 * STOPPING an agent — genie#474.
 *
 * The renderer had no stop-an-agent path at all. What it had was `agents:delete`,
 * which tears the record down: a different verb with a different consequence, and
 * wiring a Stop button to it would be a control that does something other than
 * what it says, on a surface whose whole purpose is recovering agents you did not
 * mean to lose.
 *
 * So the decision is written down here, PURE, the same way `tui-switch.ts` is:
 * what a stop kills, and when it refuses. The executor next door does what this
 * returns and nothing else, which is what makes "a stop never touches the record"
 * an assertion rather than a promise in a comment.
 */

const live = (...ids: string[]) => (id: string) => ids.includes(id);

describe('planAgentStop', () => {
    it('kills the live terminals it is given', () => {
        const plan = planAgentStop({
            name: 'moic',
            terminals: ['t-claude', 't-codex'],
            live: live('t-claude', 't-codex'),
        });
        expect(plan).toEqual({ kind: 'stop', terminalIds: ['t-claude', 't-codex'] });
    });

    it('leaves a terminal that is already gone out of the kill list', () => {
        // A dormant runtime keeps its `terminal_spec_id` binding, so the id is
        // still there to be handed in. Killing it is a no-op, but REPORTING it
        // as stopped is a claim about the machine that is not true.
        const plan = planAgentStop({
            name: 'moic',
            terminals: ['t-claude', 't-dead'],
            live: live('t-claude'),
        });
        expect(plan).toEqual({ kind: 'stop', terminalIds: ['t-claude'] });
    });

    it('REFUSES when nothing is running, and says so by name', () => {
        const plan = planAgentStop({
            name: 'moic',
            terminals: ['t-dead'],
            live: live(),
        });
        expect(plan).toEqual({ kind: 'refuse', reason: 'moic is not running.' });
    });

    it('refuses an agent that has no terminals at all', () => {
        expect(planAgentStop({ name: 'trader', terminals: [], live: live() })).toEqual({
            kind: 'refuse',
            reason: 'trader is not running.',
        });
    });

    /**
     * The distinction the issue is ABOUT. A plan can only ever name terminals —
     * there is no outcome that removes a row, a file or an inbox — so a Stop
     * wired to this cannot become a Delete however the executor is edited.
     */
    it('has NO outcome that touches the record', () => {
        const plans = [
            planAgentStop({ name: 'moic', terminals: ['t1'], live: live('t1') }),
            planAgentStop({ name: 'moic', terminals: ['t1'], live: live() }),
        ];
        for (const plan of plans) {
            expect(Object.keys(plan).sort()).not.toContain('agentId');
            expect(Object.keys(plan).sort()).not.toContain('removeFiles');
        }
        // POSITIVE CONTROL: the keys really were read, so an empty-object plan
        // could not satisfy the two assertions above.
        expect(Object.keys(plans[0]!).sort()).toEqual(['kind', 'terminalIds']);
        expect(Object.keys(plans[1]!).sort()).toEqual(['kind', 'reason']);
    });
});
