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
}

/**
 * Forward the host's alerts/prompts to a remote driver ONLY when a driver is
 * connected AND has CONTROL:
 *   - no driver connected  → host stays purely local (nothing to forward),
 *   - readonly driver      → don't raise an actionable control prompt it can't
 *                            fulfil (it can only watch),
 *   - control driver       → forward (the driving member gets the modal / chime).
 *
 * The host ALSO keeps the prompt locally (first-answer-wins), so forwarding
 * never cuts the host owner out. Pure → unit-testable.
 */
export function shouldForwardToDriver(driver: DriverState | null | undefined): boolean {
    return !!driver && driver.connected && driver.capability === 'control';
}
