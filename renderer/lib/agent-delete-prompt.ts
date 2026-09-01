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
