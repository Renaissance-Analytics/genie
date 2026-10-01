import type { ShareInviteState } from './share-invite-state';

/**
 * What the Share workspace modal PUTS ON SCREEN for a given state.
 *
 * Split out from the component for the usual reason — it is the part with rules
 * in it, and the rules are easy to get subtly wrong in a way no type catches. The
 * one that matters: the URL exists for exactly one moment. Tynn serves it on the
 * mint response and never again, so a modal that hides the copy control the
 * instant somebody connects has thrown away the only copy of a link the owner may
 * still want to send to a second person.
 *
 * So `canCopy` is true for BOTH `waiting` and `connected`, and only the heading
 * and the note change. The mint form is offered only when there is nothing to
 * lose by re-minting.
 */
export interface ShareModalView {
    /** The form that creates a link. Hidden once one exists — a second click
     *  would replace the URL on screen with a new one, and the first is
     *  unrecoverable. Re-minting is deliberate, behind "Create another". */
    showMintForm: boolean;
    /** The URL block and its copy button. */
    canCopy: boolean;
    /** The heading over the link block. */
    title: string;
    /** Whether the modal is actively waiting for an arrival (drives the one
     *  place this surface asks the host again — see the component). */
    watching: boolean;
}

export function shareModalView(state: ShareInviteState): ShareModalView {
    switch (state.kind) {
        case 'idle':
            return {
                showMintForm: true,
                canCopy: false,
                title: 'Share this workspace',
                watching: false,
            };
        case 'waiting':
            return {
                showMintForm: false,
                canCopy: true,
                title: 'Link ready',
                // The whole point of the waiting view: something is expected to
                // change on its own, so this is the one state that looks again.
                watching: true,
            };
        case 'connected':
            return {
                showMintForm: false,
                // STILL copyable. The link can admit more than one person and the
                // URL is gone the moment this modal closes.
                canCopy: true,
                title: 'Connected',
                // Somebody arrived. Nothing further is being waited for, so stop
                // asking — a modal left open on a connected session must not keep
                // the host busy for the rest of the day.
                watching: false,
            };
    }
}
