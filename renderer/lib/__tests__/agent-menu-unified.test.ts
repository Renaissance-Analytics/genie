import { describe, expect, it } from 'vitest';
import { agentCardMenuItems } from '../agent-card-menu';
import type { AgentGridRow } from '../ams-grid';

/**
 * ONE menu for an agent, whether it is running or not.
 *
 * An agent got two entirely different menus depending on whether its terminal
 * was alive. Running, it fell through to the TERMINAL menu — Remove from view,
 * Open in new window, Rename, **Duplicate**, Agent settings, Restart, **Move to
 * project**, Delete. Stopped, it got a four-item agent menu with none of those.
 * So the same square answered differently from one moment to the next, and two
 * of the terminal items describe things this product does not do at all:
 *
 *   - **Duplicate** — agents are not duplicated.
 *   - **Move to project** — agents are not moved between projects, and
 *     terminals are not detached from them.
 *
 * The owner's requirement: Start, Restart, Edit, Unmount and Delete are ALWAYS
 * available on an agent. Unmount and Delete both stop the agent AND its
 * sidecars; the difference is only whether `.agents/*` survives.
 *
 * RESTART became two items (genie#443) — `restart` resumes the conversation,
 * `restart-fresh` relaunches from scratch — because one of them cannot be
 * offered to a provider with no resume grammar and the other always can. So this
 * asks for A RESTART rather than for the literal id: what #324 requires is that
 * the square always gives you one, not which of the two it is.
 *
 * STOP joined them for a RUNNING agent (genie#474). Until it existed, the square
 * could say an agent was running and offer nothing in the other direction but
 * Unmount and Delete, both of which remove it. Like the restarts, it is gated on
 * having something to act on — see the "same actions" test for why that is not
 * the shape-shifting #324 forbids.
 */

const row = (over: Partial<AgentGridRow> = {}): AgentGridRow =>
    ({
        kind: 'agent',
        id: 'a1',
        name: 'tynn',
        running: false,
        collisionGroup: null,
        isDefault: false,
        specId: 's1',
        ...over,
    }) as AgentGridRow;

const ids = (items: { id: string }[]) => items.map((i) => i.id);
const hasRestart = (got: string[]) => got.includes('restart') || got.includes('restart-fresh');

describe('one agent menu, running or not (#324)', () => {
    for (const running of [false, true]) {
        it(`offers start, restart, edit, unmount and delete when running=${running}`, () => {
            const got = ids(agentCardMenuItems(row({ running })));

            for (const required of ['start', 'edit', 'unmount', 'delete']) {
                expect(got).toContain(required);
            }
            expect(hasRestart(got), got.join(',')).toBe(true);
        });

        it(`never offers duplicate or move-to-project when running=${running}`, () => {
            const got = ids(agentCardMenuItems(row({ running })));

            expect(got).not.toContain('duplicate');
            expect(got).not.toContain('move-to-project');
        });
    }

    /**
     * The point of #324: the square must not answer differently from one moment
     * to the next. What that forbids is the menu changing SHAPE — the terminal
     * menu with Duplicate and Move to project appearing in place of the agent
     * menu — not an item whose subject only exists in one of the two states.
     * The restarts were already such an item (they need a terminal), and
     * genie#474's Stop is another: it needs a RUN to end, and a Stop over a
     * dormant agent is the control-that-acts-on-nothing this model rejects
     * everywhere else.
     *
     * So the assertion is stated as what it defends: the always-present set is
     * identical, and the ONLY difference is the run-dependent verb.
     */
    it('offers the SAME actions running and stopped, bar the one that needs a run', () => {
        const stopped = ids(agentCardMenuItems(row({ running: false }))).sort();
        const live = ids(agentCardMenuItems(row({ running: true }))).sort();

        expect(live.filter((id) => id !== 'stop')).toEqual(stopped);
        // And the difference is exactly that one item, in exactly one direction.
        expect(live).toContain('stop');
        expect(stopped).not.toContain('stop');
    });

    it('still offers delete during a name collision', () => {
        // POSITIVE CONTROL: the collision branch must not regress to a menu
        // whose one item did nothing.
        expect(ids(agentCardMenuItems(row({ collisionGroup: 'g1' })))).toContain('delete');
    });
});

describe('a leftover is not an agent', () => {
    it('offers only its own removal', () => {
        const got = ids(agentCardMenuItems(row({ kind: 'orphan' })));

        expect(got).toEqual(['remove-orphan']);
    });

    it('asks TWICE when a TUI is still running in it', () => {
        // The owner's rule: a disconnected terminal cannot be asked for a
        // handoff, so its work cannot be preserved. Removing it while something
        // is still alive in there must not be a single click.
        const live = agentCardMenuItems(row({ kind: 'orphan', running: true }));

        expect(live[0]!.confirmTwice).toBe(true);
    });

    it('asks once when nothing is running in it', () => {
        // POSITIVE CONTROL: a genuinely dead leftover stays a single click, or
        // the double-confirm becomes noise everybody learns to click through.
        const dead = agentCardMenuItems(row({ kind: 'orphan', running: false }));

        expect(dead[0]!.confirmTwice).toBeFalsy();
    });
});
