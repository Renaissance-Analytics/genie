import type { HostSessionRosterEntry } from './host-session-roster';

/**
 * What the "Share workspace" modal is showing right now.
 *
 * The owner's shape for it: create a link, then a **waiting on connection** view
 * with click-to-copy, which becomes something else once somebody actually
 * arrives. That is three states, and which one you are in is not a UI detail —
 * it is the difference between "your link works" and "you are still waiting",
 * which is the only question the person holding the modal has.
 *
 * Genie can answer it without asking Tynn. The host already knows who is
 * connected and what they reach (the guest roster, genie#681/#690), so the modal
 * reads that rather than polling a service for something the desktop can see.
 *
 * PURE, and separate from the modal, because the interesting part is the
 * matching rule and it is easy to get subtly wrong — see `connectedVia` below.
 */
export type ShareInviteState =
    /** No link yet: the create form. */
    | { kind: 'idle' }
    /** A link exists and nobody has come through it. Show it, offer the copy. */
    | { kind: 'waiting'; url: string }
    /** Somebody is here. The link stays visible — more than one guest may use it. */
    | { kind: 'connected'; url: string; guests: HostSessionRosterEntry[] };

/**
 * Which connected guests are reaching THIS workspace.
 *
 * Deliberately matched on what a guest REACHES rather than on the link they
 * used. Genie is not told which link a session came from, and inventing that
 * mapping would be a guess dressed as a fact — while "is anyone in this
 * workspace" is something the host observes directly and is the thing the
 * person actually wants to know.
 *
 * The honest cost of that choice: a guest who arrived by some OTHER route and
 * reaches this workspace also counts. That is not a false positive for the
 * question being asked on screen ("is anyone here?"), and it is stated in the
 * label rather than implied to be your invitee.
 */
export function connectedVia(
    workspaceName: string,
    roster: readonly HostSessionRosterEntry[],
): HostSessionRosterEntry[] {
    return roster.filter((entry) => {
        const workspaces = entry.access?.workspaces;
        if (!workspaces) return false; // the owner's own device, not a guest
        return workspaces === 'all' || workspaces.includes(workspaceName);
    });
}

/**
 * The modal's state from what it has: the link it minted (if any) and who is
 * connected.
 *
 * A minted link with no URL stays `idle`. The URL exists for exactly one moment
 * — the mint response — and a "waiting" view with nothing to copy is a dead end
 * wearing a progress indicator.
 */
export function shareInviteState(
    link: { url?: string } | null,
    workspaceName: string,
    roster: readonly HostSessionRosterEntry[],
): ShareInviteState {
    if (!link?.url) return { kind: 'idle' };
    const guests = connectedVia(workspaceName, roster);
    return guests.length > 0
        ? { kind: 'connected', url: link.url, guests }
        : { kind: 'waiting', url: link.url };
}

/** What the waiting/connected line says. Kept here so the wording is testable. */
export function shareInviteNote(state: ShareInviteState): string | null {
    switch (state.kind) {
        case 'idle':
            return null;
        case 'waiting':
            return 'Waiting for someone to connect — send them this link.';
        case 'connected': {
            const names = state.guests.map((g) => g.name || 'Someone');
            if (names.length === 1) return `${names[0]} is connected.`;
            if (names.length === 2) return `${names[0]} and ${names[1]} are connected.`;
            return `${names[0]} and ${names.length - 1} others are connected.`;
        }
    }
}
