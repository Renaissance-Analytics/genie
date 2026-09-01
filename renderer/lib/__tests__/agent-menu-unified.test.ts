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

describe('one agent menu, running or not (#324)', () => {
    for (const running of [false, true]) {
        it(`offers start, restart, edit, unmount and delete when running=${running}`, () => {
            const got = ids(agentCardMenuItems(row({ running })));

            for (const required of ['start', 'restart', 'edit', 'unmount', 'delete']) {
                expect(got).toContain(required);
            }
        });

        it(`never offers duplicate or move-to-project when running=${running}`, () => {
            const got = ids(agentCardMenuItems(row({ running })));

            expect(got).not.toContain('duplicate');
            expect(got).not.toContain('move-to-project');
        });
    }

    it('offers the SAME actions running and stopped', () => {
        // The point of the change: the square must not answer differently from
        // one moment to the next.
        const stopped = ids(agentCardMenuItems(row({ running: false }))).sort();
        const live = ids(agentCardMenuItems(row({ running: true }))).sort();

        expect(live).toEqual(stopped);
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
