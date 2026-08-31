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
 * A RUNNING agent still gets the terminal menu on top of these, because those
 * items (rename, restart, delete the terminal) act on a terminal that exists.
 *
 * PURE — the model is testable without a window, which is where the guards
 * below are worth pinning.
 */

export interface AgentCardMenuItem {
    id: 'start' | 'make-default' | 'clear-default' | 'resolve-collision';
    label: string;
    /** Longer copy for a menu that explains rather than just naming. */
    hint?: string;
    /** Renders as the emphasised item. */
    primary?: boolean;
}

export function agentCardMenuItems(row: AgentGridRow): AgentCardMenuItem[] {
    // An ORPHAN is a terminal no agent owns. There is no record to start or
    // designate, and guessing one would act on the wrong thing.
    if (row.kind !== 'agent') return [];

    // A name conflict means two agents answer to this name and nobody has said
    // which survives. Acting on "the" agent is ambiguous until they do, so the
    // only thing offered is the resolution.
    if (row.collisionGroup) {
        return [
            {
                id: 'resolve-collision',
                label: 'Resolve name conflict…',
                hint: 'Two agents share this name. Pick which one to keep.',
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
    return items;
}
