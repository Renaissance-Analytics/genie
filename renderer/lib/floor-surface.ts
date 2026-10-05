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
}

export function floorSurface(view: GenieView): FloorSurface {
    switch (view.kind) {
        case 'grid':
            return { showDeck: false, hideGrid: false };
        case 'deck':
            return { showDeck: true, hideGrid: true };
        case 'workbench':
            return { showDeck: false, hideGrid: false };
        case 'agent':
            // The Agent view is a later phase. Until it exists an agent route falls
            // back to the grid rather than to a blank surface — a link that resolves
            // to nothing is worse than one that resolves to the old thing.
            return { showDeck: false, hideGrid: false };
    }
}
