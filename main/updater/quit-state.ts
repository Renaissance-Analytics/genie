/**
 * Shared "quitting for update" signal.
 *
 * INTERIM STOPGAP (proper fix tracked as Particle-Academy/fancy-term-host#2 —
 * run the pty-host as an OS service). Genie's Tier-3 detached pty-host is
 * spawned with `process.execPath` + ELECTRON_RUN_AS_NODE so node-pty's native
 * ABI matches; the side-effect is the running host process holds Genie's
 * EXECUTABLE OPEN. On a NORMAL quit that's fine and desired — the host must
 * survive so terminals come back live. But on the AUTO-UPDATE path the NSIS
 * installer has to OVERWRITE that binary, and a surviving host pins it, so the
 * update can't proceed ("tries to close it but can't").
 *
 * This module is the one place that records "this quit is for an update", so
 * the before-quit teardown can branch:
 *   - normal quit  → leave the host running (disconnectHostLeaveRunning)
 *   - update quit  → snapshot host terminals, then KILL the host by its pidfile
 *                    pid (there is no graceful shutdownHost() in the package
 *                    yet) so NSIS can replace the binary.
 *
 * Kept in its own tiny module (no electron / no package imports) so both the
 * updater (auto-updater.ts / ipc.ts) and background.ts can share it without a
 * circular dependency.
 */

let quittingForUpdate = false;

/** Mark the imminent quit as an auto-update apply. MUST be set BEFORE
 *  `autoUpdater.quitAndInstall()` so the before-quit teardown kills the host. */
export function markQuittingForUpdate(): void {
    quittingForUpdate = true;
}

/** True when the current quit was initiated by the updater (apply/restart). */
export function isQuittingForUpdate(): boolean {
    return quittingForUpdate;
}
