/**
 * Runtime mode — DESKTOP (Electron) vs HEADLESS (genie-cloud).
 * ===========================================================================
 *
 * A single, fail-closed signal the security-sensitive `main/` code uses to
 * decide whether a capability is allowed on the trusted local desktop only.
 *
 * Two capabilities gate on this today:
 *   - System-workspace FULL filesystem access (`files/ipc.ts`) — DESKTOP-ONLY.
 *   - Excluding the synthetic System workspace + confining terminals on the
 *     member-facing headless surface (`mobile/*`) — applied when HEADLESS.
 *
 * Detection: the desktop runs inside the Electron MAIN process, which sets
 * `process.type === 'browser'`. The headless host (genie-cloud) runs under
 * plain Node with `electron` aliased to a stub, so `process.type` is undefined.
 * That distinction is the fail-closed default: anything that is NOT provably the
 * Electron main process is treated as HEADLESS (so full-FS is denied). Boot
 * paths ALSO set the flag explicitly (`markDesktopRuntime` /
 * `markHeadlessRuntime`) so the mode never depends on detection alone.
 */

let override: 'desktop' | 'headless' | null = null;

/**
 * True when running under the Electron main process (the trusted local desktop).
 * Fail-closed: only `process.type === 'browser'` (or an explicit desktop mark)
 * counts as desktop; everything else — including the headless genie-cloud host —
 * is NOT desktop.
 */
export function isDesktop(): boolean {
    if (override) return override === 'desktop';
    // Electron main process → 'browser'. Plain Node (headless) → undefined.
    return (process as NodeJS.Process & { type?: string }).type === 'browser';
}

/** The inverse of {@link isDesktop}. The headless (genie-cloud) host. */
export function isHeadless(): boolean {
    return !isDesktop();
}

/** Mark this process as the desktop shell (Electron main boot). */
export function markDesktopRuntime(): void {
    override = 'desktop';
}

/** Mark this process as the headless host (genie-cloud host-core boot). */
export function markHeadlessRuntime(): void {
    override = 'headless';
}

/** Test-only: clear any explicit mark so detection applies again. */
export function _resetRuntimeModeForTest(): void {
    override = null;
}
