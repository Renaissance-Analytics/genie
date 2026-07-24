/** The provision status the "Tynn agent" panel resolves from (genie #52). */
export type TynnProvisionStatus = 'unlinked' | 'signed-out' | 'already' | 'provision' | null;

/**
 * genie #52 — should the panel AUTO-provision this workspace the moment it opens
 * (zero-click), mirroring the desktop's "auto-provision on open"?
 *
 * Only when the status is exactly `'provision'` — linked + signed-in (on a headless
 * host, via the workstation identity) + not yet configured — i.e. the workspace is
 * ready to connect and just hasn't been. NEVER on:
 *   - `'already'`    — already configured (nothing to do)
 *   - `'unlinked'`   — no Tynn project to provision (the picker handles it)
 *   - `'signed-out'` — can't mint (desktop: sign in; host never hits this)
 *   - `null`         — status unknown
 *
 * Guarded to fire AT MOST ONCE per workspace path, so a failed mint (which leaves
 * the status at `'provision'`) can't spin the panel into a re-provision loop; the
 * user's explicit Re-provision button remains the manual retry.
 */
export function shouldAutoProvisionOnOpen(input: {
    status: TynnProvisionStatus;
    /** The workspace path auto-provision was last attempted for (a ref), or null. */
    attemptedFor: string | null;
    /** The workspace path being resolved now. */
    workspacePath: string;
}): boolean {
    return input.status === 'provision' && input.attemptedFor !== input.workspacePath;
}
