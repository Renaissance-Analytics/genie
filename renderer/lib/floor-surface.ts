import type { GenieView } from './view-route';

/**
 * Which surface the Floor shows — and, critically, how it stops showing the grid.
 *
 * ## The grid is HIDDEN, never unmounted
 *
 * `hideGrid` exists instead of "render the grid or the Deck" for one reason: every
 * terminal panel owns a live xterm bound to a pty. Unmounting `TerminalGrid` to show
 * another surface would remount every one of them on the way back, which resets the
 * terminal — and this repo has already paid for that once. `TerminalGrid` keeps
 * off-workspace panels mounted-hidden on purpose, with the comment explaining why:
 * a panel that crossed child-slots on a workspace switch "got a different effective
 * key … → XTerm remounted → PTY reset".
 *
 * Opening the Deck is the same hazard wearing a different hat. So the two flags are
 * deliberately SEPARATE — one says what to add, the other says what to conceal — and
 * neither of them ever says what to destroy.
 */
export interface FloorSurface {
    /** Mount the Deck above the grid. */
    showDeck: boolean;
    /** Conceal the grid with CSS. NOT a licence to unmount it. */
    hideGrid: boolean;
    /**
     * The agent whose view to mount above the grid, or null.
     *
     * An id rather than a boolean, because the surface IS the subject: the rail selects an
     * agent and that agent is the view. A separate piece of state holding "which agent"
     * would be a second truth that could disagree with the route.
     */
    showAgent: string | null;
    /**
     * Offer the GRID'S OWN CHROME — the layout picker, Add view, Add terminal, Run a recipe.
     *
     * P7 asks for "the layout control off the default path", and measured it is more than one
     * control: the whole `Toolbar` rendered unconditionally, so the Deck — the default surface —
     * showed a layout picker for a grid that was not on screen, beside Add buttons that act on
     * `activeWorkspaceId` while the Deck is cross-workspace by definition.
     *
     * A third flag rather than `!hideGrid` at the call site: the other two answer "what to add"
     * and "what to conceal", and neither of them means "what to OFFER". It also makes the rule
     * testable, which a negated expression buried in a 5,000-line component is not.
     *
     * It tracks `hideGrid` exactly today, and that equality is asserted rather than assumed — if
     * a future surface needs the grid concealed but its chrome present, this is where that
     * divergence would be stated out loud.
     */
    showGridChrome: boolean;
}

export function floorSurface(view: GenieView): FloorSurface {
    switch (view.kind) {
        case 'grid':
            return { showDeck: false, hideGrid: false, showAgent: null, showGridChrome: true };
        case 'deck':
            return { showDeck: true, hideGrid: true, showAgent: null, showGridChrome: false };
        case 'workbench':
            return { showDeck: false, hideGrid: false, showAgent: null, showGridChrome: true };
        case 'agent':
            // The Agent view EXISTS now, so an agent route resolves to that agent instead
            // of falling back to the grid. The grid is concealed, never unmounted -- the
            // same live-xterm hazard the Deck carries.
            return {
                showDeck: false,
                hideGrid: true,
                showAgent: view.agentId,
                // The Agent view has its own header with the controls that act on an agent. A
                // layout picker for the grid behind it is chrome for somewhere else.
                showGridChrome: false,
            };
    }
}
