/**
 * SELF-HEALING the terminal backend (genie#774).
 *
 * The owner's rule, after a day without terminals: *"the upgrade should bring
 * that back up. we should never have to manually fix issues, genie should handle
 * that."*
 *
 * Two fixes landed either side of this one and neither covers the state the
 * machine was actually IN:
 *
 *  - adopting an already-serving host stops the collision that kills the fleet;
 *  - retrying the respawn stops a transient `EADDRINUSE` degrading permanently.
 *
 * Both act at the MOMENT of a loss. Neither helps a Genie already sitting on the
 * in-process backend with no host — which is where this machine sat for hours,
 * killing every agent on every restart, until a human noticed. **Nothing
 * announces that state**, so nothing was ever going to react to it. A degraded
 * backend is silent by construction: terminals still open, they simply stop
 * surviving a restart.
 *
 * This is the DECISION half, kept pure and separate from the wiring because
 * every rule in it is a way of not making things worse — and "worse" here is
 * specific: respawning a host underneath a working one is the original incident.
 */

/**
 * How long to wait before trying to heal again.
 *
 * A heal that fails must not become a spawn loop: on a machine that genuinely
 * cannot host terminals, this is the difference between a quiet fallback and a
 * process storm. It is also the ceiling on how long someone waits after the
 * backend drops, so it cannot be minutes.
 */
export const HOST_HEAL_MIN_INTERVAL_MS = 30_000;

export interface HostHealInput {
    /** Whether a detached/service host is wanted at all. OFF means in-process is
     *  the CHOSEN state, not a degradation. */
    detachedEnabled: boolean;
    /** Whether a host is currently backing terminals. */
    hostBacked: boolean;
    /** Whether a selection/heal is already running. */
    inFlight: boolean;
    /** When the last heal was attempted, or null if never. */
    lastAttemptAt: number | null;
    now: number;
}

export interface HostHealDecision {
    heal: boolean;
    /** Why not, when it refused. This runs unattended, so a refusal that says
     *  nothing leaves "why are my terminals still dead" unanswerable by the one
     *  component whose job was to fix it. */
    reason?: string;
}

export function shouldAttemptHostHeal(input: HostHealInput): HostHealDecision {
    if (!input.detachedEnabled) {
        return { heal: false, reason: 'detached terminals are turned off — in-process is the chosen backend' };
    }
    if (input.hostBacked) {
        return { heal: false, reason: 'a host is already backing terminals — healthy' };
    }
    if (input.inFlight) {
        return { heal: false, reason: 'a backend selection is already in flight' };
    }
    if (
        input.lastAttemptAt !== null &&
        input.now - input.lastAttemptAt < HOST_HEAL_MIN_INTERVAL_MS
    ) {
        return { heal: false, reason: 'a heal was attempted too recently' };
    }
    return { heal: true };
}
