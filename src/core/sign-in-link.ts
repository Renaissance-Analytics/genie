/**
 * A SIGN-IN LINK CROSSES TO THE PILOT (Tynn #731). The drone sends it as an event on ONE admitted connection; the Pilot's
 * Genie opens it in its own browser. Only an https page ever crosses or opens: never `file:`, `http:`, `javascript:`.
 */
export const SIGN_IN_OPEN_EVENT = 'sign-in.open';

/** How long after the Pilot starts a sign-in the drone's link may still open (device codes last about this long). */
export const SIGN_IN_LINK_TTL_MS = 5 * 60_000;

/** The actions a Pilot starts that may bring a sign-in link back; no other request can carry one. */
export function isSignInAction(action: unknown): boolean {
    const kind = (action as { kind?: unknown } | null)?.kind;
    return kind === 'integrations.githubSignIn' || kind === 'integrations.tynnSignIn' || kind === 'integrations.githubOpen'
        || kind === 'tailscale.up' || kind === 'tailscale.install';
}

/** The URL, when it is an https page; otherwise `null`. */
export function signInUrl(url: unknown): string | null {
    if (typeof url !== 'string') return null;
    try { return new URL(url).protocol === 'https:' ? url : null; } catch { return null; }
}
