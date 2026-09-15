/**
 * What Settings says about reaching this computer over Tynn (genie#451, genie#680).
 *
 * The note reports the relay host's own status from `mobile:status` / `mobile:relay`,
 * so it can only say "reachable" while the link is up, and says why when it is not.
 */

/** Mirrors `RelayHostPublicStatus` in `main/tynn/relay-host-controller.ts`. */
export type RelayHostStatus =
    | { state: 'off' }
    | { state: 'connecting' }
    | { state: 'connected'; relay: string }
    | { state: 'unavailable'; reason: string; message: string };

export interface RelayStatusNote {
    text: string;
    tone: 'ok' | 'neutral' | 'bad';
}

export function relayStatusNote(relay: RelayHostStatus | undefined, tynnAllowed: boolean): RelayStatusNote | null {
    if (!tynnAllowed || !relay) return null;
    switch (relay.state) {
        case 'connected':
            return { text: 'Tynn: reachable through the relay', tone: 'ok' };
        case 'connecting':
            return { text: 'Tynn: connecting to the relay…', tone: 'neutral' };
        case 'off':
            return { text: 'Tynn: off while Genie Remote is off', tone: 'neutral' };
        case 'unavailable':
            return { text: `Tynn: not reachable. ${relay.message}`, tone: 'bad' };
    }
}
