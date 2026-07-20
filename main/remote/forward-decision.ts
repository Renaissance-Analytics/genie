/**
 * Pure routing decision for forwarding a host's alerts/prompts (imDone
 * chime/toast, ForceTheQuestion modal) to a connected remote DRIVER. Kept
 * electron-free so it unit-tests without a harness.
 */

/** A connected remote driver's role for the host it drives. */
export type DriverCapability = 'control' | 'readonly';

export interface DriverState {
    /** Is a driver currently connected over the bridge? */
    connected: boolean;
    /** Whether that driver can ACT (control) or only watch (readonly). */
    capability: DriverCapability;
    /**
     * The host's kill-switch is engaged, making this driver view-only regardless
     * of capability. Optional (defaults to unlocked) so a caller with no notion
     * of the lock keeps the prior behaviour.
     */
    controlLocked?: boolean;
}

/**
 * Forward the host's alerts/prompts to a remote driver ONLY when a driver is
 * connected AND can actually act on them:
 *   - no driver connected  → host stays purely local (nothing to forward),
 *   - readonly driver      → don't raise an actionable control prompt it can't
 *                            fulfil (it can only watch),
 *   - kill-switch engaged  → same situation by a different route: the host
 *                            refuses every state-changing call (423), so an
 *                            answer the driver submits can never land,
 *   - control driver       → forward (the driving member gets the modal / chime).
 *
 * The kill-switch case is why a remote ForceTheQuestion answer could vanish: the
 * questions READ is unguarded while the answer POST is guarded, so a locked host
 * happily handed out prompts it would then refuse — the driver answered into a
 * void and the host's agent stayed blocked. Refusing to forward keeps the prompt
 * where it can be answered, on the host.
 *
 * The host ALSO keeps the prompt locally (first-answer-wins), so forwarding
 * never cuts the host owner out. Pure → unit-testable.
 */
export function shouldForwardToDriver(driver: DriverState | null | undefined): boolean {
    if (!driver || !driver.connected) return false;
    if (driver.controlLocked) return false;
    return driver.capability === 'control';
}
