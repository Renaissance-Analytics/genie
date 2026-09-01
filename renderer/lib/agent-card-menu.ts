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
 * ONE menu, running or not. A running agent used to fall through to the
 * TERMINAL menu instead — Remove from view, Open in new window, Rename,
 * Duplicate, Agent settings, Restart, Move to project, Delete — while a stopped
 * one got a four-item agent menu with none of those. The same square answered
 * differently from one moment to the next, and two of those items describe
 * things this product does not do: agents are not DUPLICATED, and agents are
 * not MOVED between projects (nor are terminals detached from them).
 *
 * Start, Restart, Edit, Unmount and Delete are always present. Unmount and
 * Delete both stop the agent AND its sidecars; the only difference is whether
 * `.agents/*` survives. Both offer to take a handoff first, because stopping an
 * agent is the moment its unfinished context is lost.
 *
 * PURE — the model is testable without a window, which is where the guards
 * below are worth pinning.
 */

export interface AgentCardMenuItem {
    id:
        | 'start'
        | 'restart'
        | 'edit'
        | 'unmount'
        | 'make-default'
        | 'clear-default'
        | 'remove-orphan'
        | 'delete';
    label: string;
    /** Longer copy for a menu that explains rather than just naming. */
    hint?: string;
    /** Renders as the emphasised item. */
    primary?: boolean;
    /** Destructive styling. */
    danger?: boolean;
    /**
     * Ask twice before doing it. Set for removing a leftover that still has a
     * live TUI: a disconnected terminal cannot be asked for a handoff, so its
     * work cannot be preserved, and that must not be one click.
     */
    confirmTwice?: boolean;
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
        // A leftover with a LIVE TUI is asked about twice. Nothing owns it, so
        // there is no agent to ask for a handoff — whatever that TUI was in the
        // middle of cannot be preserved, and a disconnected terminal cannot be
        // asked either. A dead leftover stays one click, or the second prompt
        // becomes noise everyone learns to click through.
        return [
            {
                id: 'remove-orphan',
                label: 'Remove leftover',
                hint: row.running
                    ? 'Something is STILL RUNNING in here. Nothing owns it, so no handoff can be taken — whatever it was doing is lost.'
                    : 'Nothing owns this any more. Removing it affects no agent.',
                primary: true,
                danger: true,
                confirmTwice: !!row.running,
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

    // The SAME five, running or not. Which one a person wants depends on what
    // they are about to do, not on whether a pty happens to be alive — and a
    // menu that changes shape underneath them is the thing this replaces.
    const items: AgentCardMenuItem[] = [
        {
            id: 'start',
            label: row.running ? 'Focus agent' : 'Start agent',
            hint: row.running
                ? 'Brings its terminal forward.'
                : 'Opens its terminal and resumes where it left off.',
            primary: !row.running,
        },
        {
            id: 'restart',
            label: 'Restart agent',
            hint: 'Relaunches its TUI and resumes the same conversation.',
        },
        {
            id: 'edit',
            label: 'Edit agent…',
            hint: 'Its name, purpose, TUI and persona.',
        },
    ];
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
    // UNMOUNT and DELETE are separate items, not one that asks which you meant.
    // They are different intentions and the menu should say so. Both stop the
    // agent AND its sidecars; the only difference is whether `.agents/*`
    // survives. Both offer to take a handoff first — stopping an agent is the
    // moment its unfinished context is lost, and it is the only moment the
    // agent is still there to be asked.
    items.push(
        {
            id: 'unmount',
            label: 'Unmount…',
            hint: 'Stops this agent and its sidecars. Keeps every file under .agents/.',
            danger: true,
        },
        {
            id: 'delete',
            label: 'Delete…',
            hint: 'Stops this agent and its sidecars, and removes its .agents/ files. No undo.',
            danger: true,
        },
    );
    return items;
}
