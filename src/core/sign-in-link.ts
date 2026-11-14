/**
 * A SIGN-IN LINK CROSSES TO THE PILOT (Tynn #731). The drone sends it as an event on ONE admitted connection; the Pilot's
 * Genie opens it in its own browser. Only an https page ever crosses or opens: never `file:`, `http:`, `javascript:`.
 */
export const SIGN_IN_OPEN_EVENT = 'sign-in.open';

/** The URL, when it is an https page; otherwise `null`. */
export function signInUrl(url: unknown): string | null {
    if (typeof url !== 'string') return null;
    try { return new URL(url).protocol === 'https:' ? url : null; } catch { return null; }
}
