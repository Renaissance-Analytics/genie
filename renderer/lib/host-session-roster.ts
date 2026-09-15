import type { BatonParticipant, MobilePeer, PeerAccess } from './genie';

/**
 * Who is connected, as the host's remote-session banner lists them (genie#681):
 * what each guest reaches, whether they may be handed control, and whether they
 * can be disconnected on their own.
 */

export interface HostSessionRosterEntry extends BatonParticipant {
    /** What a guest reaches; null for the owner's own device. */
    access: PeerAccess | null;
    accessLabel: string | null;
    /** The desktop holds control and may hand it to them. */
    canReceiveControl: boolean;
    /** A guest, whose live session can be ended without touching anyone else's. */
    canDisconnect: boolean;
}

export function peerAccessLabel(access: PeerAccess | null): string | null {
    if (!access) return null;
    const capability = access.capability === 'readonly' ? 'Read-only' : 'Control';
    const { workspaces } = access;
    const reach =
        workspaces === 'all'
            ? 'All workspaces'
            : workspaces.length === 0
              ? 'No workspaces'
              : workspaces.length === 1
                ? workspaces[0]
                : `${workspaces[0]} and ${workspaces.length - 1} more`;
    return `${capability} · ${reach}`;
}

export function hostSessionRoster(
    participants: BatonParticipant[],
    peers: MobilePeer[],
    locked: boolean,
): HostSessionRosterEntry[] {
    // The desktop is a participant only while it holds control, and this window is it.
    return participants
        .filter((p) => p.id !== 'desktop')
        .map((p) => {
            const access = peers.find((peer) => peer.id === p.id)?.access ?? null;
            return {
                ...p,
                access,
                accessLabel: peerAccessLabel(access),
                canReceiveControl: locked && !p.holdsControl && !p.readonly,
                canDisconnect: access !== null,
            };
        });
}
