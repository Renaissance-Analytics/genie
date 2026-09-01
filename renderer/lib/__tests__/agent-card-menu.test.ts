import { describe, expect, it } from 'vitest';
import { agentCardMenuItems } from '../agent-card-menu';
import type { AgentGridRow } from '../ams-grid';

/**
 * A PAUSED agent has a right-click menu.
 *
 * The sidebar's agent squares opened their menu behind `if (specId)`, and a
 * paused agent has no terminal spec — it is a registered agent whose runtime
 * is not live. So right-clicking one did nothing at all, silently: the owner's
 * report was "why the hell do I not have a menu for paused agents?"
 *
 * The cause is the menu being keyed on the TERMINAL rather than on the agent.
 * That is the same mistake the whole agent redesign exists to undo — an agent
 * is not its terminal, and the actions that matter most when it is NOT running
 * (start it, make it the workspace default) need no terminal at all.
 *
 * So this model is built from the agent ROW. A running agent keeps the
 * terminal menu, because its items — rename the terminal, restart, delete the
 * terminal — genuinely act on a terminal that exists.
 */

const row = (over: Partial<AgentGridRow> = {}): AgentGridRow =>
    ({
        kind: 'agent',
        id: 'a1',
        name: 'ripple-builder',
        purpose: 'builds',
        avatar: null,
        role: 'specialized',
        provider: null,
        tuis: [],
        running: false,
        collisionGroup: null,
        ...over,
    }) as AgentGridRow;

const ids = (items: ReturnType<typeof agentCardMenuItems>) => items.map((i) => i.id);

describe('agentCardMenuItems', () => {
    it('offers to START a paused agent — the whole point of the menu', () => {
        expect(ids(agentCardMenuItems(row()))).toContain('start');
    });

    it('offers to make it the workspace default', () => {
        // A property OF an agent, and settable without the agent running.
        const items = agentCardMenuItems(row());
        expect(ids(items)).toContain('make-default');
        expect(ids(items)).not.toContain('clear-default');
    });

    it('offers to CLEAR the designation on the agent that holds it', () => {
        const items = agentCardMenuItems(row({ role: 'workspace' }));
        expect(ids(items)).toContain('clear-default');
        expect(ids(items)).not.toContain('make-default');
    });

    it('does not offer to start an agent that is already running', () => {
        // POSITIVE CONTROL on the guard: a menu that always offered Start would
        // give a second way to spawn past a live agent, which is the orphan bug
        // this whole area exists to fix.
        const items = agentCardMenuItems(row({ running: true, provider: 'claude' }));
        expect(ids(items)).not.toContain('start');
        // …but it is still an agent, so the agent-level items remain.
        expect(ids(items)).toContain('make-default');
    });

    it('offers to DELETE the agent — the whole reason genie#311 exists', () => {
        // The header comment above used to justify the gap: "items (rename,
        // restart, delete the terminal) act on a terminal that exists." Since
        // AMS split an agent from its terminal, deleting the AGENT had no path
        // in the UI — only an orphan (a leftover nothing owns) could be
        // removed. This is the fix: a real, non-orphan agent gets a delete
        // item too.
        const items = agentCardMenuItems(row());
        expect(ids(items)).toContain('delete');
    });

    it('offers delete on a RUNNING agent too — it still has files to remove', () => {
        const items = agentCardMenuItems(row({ running: true, provider: 'claude' }));
        expect(ids(items)).toContain('delete');
    });

    it('does not offer delete for an ORPHAN — remove-orphan already covers it', () => {
        // An orphan has no agent record and no `.agents/*` files of its own to
        // decide between unmounting and deleting — remove-orphan is already the
        // whole answer for it.
        const items = agentCardMenuItems(row({ kind: 'orphan' }));
        expect(ids(items)).not.toContain('delete');
    });

    it('does not offer delete during an unresolved name collision', () => {
        // Acting on "the" agent is ambiguous until the collision is resolved —
        // same reasoning as every other agent-level action being withheld here.
        const items = agentCardMenuItems(row({ collisionGroup: 'g1' }));
        expect(ids(items)).not.toContain('delete');
    });

    it('gives an ORPHAN a way to CLEAR ITSELF, never an empty menu', () => {
        // I shipped this returning [] — so a leftover square had no menu at all,
        // which is the dead end the owner had just told me to stop creating.
        // The reasoning was that an orphan has no agent record to act on. True,
        // and beside the point: the leftover itself is the thing that needs
        // removing, and it is the only thing on screen that can offer it.
        const items = agentCardMenuItems(row({ kind: 'orphan' }));
        expect(ids(items)).toContain('remove-orphan');
        // Still no AGENT actions — there is no record to start or designate,
        // and offering those would act on a guess.
        expect(ids(items)).not.toContain('start');
        expect(ids(items)).not.toContain('make-default');
    });

    it('never returns an empty menu for anything that renders', () => {
        // THE rule, as a test: a square you can right-click must give you
        // something. Every kind that reaches the grid is covered here, so a new
        // one added later fails this rather than shipping a dead end.
        for (const kind of ['agent', 'orphan'] as const) {
            for (const running of [true, false]) {
                for (const collisionGroup of [null, 'g1']) {
                    const items = agentCardMenuItems(row({ kind, running, collisionGroup }));
                    expect(items.length).toBeGreaterThan(0);
                }
            }
        }
    });

    it('marks a name conflict as needing the human, and offers nothing else', () => {
        // Until someone picks which of two same-named agents survives, acting
        // on "the" agent is ambiguous by construction.
        const items = agentCardMenuItems(row({ collisionGroup: 'g1' }));
        expect(ids(items)).toEqual(['resolve-collision']);
    });

    it('every item carries a label a human can read', () => {
        for (const r of [row(), row({ running: true }), row({ role: 'workspace' })]) {
            for (const item of agentCardMenuItems(r)) {
                expect(item.label.trim().length).toBeGreaterThan(0);
            }
        }
    });
});
