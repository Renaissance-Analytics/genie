/**
 * The copy behind the agent DELETE confirm dialog (genie#311).
 *
 * "Delete" on the agent context menu is not one destructive action — it hides
 * two very different outcomes, and the issue is explicit that guessing wrong
 * between them is not recoverable: UNMOUNT keeps every `.agents/*` file so the
 * agent can be re-added later with its persona, purpose and instructions
 * intact; DELETE removes them too. So the choice — and what each one plainly
 * says it keeps and removes — lives here as data, not inline JSX, the same
 * split `agent-card-menu.ts` uses for the menu itself: a PURE model the
 * component only renders.
 */

export type AgentDeleteMode = 'unmount' | 'delete';

export interface AgentDeleteChoice {
    mode: AgentDeleteMode;
    label: string;
    /** States PLAINLY which files are kept and which are removed. */
    body: string;
}

export const AGENT_DELETE_CHOICES: readonly AgentDeleteChoice[] = [
    {
        mode: 'unmount',
        label: 'Unmount from Genie',
        body:
            'Shuts down every TUI for this agent and kills its terminal. Every ' +
            'file under .agents/ is KEPT, so re-adding this agent later restores ' +
            'its persona, purpose and instructions untouched.',
    },
    {
        mode: 'delete',
        label: 'Delete for real',
        body:
            'Everything Unmount does, plus its .agents/ files are REMOVED from ' +
            'disk. There is no undo — re-adding this agent afterward starts from ' +
            'nothing.',
    },
];

/**
 * The CONFIRM BUTTON's label — deliberately shorter than the radio option's
 * own label above it, and deliberately not a bare "Confirm": naming the real
 * action on the button a person is about to click is the whole point of
 * splitting delete into a choice in the first place.
 */
export function agentDeleteConfirmLabel(mode: AgentDeleteMode): string {
    return mode === 'delete' ? 'Delete for real' : 'Unmount';
}

/** Whether stopping this agent can take a handoff first, and what to say. */
export interface HandoffOffer {
    available: boolean;
    label: string;
    hint: string;
}

/**
 * The offer to take a handoff before stopping.
 *
 * Unmount and Delete both stop the agent AND its sidecars, and that is the LAST
 * moment the agent is still there to be asked what it was in the middle of.
 * Once its terminal is gone, whatever it had in flight is unrecoverable — and
 * this is the one point in the UI where a person is about to cause that.
 *
 * Only offered while the agent is RUNNING. A dormant agent has no live
 * conversation to summarise, so a checkbox there would promise something
 * nothing can deliver — the exact failure mode this codebase keeps fixing.
 */
export function handoffOfferFor(input: {
    running: boolean;
    mode: AgentDeleteMode;
}): HandoffOffer {
    if (!input.running) {
        return {
            available: false,
            label: 'Ask for a handoff first',
            // Says why it is unavailable rather than sitting greyed and mute.
            hint: 'This agent is not running, so there is nothing to ask.',
        };
    }
    return {
        available: true,
        label: 'Ask for a handoff first',
        hint:
            input.mode === 'delete'
                ? 'It writes what it was doing to .ai/handoff/ before stopping. That note survives even though its .agents/ files do not. Without one, whatever it had in flight is lost.'
                : 'It writes what it was doing to .ai/handoff/ before stopping, so the next run picks up where it left off. Without one, whatever it had in flight is lost.',
    };
}

/**
 * What the confirm button says while the stop is in flight.
 *
 * Waiting on a handoff is bounded at 45 seconds. A generic "Working…" for that
 * long reads as a dialog that has hung, and the person cancels a stop that was
 * doing exactly what they ticked — so when a note was asked for, the button
 * says WHO it is waiting on.
 */
export function agentDeleteBusyLabel(input: { agentName: string; handoff: boolean }): string {
    return input.handoff ? `Waiting for ${input.agentName}…` : 'Working…';
}
