import type { AgentGridRow } from './ams-grid';

/**
 * The right-click menu for an agent square in the sidebar.
 *
 * Keyed on the AGENT ROW, not on a terminal. The square's menu used to open
 * behind `if (specId)`, so a paused agent — a registered agent with no live
 * runtime, and therefore no spec — silently had no menu at all. That is the
 * terminal-is-the-agent assumption the redesign exists to remove: the actions
 * that matter most while an agent is stopped need no terminal to act on.
 *
 * A RUNNING agent still gets the terminal menu on top of these, because items
 * like rename and restart act on a terminal that exists. Delete does NOT move
 * to that menu, though: an agent is not its terminal (genie#311) — its
 * `.agents/*` files outlive any terminal, so deleting it stays here, on the
 * agent, whether or not one is currently running.
 *
 * PURE — the model is testable without a window, which is where the guards
 * below are worth pinning.
 */

export interface AgentCardMenuItem {
    id:
        | 'start'
        | 'make-default'
        | 'clear-default'
        | 'remove-orphan'
        | 'delete';
    label: string;
    /** Longer copy for a menu that explains rather than just naming. */
    hint?: string;
    /** Renders as the emphasised item. */
    primary?: boolean;
}

export function agentCardMenuItems(row: AgentGridRow): AgentCardMenuItem[] {
    // An ORPHAN is a leftover no agent owns — what is left on screen after the
    // agent it belonged to is gone. It has no record to start or designate, so
    // it gets no agent actions; guessing one would act on the wrong thing.
    //
    // It does NOT get an empty menu. That is what shipped, and it left the
    // owner right-clicking a square that answered with nothing — the exact dead
    // end this codebase is supposed to stop creating. The leftover itself is
    // the thing that wants removing, and this is the only surface that can
    // offer it.
    if (row.kind !== 'agent') {
        return [
            {
                id: 'remove-orphan',
                label: 'Remove leftover',
                hint: 'Nothing owns this any more. Removing it affects no agent.',
                primary: true,
            },
        ];
    }

    // A name conflict means two agents answer to this name and nobody has said
    // which survives. Starting or designating one IS ambiguous until they do, so
    // those stay out.
    //
    // But DELETE belongs here. Deleting one of the two is how a person resolves
    // the conflict, and returning only "Resolve name conflict…" left the owner
    // with a menu whose single item did nothing — the dead end this file's own
    // orphan branch exists to prevent. A colliding agent was the one row that
    // could never be deleted, which is also why the conflict could never be
    // cleared by hand.
    //
    // "Resolve name conflict…" is NOT offered, because nothing implements it:
    // it called `onActivateWorkspace` and simply activated the workspace, so the
    // owner clicked a item promising "pick which one to keep" and got nothing.
    // A menu item that does not do what it says is worse than an absent one —
    // it costs a click and a wrong belief. Deleting one of the two really does
    // settle it, so that is what is offered, and the hint says so.
    if (row.collisionGroup) {
        return [
            {
                id: 'delete',
                label: 'Delete…',
                hint: 'Two agents share this name. Removing one settles it — unmount keeps its files.',
                primary: true,
            },
        ];
    }

    const items: AgentCardMenuItem[] = [];
    if (!row.running) {
        items.push({
            id: 'start',
            label: 'Start agent',
            hint: 'Opens its terminal and resumes where it left off.',
            primary: true,
        });
    }
    items.push(
        row.role === 'workspace'
            ? {
                  id: 'clear-default',
                  label: 'Clear default agent',
                  hint: 'The workspace keeps no default until you set another.',
              }
            : {
                  id: 'make-default',
                  label: 'Make default agent',
                  hint: 'Boots from the workspace root, and takes actions that name no agent.',
              },
    );
    // DELETE — the gap genie#311 exists to close. A real, non-orphan, non-
    // colliding agent always gets it, running or not: even a dormant agent has
    // `.agents/*` files that unmounting keeps and deleting removes. The item
    // itself never destroys anything — it opens the choice between the two, so
    // this menu can offer it without becoming a second dead end for a guess
    // made wrong.
    items.push({
        id: 'delete',
        label: 'Delete…',
        hint: 'Unmount to keep its files, or delete them for good.',
    });
    return items;
}
